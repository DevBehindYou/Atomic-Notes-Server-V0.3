import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import type { Document } from 'mongodb';
import { assertFixtureCleanup, fixtureDatabase } from './clientFixtureSafety.js';

// C28: accounts are created by the production Google sign-in boundary (completeGoogleLogin)
// against a generated local database, with a fake ID-token verifier and Drive setup.
// Problem rows are inserted by hand afterwards, bypassing the writers. The dry-run plan then
// runs through the guarded read-only client; the test proves exact counts, deterministic and
// resumable output, and that the plan changed nothing.
const uri = process.env.MONGODB_URI;
const database = fixtureDatabase(uri); // canonical local replica set only; generated database name
process.env.MONGODB_DB_NAME = database;
process.env.TOKEN_ENCRYPTION_KEY = Buffer.alloc(32, 9).toString('base64');
const { getDb, closeDb } = await import('../src/db/mongo.js');
const { collections, ensureIndexes, googleAccountSchema, userSchema } = await import('../src/db/collections.js');
const { completeGoogleLogin } = await import('../src/routes/auth.js');
const { encryptToken } = await import('../src/lib/crypto.js');
const { checkOldReaderCompatibility } = await import('../src/lib/identityContract.js');
const { runReadOnlyIdentityPlan } = await import('../src/db/identityMigrationPlanRunner.js');

type Setup = Parameters<typeof completeGoogleLogin>[4];
let counter = 0;
const subject = () => String(100000000000000000000n + BigInt(Date.now() % 1000000) * 1000n + BigInt(++counter));

test('identity plan classifies real sign-in and hand-inserted rows exactly, resumes deterministically and writes nothing',
  { timeout: 300000 }, async (t) => {
  const db = await getDb();
  assertFixtureCleanup(db.databaseName, database);
  let owns = false;
  try {
    assert.equal((await db.listCollections({}, { nameOnly: true }).toArray()).length, 0, 'refuse a database collision');
    owns = true;
    await ensureIndexes(db); // production index definitions only

    // Production sign-in path. The verifier returns the claims it is given; Drive setup is injected.
    const verifier = { async verifyIdToken({ idToken }: { idToken: string }) { return { getPayload: () => JSON.parse(idToken) }; } } as
      unknown as Parameters<typeof completeGoogleLogin>[1];
    const folder = (name: string): Setup => (async () => ({ notesId: name })) as unknown as Setup;
    const login = (sub: string, email: string, setup: Setup, tokens: object = {}) => completeGoogleLogin(db, verifier, {
      access_token: 'access', refresh_token: 'refresh', expiry_date: Date.now() + 3600000,
      id_token: JSON.stringify({ sub, email, email_verified: true, name: 'Person' }), ...tokens }, 'c28-fixture', setup);
    const signedIn = async (sub: string, email: string, folderId: string) => {
      const result = await login(sub, email, folder(folderId));
      assert.ok('user' in result && result.user, JSON.stringify(result));
      return { id: result.user.id, sub, email: email.toLowerCase(), folderId };
    };
    const R = [];
    for (let i = 1; i <= 5; i++) R.push(await signedIn(subject(), `Person${i}@Example.test`, `driveFolderR${i}`));
    // Returning subject with a changed email keeps its UUID (links by subject).
    const returning = await login(R[4].sub, 'Moved5@Example.test', folder('unused'), { refresh_token: undefined, access_token: 'access-2' });
    assert.ok('user' in returning && returning.user?.id === R[4].id);
    // Drive setup failure leaves a repairable user + account with no folder (auth.ts writes rows before setup).
    const pendingSub = subject();
    await assert.rejects(login(pendingSub, 'pending@example.test', (async () => { throw new Error('drive_setup_failed'); }) as unknown as Setup),
      /drive_setup_failed/);
    const pending = (await collections.googleAccounts(db).findOne({ googleAccountId: pendingSub }))!;
    assert.equal(pending.driveRootFolderId, null);
    // Characterization: a NEW subject presenting an existing user's email cannot sign in today. The exact-case
    // unique email index rejects the new user row and the transaction leaves no partial identity.
    const before = [await collections.users(db).countDocuments(), await collections.googleAccounts(db).countDocuments()];
    await assert.rejects(login(subject(), 'person1@example.test', folder('neverCreated')), /E11000|duplicate key/);
    assert.deepEqual([await collections.users(db).countDocuments(), await collections.googleAccounts(db).countDocuments()], before);

    // Old readers: documents written by the real sign-in path parse with the current schemas, with or without proposed fields.
    for (const doc of await collections.users(db).find().toArray()) {
      assert.ok(userSchema.safeParse(doc).success);
      assert.deepEqual(checkOldReaderCompatibility('users', doc), { acceptedBefore: true, acceptedAfter: true, unchanged: true });
    }
    for (const doc of await collections.googleAccounts(db).find().toArray()) {
      assert.ok(googleAccountSchema.safeParse(doc).success);
      assert.deepEqual(checkOldReaderCompatibility('google_accounts', doc), { acceptedBefore: true, acceptedAfter: true, unchanged: true });
    }

    // Hand-inserted problem rows, bypassing the writers.
    const now = new Date();
    const insertUser = (doc: Document) => db.collection('users').insertOne({ displayName: null, createdAt: now, updatedAt: now, ...doc });
    const insertAccount = (userId: unknown, extra: Document = {}) => db.collection('google_accounts').insertOne({ _id: randomUUID() as never,
      userId, googleAccountId: subject(), encryptedAccessToken: encryptToken('fixture-access'), encryptedRefreshToken: encryptToken('fixture-refresh'),
      tokenExpiry: now, driveRootFolderId: `driveFolderH${++counter}`, createdAt: now, ...extra });
    const H = Object.fromEntries(['h1', 'h4', 'h5', 'h6', 'h7a', 'h7b', 'h8'].map(key => [key, randomUUID()]));
    await insertUser({ _id: H.h1 as never, email: 'h1@example.test' }); // H1: user without a Google account
    await insertAccount(randomUUID()); // H2: orphan account, user missing
    await insertAccount(R[1].id); // H3: second Google account for R2
    await insertUser({ _id: H.h4 as never, email: 'Person3@Example.test' }); await insertAccount(H.h4); // H4: case variant of R3's email
    await insertUser({ _id: H.h5 as never }); await insertAccount(H.h5); // H5: no email
    await insertUser({ _id: H.h6 as never, email: 'h6@example.test' }); await insertAccount(H.h6, { googleAccountId: 'someone@example.test' });
    await insertUser({ _id: H.h7a as never, email: 'h7a@example.test' }); await insertAccount(H.h7a, { driveRootFolderId: 'sharedDriveFolder' });
    await insertUser({ _id: H.h7b as never, email: 'h7b@example.test' }); await insertAccount(H.h7b, { driveRootFolderId: 'sharedDriveFolder' });
    await insertUser({ _id: H.h8 as never, email: 'h8@example.test' }); await insertAccount(H.h8, { driveRootFolderId: 'bad folder/..' });
    await insertUser({ _id: 'legacy-user-0001' as never, email: 'h9@example.test' }); await insertAccount('legacy-user-0001'); // H9
    await insertAccount(42); // H10: orphan account, invalid user id

    // Dry run: same reader as the operator script, through the C25 command guard.
    const hashBefore = await db.command({ dbHash: 1 });
    const first = await runReadOnlyIdentityPlan(uri, database);
    const second = await runReadOnlyIdentityPlan(uri, database);
    const windows: Awaited<ReturnType<typeof runReadOnlyIdentityPlan>>[] = [];
    let resume: string | undefined;
    do {
      const run = await runReadOnlyIdentityPlan(uri, database, { limit: 4, resume });
      windows.push(run);
      resume = run.report.checkpoint ?? undefined;
    } while (resume);
    const hashAfter = await db.command({ dbHash: 1 });
    assert.equal(hashAfter.md5, hashBefore.md5, 'the plan wrote nothing');
    assert.deepEqual(hashAfter.collections, hashBefore.collections);
    const allowed = new Set(['buildInfo', 'endSessions', 'find', 'getMore', 'hello', 'isMaster', 'ismaster', 'killCursors',
      'listCollections', 'listIndexes', 'ping', 'saslContinue', 'saslStart']);
    for (const run of [first, second, ...windows]) {
      assert.deepEqual(run.violations, []);
      assert.deepEqual(Object.keys(run.commands).filter(name => !allowed.has(name)), [], JSON.stringify(run.commands));
      assert.equal(run.report.snapshot, true);
      assert.equal(run.report.applied, false);
    }
    assert.deepEqual(second.report, first.report, 'repeatable on the same data');
    const report = first.report;
    t.diagnostic(`IDENTITY_PLAN_REPORT ${JSON.stringify({ population: report.population, collisions: report.collisions,
      catalog: report.catalog, dispositions: report.dispositions, planned: report.planned, problems: report.problems, commands: first.commands })}`);

    assert.deepEqual(report.population, { users: 14, googleAccounts: 16, orphanGoogleAccounts: { missingUser: 1, invalidUserId: 1 } });
    assert.deepEqual(report.catalog, { usersEmailUnique: true, usersEmailCaseInsensitive: false, googleSubjectUnique: true,
      googleUserIdUnique: false });
    assert.deepEqual(report.collisions, { emailGroups: 1, emailUsers: 2, subjectGroups: 0, subjectAccounts: 0, folderGroups: 1, folderUsers: 2 });
    assert.deepEqual(report.dispositions, { ready: 6, blocked: 8 });
    assert.deepEqual(report.planned, { identities: 12, libraries: 6 });
    assert.deepEqual(report.problems, {
      user_id_not_uuid: 1, no_google_account: 1, multiple_google_accounts: 1, subject_invalid: 0, subject_email_shaped: 1,
      subject_duplicate: 0, folder_missing: 1, folder_invalid: 1, folder_shared: 2,
      email_missing: 1, email_malformed: 0, email_not_normalized: 1, email_duplicate: 2, legacy_reader_rejects_user: 2,
    });
    assert.deepEqual(report.window, { start: 0, processed: 14, total: 14, complete: true, resumed: false });

    // Resume: four windows of at most four users chain to the one-shot digest and the same totals.
    assert.deepEqual(windows.map(run => run.report.window.processed), [4, 8, 12, 14]);
    assert.deepEqual(windows.map(run => run.report.window.resumed), [false, true, true, true]);
    assert.equal(windows.at(-1)!.report.digests.plan, report.digests.plan);
    for (const run of windows) assert.equal(run.report.digests.input, report.digests.input);
    const totals = Object.fromEntries(Object.keys(report.problems).map(problem =>
      [problem, windows.reduce((sum, run) => sum + run.report.problems[problem as keyof typeof report.problems], 0)]));
    assert.deepEqual(totals, report.problems);
    assert.deepEqual(windows.reduce((sum, run) => sum + run.report.dispositions.blocked, 0), report.dispositions.blocked);

    // Sanitized: no ids, emails, subjects, folder ids, tokens or database name.
    const text = JSON.stringify([first.report, ...windows.map(run => run.report)]);
    const secrets = [database, 'legacy-user-0001', 'someone@example.test', 'sharedDriveFolder', 'example.test', 'Example.test',
      ...Object.values(H), ...R.flatMap(r => [r.id, r.sub, r.folderId]), pendingSub];
    for (const account of await collections.googleAccounts(db).find().toArray()) {
      secrets.push(String(account._id), account.encryptedAccessToken, account.encryptedRefreshToken);
    }
    for (const secret of secrets) assert.ok(!text.includes(secret), 'report leaked an identifier');

    // A write after a checkpoint makes that checkpoint stale: the remainder is refused, not silently re-planned.
    const checkpoint = windows[0].report.checkpoint!;
    await insertUser({ _id: randomUUID() as never, email: 'late@example.test' });
    await assert.rejects(runReadOnlyIdentityPlan(uri, database, { limit: 4, resume: checkpoint }), /identity_plan_checkpoint_stale/);
  } finally {
    assertFixtureCleanup(db.databaseName, database);
    if (owns) await db.dropDatabase();
    await closeDb();
  }
});
