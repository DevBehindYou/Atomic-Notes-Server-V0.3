import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { assertFixtureCleanup, fixtureDatabase } from './clientFixtureSafety.js';

// C29: the binding CAS store against a disposable local replica set. Accounts are created by the production
// Google sign-in boundary (completeGoogleLogin) with a fake ID-token verifier and injected Drive setup; the
// read-only adapter projects them into binding records, which are written ONLY to a disposable collection.
// Racing operations run concurrently with Promise.all. users and google_accounts must hash identically before
// and after everything.
const uri = process.env.MONGODB_URI;
const database = fixtureDatabase(uri); // canonical local replica set only; generated database name
process.env.MONGODB_DB_NAME = database;
process.env.TOKEN_ENCRYPTION_KEY = Buffer.alloc(32, 9).toString('base64');
const { getDb, closeDb } = await import('../src/db/mongo.js');
const { collections, ensureIndexes } = await import('../src/db/collections.js');
const { completeGoogleLogin } = await import('../src/routes/auth.js');
const { applyBindingCommand, checkRecordInvariants, DROPBOX_ISSUER, LEGACY_GOOGLE_SETUP_KEY, transition } =
  await import('../src/lib/storageBinding.js');
const { createMongoBindingStore, ensureBindingStoreIndexes, readLegacyGoogleBindings } = await import('../src/db/storageBindingStore.js');
type Actor = import('../src/lib/storageBinding.js').BindingActor;
type Command = import('../src/lib/storageBinding.js').BindingCommand;
type Result = import('../src/lib/storageBinding.js').TransitionResult;

type Setup = Parameters<typeof completeGoogleLogin>[4];
let counter = 0;
const subject = () => String(100000000000000000000n + BigInt(Date.now() % 1000000) * 1000n + BigInt(++counter));
// The trailing '_' keeps labels distinct after padding (fr1 and fr10 must differ).
const tok = (label: string) => `tok_${label}_`.padEnd(20, '0');
const LEASE = 60_000;
const G = (holder: string, sub: string): Actor => ({ provider: 'google_drive', issuer: 'https://accounts.google.com', subject: sub,
  holder: tok(`h${holder}`) });
const D = (holder: string): Actor => ({ provider: 'dropbox', issuer: DROPBOX_ISSUER, subject: `dbid:fixture${holder}`, holder: tok(`h${holder}`) });
const errors = (results: Result[]) => results.map(r => (r.ok ? 'ok' : r.error)).sort();
const count = (values: string[]) => values.reduce<Record<string, number>>((all, v) => ({ ...all, [v]: (all[v] ?? 0) + 1 }), {});

test('binding CAS races resolve to one winner on Mongo; legacy Google locators are preserved and never written',
  { timeout: 300000 }, async (t) => {
  const db = await getDb();
  assertFixtureCleanup(db.databaseName, database);
  let owns = false;
  try {
    assert.equal((await db.listCollections({}, { nameOnly: true }).toArray()).length, 0, 'refuse a database collision');
    owns = true;
    await ensureIndexes(db); // production index definitions for users/google_accounts only

    // Real sign-in path; Drive setup injected.
    const verifier = { async verifyIdToken({ idToken }: { idToken: string }) { return { getPayload: () => JSON.parse(idToken) }; } } as
      unknown as Parameters<typeof completeGoogleLogin>[1];
    const login = (sub: string, email: string, setup: Setup) => completeGoogleLogin(db, verifier, {
      access_token: 'access', refresh_token: 'refresh', expiry_date: Date.now() + 3600000,
      id_token: JSON.stringify({ sub, email, email_verified: true, name: 'Person' }) }, 'c29-fixture', setup);
    const people: { id: string; sub: string; folderId: string | null }[] = [];
    for (let i = 1; i <= 3; i++) {
      const sub = subject(), folderId = `driveFolderC29_${i}`;
      const result = await login(sub, `c29person${i}@example.test`, (async () => ({ notesId: folderId })) as unknown as Setup);
      assert.ok('user' in result && result.user, JSON.stringify(result));
      people.push({ id: result.user.id, sub, folderId });
    }
    const pendingSub = subject();
    await assert.rejects(login(pendingSub, 'c29pending@example.test', (async () => { throw new Error('drive_setup_failed'); }) as unknown as Setup),
      /drive_setup_failed/);
    const pendingAccount = (await collections.googleAccounts(db).findOne({ googleAccountId: pendingSub }))!;
    people.push({ id: pendingAccount.userId, sub: pendingSub, folderId: null });

    const protectedCollections = ['users', 'google_accounts'];
    const hashBefore = await db.command({ dbHash: 1, collections: protectedCollections });
    const accountsBefore = await collections.googleAccounts(db).find().sort({ googleAccountId: 1 }).toArray();

    // Read-only projection of the legacy rows.
    const observedAt = 1_900_000_000_000;
    const projection = await readLegacyGoogleBindings(db, observedAt);
    assert.deepEqual(projection.refused, { invalid_account_id: 0, invalid_subject: 0, folder_invalid: 0, multiple_google_accounts: 0,
      user_missing: 0 });
    assert.equal(projection.bindings.length, 4);
    for (const person of people) {
      const record = projection.bindings.find(b => b.accountId === person.id)!;
      assert.deepEqual(checkRecordInvariants(record), []);
      assert.deepEqual(record.owner, { issuer: 'https://accounts.google.com', subject: person.sub });
      if (person.folderId) {
        assert.deepEqual([record.state, record.locator], ['active', { kind: 'drive_folder', folderId: person.folderId }]);
      } else {
        assert.deepEqual([record.state, record.idempotencyKey, record.locator], ['provisioning', LEGACY_GOOGLE_SETUP_KEY, null]);
      }
    }

    // Disposable binding collection: the only collection this test writes.
    const bindingCollection = db.collection('disposable_storage_bindings');
    await ensureBindingStoreIndexes(bindingCollection);
    const store = createMongoBindingStore(bindingCollection);
    for (const record of projection.bindings) assert.equal(await store.compareAndSet(record.accountId, null, record), 'ok');
    assert.equal(await store.compareAndSet(people[0].id, null, projection.bindings.find(b => b.accountId === people[0].id)!), 'conflict',
      'a second import of the same account is refused');
    let clock = observedAt;
    const now = () => clock;
    const apply = (id: string, command: Command) => applyBindingCommand(store, id, command, now, 64);

    // Race 1: raw CAS. 16 writers with the same expected generation; exactly one replace matches.
    const legacy = (await store.get(people[0].id))!;
    const paused = transition(legacy.accountId, legacy, { type: 'pause', reason: 'provider_unavailable', expectedGeneration: 0 }, clock);
    assert.ok(paused.ok && paused.changed);
    const raw = await Promise.all(Array.from({ length: 16 }, () => store.compareAndSet(legacy.accountId, 0, paused.record)));
    assert.deepEqual(count(raw), { ok: 1, conflict: 15 });

    // Race 2: 8 devices of the same owner reconnect concurrently; one leases, the rest see it in progress.
    const reconnects = await Promise.all(Array.from({ length: 8 }, (_, i) => apply(people[0].id,
      { type: 'reconnect', actor: G(`p0d${i}`, people[0].sub), token: tok(`p0r${i}`), leaseMs: LEASE })));
    assert.deepEqual(count(errors(reconnects)), { ok: 1, reconnect_in_progress: 7 });
    const winner = reconnects.findIndex(r => r.ok);
    // Another Google identity and a Dropbox identity are refused outright.
    assert.deepEqual(errors(await Promise.all([
      apply(people[0].id, { type: 'reconnect', actor: G('intruder', people[1].sub), token: tok('intr'), leaseMs: LEASE }),
      apply(people[0].id, { type: 'reconnect', actor: D('intruder'), token: tok('intr'), leaseMs: LEASE }),
      apply(people[0].id, { type: 'confirm_reconnect', actor: G('p0', people[0].sub), token: tok(`p0r${winner}`),
        locator: { kind: 'drive_folder', folderId: 'someOtherFolder' } }),
    ])), ['locator_mismatch', 'owner_mismatch', 'provider_mismatch']);
    const confirmed = await apply(people[0].id, { type: 'confirm_reconnect', actor: G('p0', people[0].sub), token: tok(`p0r${winner}`),
      locator: { kind: 'drive_folder', folderId: people[0].folderId! } });
    assert.ok(confirmed.ok && confirmed.changed);
    assert.deepEqual([confirmed.record.state, confirmed.record.locator, confirmed.record.generation],
      ['active', { kind: 'drive_folder', folderId: people[0].folderId }, 3]);

    // Race 3: revoked consent observed under generation 3 races a stale pause observed under generation 0; one pause applies.
    const pauses = await Promise.all([3, 3, 3, 0, 0].map(expectedGeneration => apply(people[0].id,
      { type: 'pause', reason: 'consent_revoked', expectedGeneration })));
    // The first committed pause wins; generation-3 retries see `paused` and are no-ops; generation-0 pauses are stale or no-ops.
    assert.equal(pauses.filter(r => r.ok && r.changed).length, 1);
    assert.ok(pauses.every(r => r.ok || r.error === 'stale_generation'));
    const afterPause = (await store.get(people[0].id))!;
    assert.deepEqual([afterPause.state, afterPause.locator], ['paused', { kind: 'drive_folder', folderId: people[0].folderId }]);

    // Race 4: a fresh account. 24 concurrent reservations from mixed devices and providers: exactly one holds it.
    const fresh = randomUUID();
    const actors = Array.from({ length: 24 }, (_, i) => (i % 3 === 0 ? D(`f${i}`) : G(`f${i}`, `7000${i}`)));
    const reservations = await Promise.all(actors.map((actor, i) => apply(fresh,
      { type: 'reserve', actor, token: tok(`fr${i}`), leaseMs: LEASE })));
    assert.deepEqual(count(errors(reservations)), { ok: 1, binding_reserved: 23 });
    const holder = reservations.findIndex(r => r.ok);
    assert.equal((await store.get(fresh))!.generation, 1);

    // Race 5: after expiry, the original holder's begin races 10 takeovers. Exactly one CAS wins.
    clock += LEASE + 1;
    const takeovers = await Promise.all([
      apply(fresh, { type: 'begin_provisioning', actor: actors[holder], token: tok(`fr${holder}`), idempotencyKey: tok('fkey'), leaseMs: LEASE }),
      ...Array.from({ length: 10 }, (_, i) => apply(fresh, { type: 'reserve', actor: G(`t${i}`, `8000${i}`), token: tok(`ft${i}`),
        leaseMs: LEASE })),
    ]);
    assert.equal(takeovers.filter(r => r.ok && r.changed).length, 1);
    const afterTakeover = (await store.get(fresh))!;
    assert.equal(afterTakeover.generation, 2);
    if (takeovers[0].ok) {
      assert.equal(afterTakeover.state, 'provisioning');
      assert.ok(takeovers.slice(1).every(r => !r.ok && r.error === 'binding_reserved'));
    } else {
      assert.equal(afterTakeover.state, 'reserved');
      assert.ok(['stale_lease', 'provider_mismatch', 'owner_mismatch'].includes(takeovers[0].error));
    }
    t.diagnostic(`C29_TAKEOVER_WINNER ${takeovers[0].ok ? 'original_holder' : 'takeover'}`);

    // Race 6: one owner identity reserving two accounts concurrently; the partial unique index allows one.
    const [x, y] = [randomUUID(), randomUUID()];
    const twin = await Promise.all([x, y].map((id, i) => apply(id, { type: 'reserve', actor: G(`tw${i}`, '9000001'), token: tok(`tw${i}`),
      leaseMs: LEASE })));
    assert.deepEqual(errors(twin), ['identity_bound_elsewhere', 'ok']);

    // Race 7: crash after the provider call on the unfinished legacy setup. Six devices of the owner resume concurrently;
    // one leases with the ORIGINAL key; other identities never can.
    const pending = people[3];
    const resumes = await Promise.all([
      ...Array.from({ length: 6 }, (_, i) => apply(pending.id, { type: 'resume_provisioning', actor: G(`pd${i}`, pending.sub),
        token: tok(`pr${i}`), leaseMs: LEASE })),
      apply(pending.id, { type: 'resume_provisioning', actor: D('pd'), token: tok('prd'), leaseMs: LEASE }),
      apply(pending.id, { type: 'resume_provisioning', actor: G('pdx', people[1].sub), token: tok('prx'), leaseMs: LEASE }),
    ]);
    assert.deepEqual(count(errors(resumes)), { ok: 1, provisioning_in_progress: 5, binding_reserved: 2 });
    const resumer = resumes.findIndex(r => r.ok);
    const leased = (await store.get(pending.id))!;
    assert.equal(leased.idempotencyKey, LEGACY_GOOGLE_SETUP_KEY);
    // An unknown outcome cannot be reported as failure; the idempotent re-check result completes it.
    assert.deepEqual(await apply(pending.id, { type: 'fail_provisioning', actor: G('pd', pending.sub), token: tok(`pr${resumer}`),
      evidence: 'timeout' } as never), { ok: false, error: 'unknown_outcome_not_failure' });
    const completes = await Promise.all([0, 1, 2].map(() => apply(pending.id, { type: 'complete_provisioning', actor: G('pd', pending.sub),
      token: tok(`pr${resumer}`), idempotencyKey: LEGACY_GOOGLE_SETUP_KEY, locator: { kind: 'drive_folder', folderId: 'recheckedFolder' } })));
    assert.equal(completes.filter(r => r.ok && r.changed).length, 1);
    assert.ok(completes.every(r => r.ok), 'the losing completions are idempotent no-ops');
    assert.deepEqual((await store.get(pending.id))!.locator, { kind: 'drive_folder', folderId: 'recheckedFolder' });

    // Every stored record is valid; untouched legacy bindings still carry the exact Drive folder.
    for (const doc of await bindingCollection.find().toArray()) {
      const { _id, ...record } = doc;
      assert.equal(_id, record.accountId);
      assert.deepEqual(checkRecordInvariants(record), []);
    }
    for (const person of people.slice(1, 3)) {
      assert.deepEqual((await store.get(person.id))!.locator, { kind: 'drive_folder', folderId: person.folderId });
    }

    // Zero writes to users and google_accounts; the binding service changed nothing the sign-in path reads.
    const hashAfter = await db.command({ dbHash: 1, collections: protectedCollections });
    assert.deepEqual(hashAfter.collections, hashBefore.collections);
    assert.deepEqual(await collections.googleAccounts(db).find().sort({ googleAccountId: 1 }).toArray(), accountsBefore);
    assert.equal(pendingAccount.driveRootFolderId, null);
    assert.equal((await collections.googleAccounts(db).findOne({ googleAccountId: pendingSub }))!.driveRootFolderId, null,
      'the disposable completion did not touch the real row');
    const names = (await db.listCollections({}, { nameOnly: true }).toArray()).map(c => c.name).sort();
    assert.ok(!names.some(name => /binding/.test(name) && name !== 'disposable_storage_bindings'), JSON.stringify(names));
    t.diagnostic(`C29_FIXTURE ${JSON.stringify({ legacy: projection.bindings.length, reconnects: count(errors(reconnects)),
      reservations: count(errors(reservations)), resumes: count(errors(resumes)), rawCas: count(raw) })}`);
  } finally {
    assertFixtureCleanup(db.databaseName, database);
    if (owns) await db.dropDatabase();
    await closeDb();
  }
});
