import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import {
  ADVISORY_PROBLEMS, BLOCKING_PROBLEMS, hasBlockingFindings, parseCheckpoint, planIdentityMigration, planReport, userRef,
  type AccountRow, type IdentityPlanReport, type Problem, type UserRow,
} from '../src/db/identityMigrationPlan.js';
import { identityPlanArguments, runReadOnlyIdentityPlan } from '../src/db/identityMigrationPlanRunner.js';
import { assertSanitized } from '../src/db/queryDiagnostics.js';

// Synthetic, in-memory rows shaped like the real writers' output (src/routes/auth.ts). No database.
const T = new Date('2030-01-01T00:00:00.000Z');
let n = 0;
const subject = () => String(100000000000000000000n + BigInt(++n));
const user = (extra: Partial<UserRow> = {}): UserRow => ({ _id: randomUUID(), email: `person${++n}@example.test`, displayName: null,
  createdAt: T, updatedAt: T, ...extra });
const account = (userId: unknown, extra: Partial<AccountRow> = {}): AccountRow => ({ _id: randomUUID(), userId,
  googleAccountId: subject(), driveRootFolderId: `folder${++n}`, createdAt: T, ...extra });

/** One user per classification, plus orphans. Returns the rows and the expected per-user problems. */
function fixture() {
  const users: UserRow[] = [], accounts: AccountRow[] = [], expected = new Map<string, Problem[]>();
  const add = (problems: Problem[], u: UserRow, ...rows: AccountRow[]) => {
    users.push(u); accounts.push(...rows); expected.set(userRef(u._id), problems);
    return u;
  };
  const ready = user({ displayName: 'Person' }); add([], ready, account(ready._id));
  add(['no_google_account'], user());
  const multi = user(); add(['multiple_google_accounts'], multi, account(multi._id), account(multi._id));
  const badSubject = user(); add(['subject_invalid'], badSubject, account(badSubject._id, { googleAccountId: 'has space' }));
  const emailSubject = user(); add(['subject_email_shaped'], emailSubject, account(emailSubject._id, { googleAccountId: 'who@example.test' }));
  const dupA = user(), dupB = user(), shared = subject();
  add(['subject_duplicate'], dupA, account(dupA._id, { googleAccountId: shared }));
  add(['subject_duplicate'], dupB, account(dupB._id, { googleAccountId: shared }));
  const pending = user(); add(['folder_missing'], pending, account(pending._id, { driveRootFolderId: null }));
  const badFolder = user(); add(['folder_invalid'], badFolder, account(badFolder._id, { driveRootFolderId: '../escape' }));
  const sharedA = user(), sharedB = user();
  add(['folder_shared'], sharedA, account(sharedA._id, { driveRootFolderId: 'sharedFolder' }));
  add(['folder_shared'], sharedB, account(sharedB._id, { driveRootFolderId: 'sharedFolder' }));
  const legacyId = user({ _id: 'legacy-user-0001' });
  add(['user_id_not_uuid', 'legacy_reader_rejects_user'], legacyId, account('legacy-user-0001'));
  const noEmail = user({ email: undefined }); add(['email_missing', 'legacy_reader_rejects_user'], noEmail, account(noEmail._id));
  const emptyEmail = user({ email: ' ' }); add(['email_missing', 'legacy_reader_rejects_user'], emptyEmail, account(emptyEmail._id));
  const badEmail = user({ email: 'not-an-email' }); add(['email_malformed', 'legacy_reader_rejects_user'], badEmail, account(badEmail._id));
  const lower = user({ email: 'twin@example.test' }), upper = user({ email: 'Twin@Example.test' });
  add(['email_duplicate'], lower, account(lower._id));
  add(['email_not_normalized', 'email_duplicate'], upper, account(upper._id));
  const noDates = user({ createdAt: undefined }); add(['legacy_reader_rejects_user'], noDates, account(noDates._id));
  accounts.push(account(randomUUID()), account(randomUUID()), account(42)); // orphans: 2 missing user, 1 invalid user id
  return { users, accounts, expected };
}

const shuffle = <T>(rows: readonly T[], seed: number) => {
  const copy = [...rows];
  for (let i = copy.length - 1; i > 0; i--) { seed = (seed * 1103515245 + 12345) % 2147483648; const j = seed % (i + 1); [copy[i], copy[j]] = [copy[j], copy[i]]; }
  return copy;
};
const report = (users: readonly UserRow[], accounts: readonly AccountRow[], options: { limit?: number; resume?: string } = {}) =>
  planReport(planIdentityMigration(users, accounts, options), { resumed: options.resume !== undefined });

test('each classification is reported exactly, with identity by subject and never by email', () => {
  const { users, accounts, expected } = fixture();
  const plan = planIdentityMigration(users, accounts);
  assert.equal(plan.entries.length, users.length);
  for (const entry of plan.entries) {
    assert.deepEqual(entry.problems, expected.get(entry.userRef), entry.userRef);
    const blocking = entry.problems.some(problem => (BLOCKING_PROBLEMS as readonly string[]).includes(problem));
    assert.equal(entry.disposition, blocking ? 'blocked' : 'ready');
  }
  const r = planReport(plan, { resumed: false });
  const count = (problem: Problem) => [...expected.values()].filter(list => list.includes(problem)).length;
  for (const problem of [...BLOCKING_PROBLEMS, ...ADVISORY_PROBLEMS]) assert.equal(r.problems[problem], count(problem), problem);
  assert.deepEqual(r.population, { users: users.length, googleAccounts: accounts.length, orphanGoogleAccounts: { missingUser: 2, invalidUserId: 1 } });
  assert.deepEqual(r.collisions, { emailGroups: 1, emailUsers: 2, subjectGroups: 1, subjectAccounts: 2, folderGroups: 1, folderUsers: 2 });
  assert.deepEqual(r.dispositions, { ready: 7, blocked: 11 });
  // Identities: ready(1) + multi(2) + pending(1) + badFolder(1) + sharedA/B(2) + 6 advisory-only users.
  // Libraries: only the 7 ready users; every blocked user keeps its library unmapped.
  assert.deepEqual(r.planned, { identities: 13, libraries: 7 });
  assert.equal(r.applied, false);
  assert.equal(r.window.complete, true);
  assert.equal(r.checkpoint, null);
  assert.ok(hasBlockingFindings(r));

  // Advisory email problems do not stop the subject-keyed identity and library mapping.
  const twin = plan.entries.find(entry => entry.problems.includes('email_not_normalized'))!;
  assert.equal(twin.disposition, 'ready');
  assert.equal(twin.identities.length, 1);
  assert.ok(twin.library);
  assert.ok(!JSON.stringify(twin.identities).includes('example.test'), 'records carry no email');
  // A pending Drive setup still maps its identity; only the library waits.
  const pending = plan.entries.find(entry => entry.problems.includes('folder_missing'))!;
  assert.deepEqual([pending.identities.length, pending.library], [1, null]);
  // Records keep the stored UUID and subject byte for byte.
  const first = plan.entries.find(entry => entry.library)!;
  const source = users.find(u => userRef(u._id) === first.userRef)!;
  const stored = accounts.find(a => a.userId === source._id)!;
  assert.deepEqual([first.library!.accountId, first.library!.owner.subject, first.library!.locator.folderId],
    [source._id, stored.googleAccountId, stored.driveRootFolderId]);
});

test('a clean population has no blocking findings', () => {
  const users = [user(), user()];
  const r = report(users, users.map(u => account(u._id)));
  assert.deepEqual([r.dispositions, r.planned, hasBlockingFindings(r)], [{ ready: 2, blocked: 0 }, { identities: 2, libraries: 2 }, false]);
});

test('repeated and reordered runs produce identical reports and digests', () => {
  const { users, accounts } = fixture();
  const base = report(users, accounts);
  assert.deepEqual(report(users, accounts), base);
  for (const seed of [1, 7, 99]) assert.deepEqual(report(shuffle(users, seed), shuffle(accounts, seed + 1)), base);
  // Any change to a planned field changes the input digest and the plan digest.
  const changed = accounts.map((a, i) => i === 0 ? { ...a, driveRootFolderId: 'movedFolder' } : a);
  const other = report(users, changed);
  assert.notEqual(other.digests.input, base.digests.input);
  assert.notEqual(other.digests.plan, base.digests.plan);
});

test('resuming from every checkpoint yields exactly the remainder of the uninterrupted plan', () => {
  const { users, accounts } = fixture();
  const full = planIdentityMigration(users, accounts);
  const fullReport = planReport(full, { resumed: false });
  for (const limit of [1, 2, 3, 5, 8, users.length - 1, users.length]) {
    const entries = [];
    const totals: Record<string, number> = {};
    let resume: string | undefined, last: IdentityPlanReport | undefined, windows = 0;
    do {
      const plan = planIdentityMigration(shuffle(users, limit), accounts, { limit, resume });
      entries.push(...plan.entries);
      last = planReport(plan, { resumed: resume !== undefined });
      for (const [problem, count] of Object.entries(last.problems)) totals[problem] = (totals[problem] ?? 0) + count;
      assert.deepEqual([last.population, last.collisions, last.digests.input], [fullReport.population, fullReport.collisions, fullReport.digests.input]);
      resume = last.checkpoint ?? undefined;
      windows++;
    } while (resume);
    assert.equal(windows, Math.ceil(users.length / limit));
    assert.deepEqual(entries, full.entries, `limit ${limit}`);
    assert.deepEqual(totals, fullReport.problems);
    assert.equal(last.digests.plan, full.planDigest, 'the chained digest matches the one-shot plan');
    assert.equal(last.window.complete, true);
  }
});

test('stale, tampered or malformed checkpoints are refused', () => {
  const { users, accounts } = fixture();
  const first = planIdentityMigration(users, accounts, { limit: 4 });
  const token = first.checkpoint!;
  assert.match(token, /^c28\.1\.4\.[0-9a-f]{16}\.[0-9a-f]{20}\.[0-9a-f]{20}$/);
  assert.equal(parseCheckpoint(token).processed, 4);
  // The data changed after the checkpoint: refuse rather than plan a different remainder.
  assert.throws(() => planIdentityMigration([...users, user()], accounts, { resume: token }), /identity_plan_checkpoint_stale/);
  const [prefix, version, processed, ref, chain, digest] = token.split('.');
  const flip = (hex: string) => (hex[0] === '0' ? '1' : '0') + hex.slice(1);
  for (const bad of [[prefix, version, '5', ref, chain, digest], [prefix, version, processed, flip(ref), chain, digest],
    [prefix, version, processed, ref, flip(chain), digest], [prefix, version, '999', ref, chain, digest]]) {
    assert.throws(() => planIdentityMigration(users, accounts, { resume: bad.join('.') }), /identity_plan_checkpoint_mismatch/);
  }
  for (const bad of ['', 'c28.1.0.' + ref + '.' + chain + '.' + digest, 'c28.2.4.' + ref + '.' + chain + '.' + digest, token + 'x']) {
    assert.throws(() => planIdentityMigration(users, accounts, { resume: bad }), /identity_plan_checkpoint_invalid/);
  }
  for (const limit of [0, -1, 1.5, 100_001]) assert.throws(() => planIdentityMigration(users, accounts, { limit }), /identity_plan_limit_invalid/);
});

test('reports carry no ids, emails, subjects or folder ids', () => {
  const { users, accounts } = fixture();
  const r = report(users, accounts, { limit: 7 });
  assertSanitized(r);
  const text = JSON.stringify(r);
  for (const u of users) assert.ok(!text.includes(String(u._id)) && (typeof u.email !== 'string' || u.email.trim() === '' || !text.includes(u.email)));
  for (const a of accounts) {
    for (const value of [a._id, a.googleAccountId, a.driveRootFolderId]) if (typeof value === 'string') assert.ok(!text.includes(value), value);
  }
  for (const refs of Object.values(r.samples)) for (const ref of refs ?? []) assert.match(ref, /^[0-9a-f]{16}$/);
});

test('arguments are read-only only, and the runner refuses before connecting', async () => {
  assert.deepEqual(identityPlanArguments(['--read-only', '--database', 'atomic_notes']), { database: 'atomic_notes' });
  const token = 'c28.1.4.0123456789abcdef.0123456789abcdef0123.0123456789abcdef0123';
  assert.deepEqual(identityPlanArguments(['--read-only', '--database', 'db1', '--limit', '50', '--resume', token]),
    { database: 'db1', limit: 50, resume: token });
  for (const bad of [[], ['--apply'], ['--read-only'], ['--read-only', '--database', 'a.b'], ['--seed-disposable'],
    ['--read-only', '--database', 'db', '--apply'], ['--read-only', '--database', 'db', '--limit', '0'],
    ['--read-only', '--database', 'db', '--limit', '100001'], ['--read-only', '--database', 'db', '--limit', '5', '--limit', '6'],
    ['--read-only', '--database', 'db', '--resume', 'x'], ['--read-only', '--database', 'db', '--backfill', 'yes']]) {
    assert.throws(() => identityPlanArguments(bad), /^Error: usage:/, JSON.stringify(bad));
  }
  await assert.rejects(runReadOnlyIdentityPlan(undefined, 'x'), /explain_uri_required/);
  await assert.rejects(runReadOnlyIdentityPlan('http://example.invalid', 'x'), /explain_uri_invalid/);
  await assert.rejects(runReadOnlyIdentityPlan('mongodb://127.0.0.1:1', 'bad.name'), /identity_plan_database_invalid/);
});
