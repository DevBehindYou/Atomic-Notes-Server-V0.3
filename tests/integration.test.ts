import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID, createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { Hono } from 'hono';
import { BSON, type Db } from 'mongodb';
import { applySyncRetention, inspectSyncRetention } from '../src/db/syncRetention';

// This suite creates and drops only its own database on a disposable local runner.
const uri = process.env.MONGODB_URI;
// Default: a disposable localhost replica set only. A developer may opt in to a temporary database inside an
// Atlas cluster: the suite still creates a uniquely named database and drops only that one at the end.
const localReplicaSet = /^mongodb:\/\/(127\.0\.0\.1|localhost):\d+(?:[/?]|$)/.test(uri ?? '');
const atlasTempDb = process.env.INTEGRATION_ALLOW_ATLAS_TEMP_DB === 'yes' && /^mongodb\+srv:\/\//.test(uri ?? '');
if (!uri || !(localReplicaSet || atlasTempDb)) {
  throw new Error('Integration tests require a disposable localhost MongoDB replica set');
}
// Atlas limits database names to 38 bytes.
const databaseName = `atomic_test_${randomUUID().replaceAll('-', '').slice(0, 20)}`;
process.env.MONGODB_DB_NAME = databaseName;
delete process.env.COIN_EXPIRY_ACTIVATED_AT; // Existing contract/budget fixtures exercise staged, inactive policy.
process.env.ADMIN_API_KEY = 'test-admin-key';
process.env.TOKEN_ENCRYPTION_KEY = Buffer.alloc(32, 3).toString('base64');

const { appendLedger } = await import('../src/lib/ledger');
const { getDb, closeDb, withTransaction } = await import('../src/db/mongo');
const { collections, ensureIndexes } = await import('../src/db/collections');
const { createSession, verifySession } = await import('../src/lib/session');
const { energyEnsure, energyConvert, energyGrantDaily } = await import('../src/lib/energy');
const { encryptToken } = await import('../src/lib/crypto');
const { createNotesRoute } = await import('../src/routes/notes');
const { registerErrorHandler } = await import('../src/middleware/errorHandler');
const { default: admin } = await import('../src/routes/admin');
const { default: publicRoute } = await import('../src/routes/public');
const { default: notificationsRoute } = await import('../src/routes/notifications');
const { default: vault } = await import('../src/routes/vault');
const { default: energyRoute } = await import('../src/routes/energy');
const { default: profileRoute } = await import('../src/routes/atomicuser');
const { default: auth, completeGoogleLogin } = await import('../src/routes/auth');
const { beginSync, finishSync, recordSyncResult, syncOperations } = await import('../src/lib/syncOperation');
const { saveNoteMetadata } = await import('../src/lib/noteMetadata');
const { decryptToken } = await import('../src/lib/crypto');
const { remoteNoteRowSchema } = await import('../src/types/noteWire');
const { mongoCommands } = await import('../src/lib/perf');
// Upper bounds on MongoDB commands per one-note operation (set after measuring; lower them when optimizing).
const BUDGET: Record<string, number> = { firstPush: 29, instantPush: 29, cooldownPush: 10, pullOneRow: 4, pullNothing: 2, count: 2 };

test('Server contracts with a real MongoDB replica set and a fake Drive adapter', { timeout: Number(process.env.INTEGRATION_TIMEOUT_MS ?? 120000) }, async (t) => {
  const db = await getDb();
  t.after(async () => {
    try { assert.equal(db.databaseName, databaseName); await db.dropDatabase(); }
    finally { await closeDb(); }
  });
  assert.ok((await db.admin().command({ hello: 1 })).setName, 'Transactions require a replica set');
  await ensureIndexes(db);

  await t.test('R10 retention transition is scoped, preflighted, read-only by default and resumable', async () => {
    const unchangedNames = ['sessions', 'oauth_states', 'operation_locks', 'logs', 'controller_login_attempts'];
    const beforeOther = await Promise.all(unchangedNames.map((name) => db.collection(name).indexes()));
    const createOldIndexes = async (seconds = 30 * 24 * 60 * 60) => {
      await db.collection('notes').createIndex({ updatedAt: 1 }, { name: 'tombstone_ttl', expireAfterSeconds: 30 * 24 * 60 * 60, partialFilterExpression: { deleted: true } });
      await db.collection('sync_operations').createIndex({ createdAt: 1 }, { expireAfterSeconds: seconds });
    };
    // Current dates prevent the TTL monitor interfering with the index transition fixture.
    const fixtures = [
      { collection: 'notes', value: { _id: 'retention-index-sentinel', deleted: true, updatedAt: new Date() } },
      { collection: 'sync_operations', value: { _id: 'retention-index-sentinel', status: 'pending', createdAt: new Date() } },
    ];
    const fixtureCollection = (name: string) => db.collection<{ _id: string; [key: string]: unknown }>(name);
    for (const fixture of fixtures) await fixtureCollection(fixture.collection).insertOne(fixture.value);
    await createOldIndexes(86400); // Unexpected TTL duration must stop before either drop.
    await assert.rejects(() => applySyncRetention(db, databaseName), /sync_retention_index_drift/);
    assert.ok((await db.collection('notes').indexes()).some((i) => i.name === 'tombstone_ttl'));
    await db.collection('sync_operations').dropIndex('createdAt_1');
    await createOldIndexes();
    const plan = await inspectSyncRetention(db);
    assert.deepEqual(plan, { database: databaseName, drops: [
      { collection: 'notes', name: 'tombstone_ttl' }, { collection: 'sync_operations', name: 'createdAt_1' },
    ] });
    assert.deepEqual(await inspectSyncRetention(db), plan, 'inspection must not remove indexes');
    await assert.rejects(() => applySyncRetention(db, 'different_database'), /sync_retention_database_mismatch/);
    assert.deepEqual(await inspectSyncRetention(db), plan, 'wrong database leaves both indexes intact');
    const failingDb = {
      databaseName: db.databaseName,
      listCollections: db.listCollections.bind(db),
      collection(name: string) {
        const collection = db.collection(name);
        return {
          indexes: collection.indexes.bind(collection),
          dropIndex: name === 'sync_operations'
            ? async () => { throw new Error('fixture_index_drop_failure'); }
            : collection.dropIndex.bind(collection),
        };
      },
    } as unknown as typeof db;
    await assert.rejects(() => applySyncRetention(failingDb, databaseName), /fixture_index_drop_failure/);
    assert.deepEqual((await inspectSyncRetention(db)).drops, [{ collection: 'sync_operations', name: 'createdAt_1' }]);
    await applySyncRetention(db, databaseName);
    assert.deepEqual((await applySyncRetention(db, databaseName)).drops, [], 'repeated application is a no-op');
    await ensureIndexes(db);
    assert.deepEqual((await inspectSyncRetention(db)).drops, [], 'general index setup must not restore expiry');
    for (const fixture of fixtures) {
      assert.deepEqual(await fixtureCollection(fixture.collection).findOne({ _id: fixture.value._id }), fixture.value);
      await fixtureCollection(fixture.collection).deleteOne({ _id: fixture.value._id });
    }
    assert.deepEqual(await Promise.all(unchangedNames.map((name) => db.collection(name).indexes())), beforeOther);
  });

  const files = new Map<string, any>();
  let afterUpdateWrite: (() => Promise<void>) | null = null;
  let writes = 0, failDelete = false, failTitle = '', activeReads = 0, peakReads = 0, activeWrites = 0, peakWrites = 0;
  // Simulates what a user can do in Drive outside the app.
  const missingFiles = new Set<string>(); let missingFolder = '', foldersEnsured = 0;
  const notFound = () => Object.assign(new Error('File not found'), { code: 404 });
  // The user revoked the app in their Google account: every Drive call fails as Google reports it.
  let revoked = false;
  const revokedError = () => Object.assign(new Error('invalid_grant'), { response: { data: { error: 'invalid_grant' } } });
  const drive = {
    async createNoteFile(_a: string, _r: string, parent: string, _n: string, content: object) {
      if (revoked) throw revokedError();
      if (missingFolder && parent === missingFolder) throw notFound();
      if ((content as any).title === failTitle && failTitle) throw new Error('simulated_drive_failure');
      peakWrites = Math.max(peakWrites, ++activeWrites); await delay(5); activeWrites--;
      writes++; const id = randomUUID(); files.set(id, structuredClone(content)); return { id, headRevisionId: '1' };
    },
    async updateNoteFile(_a: string, _r: string, id: string, content: object) {
      if (revoked) throw revokedError();
      if (missingFiles.has(id)) throw notFound();
      if ((content as any).title === failTitle && failTitle) throw new Error('simulated_drive_failure');
      peakWrites = Math.max(peakWrites, ++activeWrites); await delay(5); activeWrites--;
      writes++; files.set(id, structuredClone(content)); await afterUpdateWrite?.(); return { id, headRevisionId: '2' };
    },
    async deleteNoteFile(_a: string, _r: string, id: string) {
      if (missingFiles.has(id)) throw notFound();
      if (failDelete) throw new Error('simulated_delete_failure');
      writes++;
    },
    async getNoteFileContent(_a: string, _r: string, id: string) {
      if (revoked) throw revokedError();
      if (missingFiles.has(id)) throw notFound();
      peakReads = Math.max(peakReads, ++activeReads); await delay(5); activeReads--;
      return structuredClone(files.get(id));
    },
    async ensureAppFolders() { foldersEnsured++; missingFolder = ''; return { notesId: 'recreated-folder' }; },
  };
  const app = new Hono(); registerErrorHandler(app);
  app.route('/api/notes', createNotesRoute(drive));
  app.route('/api/admin', admin); app.route('/api/public', publicRoute); app.route('/api/notifications', notificationsRoute);
  app.route('/api/energy', energyRoute); app.route('/api/atomicuser', profileRoute);
  app.route('/api/vault', vault); app.route('/api/auth', auth);
  const request = (path: string, method = 'GET', body?: object, token?: string, adminKey?: string) => app.request(`/api${path}`, {
    method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(adminKey ? { 'x-admin-api-key': adminKey } : {}) }, body: body ? JSON.stringify(body) : undefined,
  });
  async function user(email = `${randomUUID()}@example.com`) {
    const id = randomUUID(), now = new Date();
    await collections.users(db).insertOne({ _id: id, email, displayName: null, createdAt: now, updatedAt: now });
    await collections.googleAccounts(db).insertOne({ _id: randomUUID(), userId: id, googleAccountId: randomUUID(),
      encryptedAccessToken: encryptToken('test-access'), encryptedRefreshToken: encryptToken('test-refresh'),
      tokenExpiry: new Date(Date.now() + 3600000), driveRootFolderId: 'test-folder', createdAt: now });
    await energyEnsure(db, id);
    return { id, token: await createSession(db, id) };
  }
  const owner = await user(), other = await user();
  // Matches Note.toRemote + _sealRemote: updated_at is omitted by the App.
  const row = (overrides = {}) => ({ id: randomUUID(), kind: 'text', title: 'Keep title', body: 'Keep body', items: [],
    pinned: false, deleted: false, created_at: new Date().toISOString(),
    enc_v: 0, payload: null, ...overrides });
  // Opens the hourly standard sync again and tops up energy, for tests about something other than billing.
  const refill = (id: string) => collections.atomicUsers(db).updateOne({ _id: id }, { $set: { lastStandardSyncAt: null, energy: 100 } });
  // The owner is used for many pushes in a row, so its cooldown is reset each time; billing tests use their own accounts.
  const push = async (rows: object[], token = owner.token, requestId = randomUUID(), mode = 'standard') => {
    if (token === owner.token && mode === 'standard') await refill(owner.id);
    return request('/notes/push', 'POST', { rows, requestId, mode }, token);
  };

  await t.test('ledger boundary rejects detached writes and rolls back with wallet mutations', async () => {
    const account = await user();
    const wallet = await collections.atomicUsers(db).findOne({ _id: account.id });
    const before = await collections.energyLedger(db).countDocuments({ userId: account.id });
    const entry = { _id: randomUUID(), userId: account.id, kind: 'admin_adjust' as const,
      coinsDelta: 1, energyDelta: 0, resultingCoins: wallet!.coins + 1,
      resultingEnergy: wallet!.energy, note: 'Synthetic rollback', createdAt: new Date() };
    await withTransaction(async (session) => {
      await session.abortTransaction();
      await assert.rejects(() => appendLedger(db, session, entry), /ledger_transaction_required/);
    });
    await assert.rejects(() => withTransaction(async (session) => {
      await collections.atomicUsers(db).updateOne({ _id: account.id }, { $inc: { coins: 1 } }, { session });
      await appendLedger(db, session, entry);
      throw new Error('fixture_abort_after_ledger');
    }), /fixture_abort_after_ledger/);
    assert.deepEqual(await collections.atomicUsers(db).findOne({ _id: account.id }), wallet);
    assert.equal(await collections.energyLedger(db).countDocuments({ userId: account.id }), before);
    assert.equal(await collections.energyLedger(db).findOne({ _id: entry._id }), null);
  });

  await t.test('concurrent transactional ledger writes preserve each wallet mutation exactly once', async () => {
    const account = await user();
    const before = (await collections.atomicUsers(db).findOne({ _id: account.id }))!;
    const count = await collections.energyLedger(db).countDocuments({ userId: account.id });
    await Promise.all(Array.from({ length: 10 }, () => withTransaction(async (session) => {
      const wallet = await collections.atomicUsers(db).findOneAndUpdate({ _id: account.id },
        { $inc: { coins: 1 } }, { returnDocument: 'after', session });
      await appendLedger(db, session, { _id: randomUUID(), userId: account.id, kind: 'admin_adjust',
        coinsDelta: 1, energyDelta: 0, resultingCoins: wallet!.coins, resultingEnergy: wallet!.energy,
        note: 'Synthetic concurrent credit', createdAt: new Date() });
    })));
    assert.equal((await collections.atomicUsers(db).findOne({ _id: account.id }))!.coins, before.coins + 10);
    const entries = await collections.energyLedger(db).find({ userId: account.id, note: 'Synthetic concurrent credit' }).toArray();
    assert.equal(await collections.energyLedger(db).countDocuments({ userId: account.id }), count + 10);
    assert.deepEqual(entries.map(e => e.resultingCoins).sort((a, b) => a - b),
      Array.from({ length: 10 }, (_, i) => before.coins + i + 1));
  });

  await t.test('transaction history returns the newest 50 deterministically without deleting financial records', async () => {
    const account = await user(), neighbour = await user();
    // Prevent the read endpoint's legitimate daily grant from changing this fixture.
    await collections.atomicUsers(db).updateOne({ _id: account.id }, { $set: { lastDailyGrantAt: new Date() } });
    await collections.energyLedger(db).deleteMany({ userId: account.id });
    const walletBefore = await collections.atomicUsers(db).findOne({ _id: account.id });
    const neighbourBefore = await collections.energyLedger(db).find({ userId: neighbour.id }).toArray();
    for (const size of [0, 49, 50, 51, 205]) {
      await collections.energyLedger(db).deleteMany({ userId: account.id });
      const entries = Array.from({ length: size }, (_, i) => ({
        _id: `00000000-0000-4000-8000-${i.toString(16).padStart(12, '0')}`,
        userId: account.id, kind: 'admin_adjust' as const, coinsDelta: 0, energyDelta: 1,
        resultingCoins: 0, resultingEnergy: i, note: 'Synthetic history fixture',
        // Ties deliberately cross the page boundary; insertion order is the opposite of ID order.
        createdAt: new Date(1700000000000 + Math.floor(i / 3)),
      }));
      if (entries.length) await collections.energyLedger(db).insertMany(entries);
      const response = await request('/energy', 'GET', undefined, account.token);
      assert.equal(response.status, 200);
      const body = await response.json() as { history: { id: string }[] };
      assert.deepEqual(body.history.map((entry) => entry.id), entries.slice().reverse().slice(0, 50).map((entry) => entry._id));
      assert.equal(await collections.energyLedger(db).countDocuments({ userId: account.id }), size,
        'read limit must not perform retention cleanup');
      assert.deepEqual(await collections.atomicUsers(db).findOne({ _id: account.id }), walletBefore);
      assert.deepEqual(await collections.energyLedger(db).find({ userId: neighbour.id }).toArray(), neighbourBefore);
    }
  });

  await t.test('inactive ledger cleanup preserves totals, rolls back and survives repeated concurrent batches', async () => {
    const { archiveLedgerBatch, ledgerArchives, ledgerRecent } = await import('../src/lib/ledgerRetention');
    const { combineLedgerStatistics, projectArchivedStatistics } = await import('../src/lib/ledgerStatistics');
    const account = await user(), neighbour = await user(), at = Date.now();
    await collections.energyLedger(db).deleteMany({ userId: account.id });
    const rows = Array.from({ length: 255 }, (_, i) => ({ _id: randomUUID(), userId: account.id,
      kind: 'admin_adjust' as const, coinsDelta: i % 2 ? -2 : 5, energyDelta: i % 3 ? -10 : 20,
      resultingCoins: 5, resultingEnergy: 0, note: 'Retention fixture', createdAt: new Date(at - Math.floor(i / 3)) }));
    await collections.energyLedger(db).insertMany(rows);
    const wallet = await collections.atomicUsers(db).findOne({ _id: account.id });
    const neighbourRows = await collections.energyLedger(db).find({ userId: neighbour.id }).toArray();
    const expected = combineLedgerStatistics(rows, projectArchivedStatistics(account.id, [], at), at);
    await assert.rejects(() => withTransaction(async session => {
      assert.equal(await archiveLedgerBatch(db, account.id, session, at), 100);
      throw new Error('fixture_abort_after_pruning');
    }), /fixture_abort_after_pruning/);
    assert.equal(await collections.energyLedger(db).countDocuments({ userId: account.id }), 255);
    assert.equal(await ledgerArchives(db).findOne({ _id: account.id }), null);
    assert.equal(await ledgerRecent(db).countDocuments({ userId: account.id }), 0);
    assert.deepEqual(await collections.atomicUsers(db).findOne({ _id: account.id }), wallet);
    const removed = await Promise.all(Array.from({ length: 4 }, () => withTransaction(session => archiveLedgerBatch(db, account.id, session, at))));
    assert.equal(removed.reduce((sum, n) => sum + n, 0), 205);
    assert.equal(await withTransaction(session => archiveLedgerBatch(db, account.id, session, at)), 0);
    const retained = await collections.energyLedger(db).find({ userId: account.id }).sort({ createdAt: -1, _id: -1 }).toArray();
    assert.equal(retained.length, 50);
    const archive = (await ledgerArchives(db).findOne({ _id: account.id }))!;
    const recent = await ledgerRecent(db).find({ userId: account.id }).toArray();
    assert.deepEqual(combineLedgerStatistics(retained, { userId: account.id, projectedAt: archive.projectedAt,
      byKind: archive.byKind, recent }, at), expected);
    assert.deepEqual(await collections.energyLedger(db).find({ userId: neighbour.id }).toArray(), neighbourRows);
    const after = (await collections.atomicUsers(db).findOne({ _id: account.id }))!;
    assert.equal(after.coins, wallet!.coins); assert.equal(after.energy, wallet!.energy);
    await assert.rejects(() => withTransaction(session => archiveLedgerBatch(db, account.id, session, at - 1)), /statistics_time_regression/);
    await withTransaction(session => archiveLedgerBatch(db, account.id, session, at + 86400001));
    assert.equal(await ledgerRecent(db).countDocuments({ userId: account.id }), 0);
    assert.deepEqual((await ledgerArchives(db).findOne({ _id: account.id }))!.byKind, archive.byKind);
  });

  await t.test('cleanup racing Controller credits preserves balances and snapshot statistics', async () => {
    const { archiveLedgerBatch, readRetainedLedgerStatistics } = await import('../src/lib/ledgerRetention');
    const account = await user(), now = Date.now();
    await collections.energyLedger(db).insertMany(Array.from({ length: 100 }, () => ({
      _id: randomUUID(), userId: account.id, kind: 'spend' as const, coinsDelta: 0, energyDelta: -5,
      resultingCoins: 5, resultingEnergy: 0, note: 'Synthetic earlier spend', createdAt: new Date(now - 1000),
    })));
    const before = await readRetainedLedgerStatistics(db, account.id, now);
    const wallet = (await collections.atomicUsers(db).findOne({ _id: account.id }))!;
    const observations: Awaited<ReturnType<typeof readRetainedLedgerStatistics>>[] = [];
    await Promise.all([
      ...Array.from({ length: 5 }, async () => { const response = await request('/admin/energy', 'POST', {
        user_id: account.id, coins_delta: 1, energy_delta: 0, request_id: randomUUID(),
      }, undefined, 'test-admin-key'); assert.equal(response.status, 200); }),
      ...Array.from({ length: 3 }, () => withTransaction(session => archiveLedgerBatch(db, account.id, session, now))),
      (async () => { for (let i = 0; i < 8; i++) observations.push(await readRetainedLedgerStatistics(db, account.id, now)); })(),
    ]);
    await withTransaction(session => archiveLedgerBatch(db, account.id, session, now));
    const after = await readRetainedLedgerStatistics(db, account.id, now);
    assert.equal((await collections.atomicUsers(db).findOne({ _id: account.id }))!.coins, wallet.coins + 5);
    assert.equal(await collections.energyLedger(db).countDocuments({ userId: account.id }), 50);
    assert.equal(after.tx_24h, before.tx_24h + 5);
    assert.equal(after.coins_granted_24h, before.coins_granted_24h + 5);
    assert.equal(after.energy_spent_24h, before.energy_spent_24h);
    assert.equal(after.ledger_by_kind.admin_adjust, (before.ledger_by_kind.admin_adjust ?? 0) + 5);
    for (const view of observations) {
      const credits = view.tx_24h - before.tx_24h;
      assert.ok(credits >= 0 && credits <= 5);
      assert.equal(view.coins_granted_24h - before.coins_granted_24h, credits);
      assert.equal(view.energy_spent_24h, before.energy_spent_24h);
    }
  });

  await t.test('retention inspection reports over-limit and orphan rows without changing data or indexes', async () => {
    const { inspectLedgerRetention } = await import('../src/db/ledgerRetentionInspection');
    const baseline = await inspectLedgerRetention(db);
    const account = await user(), orphanId = randomUUID();
    await collections.energyLedger(db).deleteMany({ userId: account.id });
    const entry = (userId: string) => ({ _id: randomUUID(), userId, kind: 'admin_adjust' as const,
      coinsDelta: 0, energyDelta: 0, resultingCoins: 0, resultingEnergy: 0, note: 'Private fixture text', createdAt: new Date() });
    await collections.energyLedger(db).insertMany([...Array.from({ length: 51 }, () => entry(account.id)), ...Array.from({ length: 3 }, () => entry(orphanId))]);
    const before = await collections.energyLedger(db).find({}).sort({ _id: 1 }).toArray();
    const names = await db.listCollections({}, { nameOnly: true }).toArray();
    const indexes = await collections.energyLedger(db).indexes();
    const wallet = await collections.atomicUsers(db).findOne({ _id: account.id });
    const result = await inspectLedgerRetention(db);
    assert.equal(result.rows, baseline.rows + 54);
    assert.equal(result.accounts, baseline.accounts + 2);
    assert.equal(result.removableRows, baseline.removableRows + 1);
    assert.equal(result.overLimitAccounts, baseline.overLimitAccounts + 1);
    assert.equal(result.orphanRows, baseline.orphanRows + 3);
    assert.equal(result.activationReady, false);
    assert.equal(result.orderingIndexReady, false);
    assert.equal(result.sequenceOrderingIndexReady, false);
    assert.ok(result.blockers.includes('orphan_history_requires_review'));
    const printed = JSON.stringify(result);
    for (const value of [account.id, orphanId, 'Private fixture text', db.databaseName]) assert.equal(printed.includes(value), false);
    assert.deepEqual(await collections.energyLedger(db).find({}).sort({ _id: 1 }).toArray(), before);
    assert.deepEqual(await collections.energyLedger(db).indexes(), indexes);
    assert.deepEqual(await db.listCollections({}, { nameOnly: true }).toArray(), names);
    assert.deepEqual(await collections.atomicUsers(db).findOne({ _id: account.id }), wallet);
    const fixtureNames = ['fixture_preflight_legacy_order', 'fixture_preflight_sequence_order'];
    await collections.energyLedger(db).createIndex({ userId: 1, createdAt: -1, _id: -1 }, { name: fixtureNames[0] });
    try {
      await collections.energyLedger(db).createIndex({ userId: 1, historySequence: -1 }, { name: fixtureNames[1] });
      try {
        const readyIndexes = await collections.energyLedger(db).indexes();
        const ready = await inspectLedgerRetention(db);
        assert.equal(ready.orderingIndexReady, true); assert.equal(ready.sequenceOrderingIndexReady, true);
        assert.equal(ready.activationReady, false, 'usable indexes do not authorize activation');
        assert.equal(ready.rows, result.rows); assert.equal(ready.orphanRows, result.orphanRows);
        assert.deepEqual(ready.blockers, ['orphan_history_requires_review']);
        assert.deepEqual(await collections.energyLedger(db).indexes(), readyIndexes);
        assert.deepEqual(await collections.energyLedger(db).find({}).sort({ _id: 1 }).toArray(), before);
        assert.deepEqual(await collections.atomicUsers(db).findOne({ _id: account.id }), wallet);
      } finally { await collections.energyLedger(db).dropIndex(fixtureNames[1]); }
    } finally { await collections.energyLedger(db).dropIndex(fixtureNames[0]); }
    assert.deepEqual(await collections.energyLedger(db).indexes(), indexes);
    await collections.energyLedger(db).deleteMany({ userId: { $in: [account.id, orphanId] } });
  });

  await t.test('integrity preflight counts anomalies without exposing or changing their records', async () => {
    const { inspectLedgerRetention } = await import('../src/db/ledgerRetentionInspection');
    const { inspectLedgerIntegrity } = await import('../src/db/ledgerIntegrityInspection');
    const baseline = await inspectLedgerRetention(db);
    const accounts = await Promise.all(Array.from({ length: 9 }, () => user()));
    const [valid, excess, duplicate, gap, missingCounter, partial, unsupported, deepLegacy, empty] = accounts;
    const rawWallets = db.collection<{ _id: string; [key: string]: unknown }>('atomic_users');
    const rawRows = db.collection<{ _id: string; [key: string]: unknown }>('energy_ledger');
    const invalidOwner = 'private-invalid-wallet-id';
    await rawWallets.insertOne({ _id: invalidOwner } as any);
    const entry = (userId: string, historySequence?: number) => ({ _id: randomUUID(), userId,
      kind: 'admin_adjust', coinsDelta: 0, energyDelta: 0, resultingCoins: 5, resultingEnergy: 0,
      note: 'Private integrity fixture', createdAt: new Date(), ...(historySequence === undefined ? {} : { historySequence }) });
    for (const [account, sequences, counter] of [[valid, Array.from({ length: 50 }, (_, i) => 51 + i), 100],
      [excess, Array.from({ length: 51 }, (_, i) => i + 1), 51], [duplicate, [2, 2], 2], [gap, [1, 3], 3],
      [empty, [], 0]] as const) {
      await rawRows.deleteMany({ userId: account.id });
      if (sequences.length) await rawRows.insertMany(sequences.map(sequence => entry(account.id, sequence)));
      await rawWallets.updateOne({ _id: account.id } as any, { $set: { historyRetentionVersion: 1, historySequence: counter } });
    }
    await rawWallets.updateOne({ _id: missingCounter.id } as any, { $set: { historyRetentionVersion: 1 } });
    await rawWallets.updateOne({ _id: partial.id } as any, { $set: { historySequence: 7 } });
    await rawWallets.updateOne({ _id: unsupported.id } as any, { $set: { historyRetentionVersion: 2 } });
    await rawRows.insertMany([...Array.from({ length: 60 }, () => entry(deepLegacy.id)), entry(deepLegacy.id, 20)]);
    const orphanId = randomUUID();
    await rawRows.insertMany([{ ...entry(partial.id), energyDelta: 'malformed-private-value' },
      { ...entry(orphanId), createdAt: 'invalid-private-date' }, entry(orphanId)]);
    const beforeRows = await rawRows.find({}).sort({ _id: 1 }).toArray();
    const beforeWallets = await rawWallets.find({}).sort({ _id: 1 }).toArray();
    const beforeCatalog = await db.listCollections({}, { nameOnly: true }).toArray();
    const beforeIndexes = await rawRows.indexes();
    const result = await inspectLedgerRetention(db);
    assert.equal(result.walletAccounts, baseline.walletAccounts + 10);
    assert.equal(result.invalidWalletIdentities, baseline.invalidWalletIdentities + 1);
    assert.equal(result.orderedAccounts, baseline.orderedAccounts + 6);
    assert.equal(result.partialWalletAccounts, baseline.partialWalletAccounts + 2);
    assert.equal(result.invalidOrderedAccounts, baseline.invalidOrderedAccounts + 3);
    assert.equal(result.overLimitOrderedAccounts, baseline.overLimitOrderedAccounts + 1);
    assert.equal(result.malformedRows, baseline.malformedRows + 2);
    assert.equal(result.orphanRows, baseline.orphanRows + 2);
    assert.equal(result.sequencedUnmarkedRows, baseline.sequencedUnmarkedRows + 1);
    assert.equal(result.activationReady, false);
    for (const blocker of ['malformed_history_requires_review', 'wallet_metadata_requires_review',
      'ordered_history_requires_review', 'unmarked_sequence_rows_require_review', 'orphan_history_requires_review']) {
      assert.ok(result.blockers.includes(blocker));
    }
    const printed = JSON.stringify(result);
    for (const value of [...accounts.map(account => account.id), orphanId, invalidOwner, db.databaseName,
      'Private integrity fixture', 'malformed-private-value', 'invalid-private-date']) assert.equal(printed.includes(value), false);
    assert.deepEqual(await rawRows.find({}).sort({ _id: 1 }).toArray(), beforeRows);
    assert.deepEqual(await rawWallets.find({}).sort({ _id: 1 }).toArray(), beforeWallets);
    assert.deepEqual(await rawRows.indexes(), beforeIndexes);
    assert.deepEqual(await db.listCollections({}, { nameOnly: true }).toArray(), beforeCatalog);
    await withTransaction(async session => {
      await session.abortTransaction();
      await assert.rejects(() => inspectLedgerIntegrity(db, session), /transaction_required/);
    });
    await rawRows.deleteMany({ userId: { $in: [...accounts.map(account => account.id), orphanId] } });
    await rawWallets.deleteMany({ _id: { $in: [...accounts.map(account => account.id), invalidOwner] } } as any);
  });

  await t.test('preflight counts and integrity use one snapshot while a credit and metadata change commit', async () => {
    const { inspectLedgerRetention } = await import('../src/db/ledgerRetentionInspection');
    const account = await user(), before = await inspectLedgerRetention(db);
    let signal!: () => void, release!: () => void, anchored = false;
    const reached = new Promise<void>(resolve => { signal = resolve; });
    const resume = new Promise<void>(resolve => { release = resolve; });
    const pausedDb = new Proxy(db, {
      get(target, property) {
        if (property === 'collection') return (name: string) => {
          const collection = target.collection(name);
          return new Proxy(collection, {
            get(current, method) {
              if (name === 'energy_ledger' && method === 'aggregate' && !anchored) return (...args: any[]) => {
                anchored = true;
                const cursor = (current.aggregate as any)(...args);
                return new Proxy(cursor, {
                  get(currentCursor, cursorMethod) {
                    if (cursorMethod === 'toArray') return async () => {
                      const result = await currentCursor.toArray(); signal(); await resume; return result;
                    };
                    const value = Reflect.get(currentCursor, cursorMethod);
                    return typeof value === 'function' ? value.bind(currentCursor) : value;
                  },
                });
              };
              const value = Reflect.get(current, method);
              return typeof value === 'function' ? value.bind(current) : value;
            },
          });
        };
        const value = Reflect.get(target, property);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    }) as Db;
    const reading = inspectLedgerRetention(pausedDb);
    let snapshot: Awaited<ReturnType<typeof inspectLedgerRetention>> | undefined;
    let readError: unknown;
    void reading.catch(error => { readError = error; signal(); });
    try {
      await reached;
      if (readError) throw readError;
      assert.equal((await request('/admin/energy', 'POST', { user_id: account.id, coins_delta: 0,
        energy_delta: 1, request_id: randomUUID() }, undefined, 'test-admin-key')).status, 200);
      await db.collection('atomic_users').updateOne({ _id: account.id } as any,
        { $set: { historyRetentionVersion: 1, historySequence: 2 } }); // Deliberately damaged fixture after the credit.
    } finally { release(); snapshot = await reading; }
    assert.deepEqual(snapshot, before, 'every data section must retain the earlier snapshot');
    const current = await inspectLedgerRetention(db);
    assert.equal(current.rows, before.rows + 1);
    assert.equal(current.orderedAccounts, before.orderedAccounts + 1);
    assert.equal(current.invalidOrderedAccounts, before.invalidOrderedAccounts + 1);
    await db.collection('atomic_users').updateOne({ _id: account.id } as any,
      { $unset: { historyRetentionVersion: '', historySequence: '' } });
  });

  await t.test('owner isolation, partial updates and failed pushes', async () => {
    const original = row(); assert.equal((await push([original])).status, 200);
    const before = writes;
    assert.equal((await push([original], other.token)).status, 409);
    assert.equal(writes, before);
    assert.equal((await collections.notes(db).findOne({ _id: original.id }))!.userId, owner.id);
    assert.equal((await push([original, original])).status, 400);
    assert.equal((await push([{ ...original, pinned: true, base_version: 1 }])).status, 200);
    const metadata = (await collections.notes(db).findOne({ _id: original.id }))!;
    assert.equal(files.get(metadata.driveFileId).body, 'Keep body');
    assert.equal(files.get(metadata.driveFileId).title, 'Keep title');
    assert.equal(files.get(metadata.driveFileId).pinned, true);
    failTitle = 'FAIL';
    const response = await push([row({ title: 'Success' }), row({ title: 'FAIL' })]);
    assert.equal(response.status, 502);
    const result = await response.json() as { error: string; results: { ok: boolean }[] }; assert.equal(result.error, 'note_sync_failed');
    assert.deepEqual(result.results.map((r: any) => r.ok), [true, false]);
    failTitle = '';
  });

  await t.test('reviving a tombstone respects quota before Drive writes', async () => {
    const deleted = row({ deleted: true }); assert.equal((await push([deleted])).status, 200);
    const count = await collections.notes(db).countDocuments({ userId: owner.id, deleted: false });
    await collections.atomicUsers(db).updateOne({ _id: owner.id }, { $set: { noteLimit: count } });
    const before = writes;
    assert.equal((await push([{ ...deleted, deleted: false }])).status, 409); assert.equal(writes, before);
    await collections.atomicUsers(db).updateOne({ _id: owner.id }, { $set: { noteLimit: 20 } });
  });

  await t.test('pull bounds Drive requests and failed wipe retains metadata', async () => {
    assert.equal((await push(Array.from({ length: 7 }, () => row()))).status, 200);
    const response = await request('/notes/pull', 'GET', undefined, owner.token);
    assert.equal(response.status, 200); assert.ok(((await response.json()) as { cursor: string }).cursor);
    // A page's reads run together (one Drive round trip per page), never more than a page.
    assert.ok(peakReads <= 10); assert.ok(peakReads > 4, `peak reads in flight: ${peakReads}`);
    const count = await collections.notes(db).countDocuments({ userId: owner.id });
    failDelete = true;
    assert.equal((await request('/notes', 'DELETE', undefined, owner.token)).status, 500);
    assert.equal(await collections.notes(db).countDocuments({ userId: owner.id }), count);
    failDelete = false;
  });

  await t.test('wallet transactions roll back and concurrent daily grants apply once', async () => {
    const walletUser = await user();
    await energyEnsure(db, walletUser.id);
    assert.equal(await collections.energyLedger(db).countDocuments({ userId: walletUser.id }), 1);
    await energyConvert(db, walletUser.id, 1);
    await Promise.all([energyGrantDaily(db, walletUser.id), energyGrantDaily(db, walletUser.id)]);
    assert.equal((await collections.atomicUsers(db).findOne({ _id: walletUser.id }))!.energy, 60);
    assert.equal(await collections.energyLedger(db).countDocuments({ userId: walletUser.id, kind: 'daily_grant' }), 1);
    await assert.rejects(withTransaction(async (session) => {
      await collections.atomicUsers(db).updateOne({ _id: walletUser.id }, { $inc: { energy: 9 } }, { session });
      throw new Error('rollback_fixture');
    }), /rollback_fixture/);
    assert.equal((await collections.atomicUsers(db).findOne({ _id: walletUser.id }))!.energy, 60);
  });

  await t.test('daily energy keeps its time of day, pays missed days and stops at the cap', async () => {
    const HOUR = 60 * 60 * 1000, DAY = 24 * HOUR;
    const walletUser = await user();
    await energyEnsure(db, walletUser.id);
    const wallet = () => collections.atomicUsers(db).findOne({ _id: walletUser.id }).then((w) => w!);
    const set = (fields: object) => collections.atomicUsers(db).updateOne({ _id: walletUser.id }, { $set: fields });

    // Not due yet: 23 hours after the last grant, nothing changes.
    const recent = new Date(Date.now() - 23 * HOUR);
    await set({ energy: 10, lastDailyGrantAt: recent });
    await energyGrantDaily(db, walletUser.id);
    assert.equal((await wallet()).energy, 10);
    assert.equal((await wallet()).lastDailyGrantAt!.getTime(), recent.getTime());

    // Opened 3 days and 5 hours later: three grants, and the next one stays at the same time of day.
    const anchor = new Date(Date.now() - 3 * DAY - 5 * HOUR);
    await set({ energy: 0, lastDailyGrantAt: anchor });
    await energyGrantDaily(db, walletUser.id);
    let w = await wallet();
    assert.equal(w.energy, 60);
    assert.equal(w.lastDailyGrantAt!.getTime(), anchor.getTime() + 3 * DAY);
    const row = await collections.energyLedger(db).find({ userId: walletUser.id, kind: 'daily_grant' }).sort({ createdAt: -1 }).next();
    assert.equal(row!.energyDelta, 60);
    assert.equal(row!.note, 'Daily energy grant (3 days)');

    // Days owed are still limited by the cap.
    await set({ energy: 110, lastDailyGrantAt: new Date(Date.now() - 2 * DAY - HOUR) });
    await energyGrantDaily(db, walletUser.id);
    w = await wallet();
    assert.equal(w.energy, 120);

    // A second call right after pays nothing more.
    await energyGrantDaily(db, walletUser.id);
    assert.equal((await wallet()).energy, 120);
  });

  await t.test('Community notification CRUD hides targeted and expired messages', async () => {
    assert.equal((await request('/admin/notifications')).status, 401);
    const adminRequest = (method: string, body?: object, query = '') => request(`/admin/notifications${query}`, method, body, undefined, 'test-admin-key');
    const publicId = randomUUID();
    for (const fields of [ { id: publicId }, { target_user_id: owner.id }, { target_audience: 'active' }, { expires_at: '2020-01-01T00:00:00Z' } ]) {
      assert.equal((await adminRequest('POST', { type: 'info', subject: 'test', description: 'message', ...fields })).status, 200);
    }
    const visible = await (await request('/public/notifications/active')).json() as { rows: { id: string }[] };
    assert.deepEqual(visible.rows.map((n: any) => n.id), [publicId]);
    assert.equal((await adminRequest('PATCH', { id: publicId, status: 'resolved' })).status, 200);
    assert.deepEqual(((await (await request('/public/notifications/active')).json()) as { rows: unknown[] }).rows, []);
    assert.equal((await adminRequest('DELETE', undefined, `?id=${publicId}`)).status, 200);
    assert.equal(await collections.notifications(db).findOne({ _id: publicId }), null);
  });

  await t.test('literal email lookup, vault insert-only contract and session revocation', async () => {
    const account = await user('a+b@example.com');
    const energyResponse = await request('/energy', 'GET', undefined, account.token);
    assert.equal(energyResponse.status, 200);
    const state = await energyResponse.json() as { wallet: { energy_cap: number }; history: { coins_delta: number }[] };
    assert.equal(state.wallet.energy_cap, 120);
    assert.ok(state.history.some((entry) => entry.coins_delta === 5));
    assert.equal((await request('/atomicuser', 'PATCH', { username: 'test-user' }, account.token)).status, 200);
    for (const path of ['/admin/health', '/admin/stats']) {
      assert.equal((await request(path, 'GET', undefined, undefined, 'test-admin-key')).status, 200);
    }
    const lookup = await request('/admin/user?email=A%2BB%40EXAMPLE.COM', 'GET', undefined, undefined, 'test-admin-key');
    assert.equal(lookup.status, 200); assert.equal(((await lookup.json()) as { user_id: string }).user_id, account.id);
    // Adjustments are whole numbers within bounds, and a refused one changes nothing.
    const coinsBefore = (await collections.atomicUsers(db).findOne({ _id: account.id }))!.coins;
    for (const bad of [{ coins_delta: 0.5 }, { energy_delta: -1.25 }, { coins_delta: 1e9 }]) {
      const refused = await request('/admin/energy', 'POST', { user_id: account.id, ...bad }, undefined, 'test-admin-key');
      assert.equal(refused.status, 400, JSON.stringify(bad));
    }
    assert.equal((await collections.atomicUsers(db).findOne({ _id: account.id }))!.coins, coinsBefore);
    const granted = await request('/admin/energy', 'POST', { user_id: account.id, coins_delta: 2 }, undefined, 'test-admin-key');
    assert.equal(granted.status, 200); assert.equal(((await granted.json()) as { coins: number }).coins, coinsBefore + 2);
    // The App shows the note in the user's Activity: the default is written for them, not for the operator.
    const [lastEntry] = await collections.energyLedger(db).find({ userId: account.id }).sort({ createdAt: -1 }).limit(1).toArray();
    assert.equal(lastEntry.note, 'Balance adjusted by Atomic Notes');
    const vaultBody = { verifier: 'test-verifier', kdfMemory: 65536, kdfIterations: 3, kdfParallelism: 1 };
    assert.equal((await request('/vault', 'POST', vaultBody, account.token)).status, 201);
    assert.equal((await request('/vault', 'POST', vaultBody, account.token)).status, 409);
    const session = await collections.sessions(db).findOne({ _id: createHash('sha256').update(account.token).digest('hex') });
    assert.ok(session); assert.notEqual(session._id, account.token);
    assert.equal((await request('/auth/logout', 'POST', undefined, account.token)).status, 200);
    assert.equal(await verifySession(db, account.token), null);
    assert.equal((await request('/vault', 'GET', undefined, account.token)).status, 401);
  });

  const wallet = async (id: string) => (await collections.atomicUsers(db).findOne({ _id: id }))!;
  const json = async (response: Response) => await response.json() as any;
  const refundCount = (id: string) => collections.energyLedger(db).countDocuments({ userId: id, note: /^Refund/ });

  await t.test('R27 admin notification pages are bounded and keep equal-time rows', async () => {
    const { notificationSchema } = await import('../src/db/collections');
    const original = await collections.notifications(db).find({}).toArray();
    const fixtures = Array.from({ length: 131 }, (_, i) => notificationSchema.parse({
      _id: randomUUID(), type: 'general', subject: `page ${i}`, description: 'fixture',
      status: (['active', 'resolved', 'expired'] as const)[i % 3],
      createdAt: new Date(i < 67 ? '2050-01-02T00:00:00.000Z' : '2050-01-01T00:00:00.000Z'),
    }));
    await collections.notifications(db).insertMany(fixtures);
    const list = async (query = '') => {
      const response = await request(`/admin/notifications${query}`, 'GET', undefined, undefined, 'test-admin-key');
      assert.equal(response.status, 200);
      return json(response) as Promise<{ rows: { id: string; reads: number; recipients: number | null }[]; next_cursor: string | null }>;
    };
    try {
      const first = await list();
      assert.equal(first.rows.length, 50, 'default page must not materialize all notification history');
      assert.equal(typeof first.next_cursor, 'string');
      assert.ok(first.rows.every((n) => n.reads === 0 && n.recipients === null));
      const expected = [...original, ...fixtures].sort((a, b) =>
        b.createdAt.getTime() - a.createdAt.getTime() || (a._id < b._id ? 1 : a._id > b._id ? -1 : 0));
      const seen: string[] = [];
      let cursor: string | null = null;
      do {
        const page = await list(`?limit=17${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
        assert.ok(page.rows.length <= 17);
        seen.push(...page.rows.map((n) => n.id));
        cursor = page.next_cursor;
        assert.ok(seen.length <= expected.length, 'cursor must make forward progress');
      } while (cursor);
      assert.deepEqual(seen, expected.map((n) => n._id));
      assert.equal(new Set(seen).size, seen.length);
    } finally {
      await collections.notifications(db).deleteMany({ _id: { $in: fixtures.map((n) => n._id) } });
    }
  });

  await t.test('R27 admin pagination validates input after authorization', async () => {
    assert.equal((await request('/admin/notifications?cursor=not-json')).status, 401);
    for (const query of ['?limit=0', '?limit=51', '?limit=-1', '?limit=1.5', '?limit=abc',
      '?cursor=not-json', `?cursor=${'x'.repeat(513)}`,
      `?cursor=${Buffer.from(JSON.stringify({ created_at: 'invalid', id: randomUUID() })).toString('base64url')}`]) {
      assert.equal((await request(`/admin/notifications${query}`, 'GET', undefined, undefined, 'test-admin-key')).status, 400, query);
    }
  });

  await t.test('R27 admin cursor survives deletion of the page boundary', async () => {
    const { notificationSchema } = await import('../src/db/collections');
    const fixtures = Array.from({ length: 3 }, (_, i) => notificationSchema.parse({
      _id: randomUUID(), type: 'general', subject: `boundary ${i}`, description: 'fixture',
      createdAt: new Date('2051-01-01T00:00:00.000Z'),
    }));
    fixtures.sort((a, b) => a._id < b._id ? 1 : -1);
    await collections.notifications(db).insertMany(fixtures);
    try {
      const first = await json(await request('/admin/notifications?limit=1', 'GET', undefined, undefined, 'test-admin-key'));
      assert.equal(first.rows[0].id, fixtures[0]._id);
      assert.equal(typeof first.next_cursor, 'string');
      await collections.notifications(db).deleteOne({ _id: first.rows[0].id });
      const next = await json(await request(`/admin/notifications?limit=1&cursor=${encodeURIComponent(first.next_cursor)}`, 'GET', undefined, undefined, 'test-admin-key'));
      assert.equal(next.rows[0].id, fixtures[1]._id);
    } finally {
      await collections.notifications(db).deleteMany({ _id: { $in: fixtures.map((n) => n._id) } });
    }
  });

  await t.test('a finished request is replayed from its record even when quota and Google state changed', async () => {
    const account = await user(), requestId = randomUUID(), rows = [row()];
    const first = await push(rows, account.token, requestId);
    assert.equal(first.status, 200);
    const firstBody = await json(first);
    assert.equal(firstBody.charged, 5);
    const energy = (await wallet(account.id)).energy, before = writes;
    await collections.atomicUsers(db).updateOne({ _id: account.id }, { $set: { noteLimit: 0 } });
    await collections.googleAccounts(db).deleteOne({ userId: account.id });
    const second = await push(rows, account.token, requestId);
    assert.equal(second.status, 200);
    assert.deepEqual(await json(second), firstBody);
    assert.equal(writes, before);
    assert.equal((await wallet(account.id)).energy, energy);
    assert.equal((await push([{ ...rows[0], title: 'changed' }], account.token, requestId)).status, 409);
  });

  await t.test('concurrent duplicates of one request charge and write once', async () => {
    const account = await user(), requestId = randomUUID(), rows = [row()], before = writes;
    const [a, b] = await Promise.all([push(rows, account.token, requestId), push(rows, account.token, requestId)]);
    assert.deepEqual([a.status, b.status], [200, 200]);
    assert.deepEqual(await json(a), await json(b));
    assert.equal(writes, before + 1);
    assert.equal((await wallet(account.id)).energy, 15);
    assert.equal(await collections.energyLedger(db).countDocuments({ userId: account.id, kind: 'spend' }), 1);
  });

  await t.test('a batch where every note fails is refunded once and restores the free window', async () => {
    const account = await user(), requestId = randomUUID(), rows = [row({ title: 'FAIL' }), row({ title: 'FAIL' })];
    failTitle = 'FAIL';
    try {
      const first = await push(rows, account.token, requestId);
      assert.equal(first.status, 502);
      const body = await json(first);
      assert.deepEqual(body.results.map((r: any) => r.ok), [false, false]);
      assert.deepEqual([body.charged, body.refunded], [5, 5]);
      const after = await wallet(account.id);
      assert.equal(after.energy, 20);
      assert.equal(after.lastStandardSyncAt, null);
      assert.equal(await refundCount(account.id), 1);
      const again = await push(rows, account.token, requestId);
      assert.equal(again.status, 502);
      assert.deepEqual(await json(again), body);
      assert.equal((await wallet(account.id)).energy, 20);
      assert.equal(await refundCount(account.id), 1);
    } finally { failTitle = ''; }
  });

  for (const mode of ['standard', 'instant'] as const) {
    for (const room of [0, 3]) {
      await t.test(`refund receipt: ${mode} with ${room} energy room settles once and stays historical on replay`, async () => {
        const account = await user(), requestId = randomUUID(), rows = [row()];
        // Model a request that charged but died before committing a row. The
        // Controller can credit the wallet while that operation is pending.
        const operation = await beginSync(db, account.id, requestId,
          rows.map((value) => remoteNoteRowSchema.parse(value)), mode);
        const charged = mode === 'instant' ? 10 : 5;
        assert.equal(operation.charged, charged);
        const beforeGrant = await wallet(account.id);
        const grant = await request('/admin/energy', 'POST', {
          user_id: account.id, request_id: randomUUID(),
          energy_delta: beforeGrant.energyCap - room - beforeGrant.energy,
        }, undefined, 'test-admin-key');
        assert.equal(grant.status, 200);
        assert.equal((await wallet(account.id)).energy, beforeGrant.energyCap - room);

        const [first, concurrent] = await Promise.all([
          finishSync(db, operation), finishSync(db, operation),
        ]);
        assert.deepEqual(first, concurrent);
        assert.equal(first.status, 'complete');
        assert.deepEqual([first.charged, first.refunded], [charged, room]);
        assert.equal(first.results[0].error, 'note_write_interrupted');
        assert.equal((await wallet(account.id)).energy, beforeGrant.energyCap);
        assert.equal((await wallet(account.id)).lastStandardSyncAt, null);
        const refunds = await collections.energyLedger(db).find({ userId: account.id, note: /^Refund/ }).toArray();
        assert.equal(refunds.length, room > 0 ? 1 : 0);
        assert.equal(refunds.reduce((total, item) => total + item.energyDelta, 0), room);
        assert.equal(await collections.energyLedger(db).countDocuments({ userId: account.id, kind: 'spend' }), 1);
        assert.equal(await collections.notes(db).countDocuments({ userId: account.id }), 0);

        // Room appearing later must not cause another refund or a larger
        // historical receipt. Exercise replay through the actual HTTP route.
        const lowered = await request('/admin/energy', 'POST', {
          user_id: account.id, request_id: randomUUID(), energy_delta: -20,
        }, undefined, 'test-admin-key');
        assert.equal(lowered.status, 200);
        const beforeReplay = await wallet(account.id), beforeWrites = writes;
        for (let attempt = 0; attempt < 2; attempt++) {
          const replay = await push(rows, account.token, requestId, mode);
          assert.equal(replay.status, 502);
          const body = await json(replay);
          assert.deepEqual([body.charged, body.refunded], [charged, room]);
          assert.deepEqual(body.results, first.results);
          assert.equal((await wallet(account.id)).energy, beforeReplay.energy);
          assert.equal(await refundCount(account.id), room > 0 ? 1 : 0);
        }
        assert.equal(writes, beforeWrites);
        assert.equal(await collections.energyLedger(db).countDocuments({ userId: account.id, kind: 'spend' }), 1);
      });
    }
  }

  await t.test('a partly successful batch keeps its charge', async () => {
    const account = await user();
    failTitle = 'FAIL';
    try {
      const response = await push([row({ title: 'fine' }), row({ title: 'FAIL' })], account.token);
      assert.equal(response.status, 502);
      const body = await json(response);
      assert.deepEqual([body.charged, body.refunded], [5, 0]);
      assert.equal((await wallet(account.id)).energy, 15);
      assert.equal(await refundCount(account.id), 0);
    } finally { failTitle = ''; }
  });

  await t.test('version conflicts are reported per note, not overwritten, and resolve with the current version', async () => {
    const account = await user(), note = row();
    const created = await json(await push([note], account.token));
    assert.equal(created.results[0].version, 1);
    await refill(account.id);
    const stale = await push([{ ...note, title: 'stale', base_version: 0 }], account.token);
    assert.equal(stale.status, 502);
    const staleBody = await json(stale);
    assert.equal(staleBody.results[0].error, 'note_conflict');
    assert.equal(staleBody.results[0].version, 1);
    const stored = (await collections.notes(db).findOne({ _id: note.id }))!;
    assert.equal(files.get(stored.driveFileId).title, 'Keep title');
    await refill(account.id);
    const fresh = await json(await push([{ ...note, title: 'fresh', base_version: 1 }], account.token));
    assert.equal(fresh.results[0].version, 2);
    assert.equal(files.get(stored.driveFileId).title, 'fresh');
  });

  await t.test('single-note REST writes are closed: notes are written through push, where sync is charged', async () => {
    const account = await user(), note = row();
    assert.equal((await push([note], account.token)).status, 200);
    const before = writes;
    for (const [path, method, body] of [['/notes', 'POST', row()], [`/notes/${note.id}`, 'PATCH', { pinned: true, base_version: 1 }]] as const) {
      const closed = await request(path, method, body, account.token);
      assert.equal(closed.status, 410);
      assert.equal((await json(closed)).error, 'use_push');
    }
    assert.equal(writes, before);
    assert.equal((await collections.notes(db).findOne({ _id: note.id }))!.pinned, false);
  });

  await t.test('pull pages by sequence cursor and reports deletions after the cursor', async () => {
    const account = await user(), notes = Array.from({ length: 12 }, () => row());
    const pushed = await push(notes, account.token);
    assert.equal(pushed.status, 200);
    // Each written row reports its sequence, consecutive within one push: the App uses this to skip its own echo.
    assert.deepEqual((await json(pushed)).results.map((r: any) => r.seq), Array.from({ length: 12 }, (_, i) => i + 1));
    const pull = async (query = '') => json(await request(`/notes/pull${query}`, 'GET', undefined, account.token));
    const first = await pull();
    assert.equal(first.rows.length, 10); assert.equal(first.hasMore, true);
    const second = await pull(`?after=${first.nextCursor}`);
    assert.equal(second.rows.length, 2); assert.equal(second.hasMore, false);
    assert.deepEqual([...first.rows, ...second.rows].map((r: any) => r.id), notes.map((n) => n.id));
    const third = await pull(`?after=${second.nextCursor}`);
    assert.deepEqual([third.rows.length, third.hasMore, third.nextCursor], [0, false, second.nextCursor]);
    await refill(account.id);
    assert.equal((await push([{ ...notes[0], deleted: true, base_version: 1 }], account.token)).status, 200);
    const fourth = await pull(`?after=${third.nextCursor}`);
    assert.deepEqual(fourth.rows.map((r: any) => [r.id, r.deleted]), [[notes[0].id, true]]);
    // A deleted note keeps its content (its Drive file is only in the trash) so a Recycle Bin can restore it.
    assert.equal(fourth.rows[0].title, 'Keep title');
    assert.equal(fourth.rows[0].body, 'Keep body');
  });

  await t.test('R5 recreated notes advance beyond pre-wipe versions and reject stale edits', async () => {
    const account = await user(), note = row();
    let version = 0;
    for (let edit = 1; edit <= 5; edit++) {
      await refill(account.id);
      const response = await push([{ ...note, title: `before wipe ${edit}`, base_version: version }], account.token);
      assert.equal(response.status, 200);
      version = (await json(response)).results[0].version;
    }
    const heldByOtherDevice = version;
    const before = await json(await request('/notes/pull', 'GET', undefined, account.token));
    for (let cycle = 1; cycle <= 2; cycle++) {
      assert.equal((await request('/notes', 'DELETE', undefined, account.token)).status, 200);
      assert.equal(await collections.notes(db).countDocuments({ userId: account.id }), 0, 'wipe must not create local-deletion tombstones');
      const empty = await json(await request(`/notes/pull?after=${before.nextCursor}`, 'GET', undefined, account.token));
      assert.deepEqual(empty.rows, []);
      await refill(account.id);
      const recreated = await push([{ ...note, title: `after wipe ${cycle}`, base_version: 0 }], account.token);
      assert.equal(recreated.status, 200);
      const result = (await json(recreated)).results[0];
      assert.ok(result.version > version, `recreated version ${result.version} must exceed cached version ${version}`);
      const pulled = await json(await request(`/notes/pull?after=${empty.nextCursor}`, 'GET', undefined, account.token));
      assert.equal(pulled.rows[0].version, result.version);
      assert.equal(pulled.rows[0].title, `after wipe ${cycle}`);
      assert.ok(pulled.nextCursor > empty.nextCursor);
      version = result.version;
      await refill(account.id);
      const beforeWrites = writes;
      const stale = await push([{ ...note, title: 'stale device', base_version: heldByOtherDevice }], account.token);
      assert.equal(stale.status, 502);
      assert.equal((await json(stale)).results[0].error, 'note_conflict');
      assert.equal(writes, beforeWrites);
    }
  });

  await t.test('R11 pull rejects Drive content written ahead of its metadata commit', async () => {
    const account = await user(), note = row({ title: 'committed title' });
    assert.equal((await push([note], account.token)).status, 200);
    await refill(account.id);
    let release!: () => void, entered!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const stored = new Promise<void>((resolve) => { entered = resolve; });
    afterUpdateWrite = async () => { entered(); await blocked; };
    const pushing = push([{ ...note, title: 'uncommitted title', base_version: 1 }], account.token);
    let completed: Response;
    try {
      await stored;
      const response = await request('/notes/pull?after=0', 'GET', undefined, account.token);
      assert.equal(response.status, 409);
      const body = await json(response);
      assert.deepEqual(body, { error: 'note_content_mismatch' });
      assert.ok(!JSON.stringify(body).includes('uncommitted title'));
      assert.equal((await collections.notes(db).findOne({ _id: note.id }))!.localVersion, 1);
    } finally { afterUpdateWrite = null; release(); completed = await pushing; }
    assert.equal(completed.status, 200);
    const retry = await request('/notes/pull?after=0', 'GET', undefined, account.token);
    assert.equal(retry.status, 200);
    const rows = (await json(retry)).rows;
    assert.deepEqual(rows.map((r: any) => [r.version, r.title]), [[2, 'uncommitted title']]);
  });

  await t.test('R11 pull rejects persistent ciphertext mismatch without returning content or advancing a cursor', async () => {
    const account = await user(), note = row({ enc_v: 1, payload: 'fixture-cipher-a', title: '', body: '', items: [] });
    assert.equal((await push([note], account.token)).status, 200);
    const metadata = (await collections.notes(db).findOne({ _id: note.id }))!;
    const committed = structuredClone(files.get(metadata.driveFileId));
    files.set(metadata.driveFileId, { ...committed, payload: 'fixture-cipher-b' });
    try {
      for (let retry = 0; retry < 2; retry++) {
        const response = await request('/notes/pull?after=0', 'GET', undefined, account.token);
        assert.equal(response.status, 409);
        assert.deepEqual(await json(response), { error: 'note_content_mismatch' });
      }
      assert.equal((await collections.notes(db).findOne({ _id: note.id }))!.contentHash, metadata.contentHash);
      assert.equal(files.get(metadata.driveFileId).payload, 'fixture-cipher-b', 'pull must not rewrite Drive');
    } finally { files.set(metadata.driveFileId, committed); }
    const retry = await request('/notes/pull?after=0', 'GET', undefined, account.token);
    assert.equal(retry.status, 200);
    assert.equal((await json(retry)).rows[0].payload, 'fixture-cipher-a');
  });

  await t.test('R11 pull rejects a different note ID even when the content fingerprint matches', async () => {
    const account = await user(), note = row();
    assert.equal((await push([note], account.token)).status, 200);
    const metadata = (await collections.notes(db).findOne({ _id: note.id }))!;
    const committed = structuredClone(files.get(metadata.driveFileId));
    files.set(metadata.driveFileId, { ...committed, id: randomUUID() });
    try {
      const response = await request('/notes/pull?after=0', 'GET', undefined, account.token);
      assert.equal(response.status, 409);
      assert.deepEqual(await json(response), { error: 'note_content_mismatch' });
    } finally { files.set(metadata.driveFileId, committed); }
  });

  await t.test('pull fingerprint compatibility covers normalized checklists and legacy rows without hashes', async () => {
    const account = await user(), note = row({ kind: 'todo', items: [{ t: 'fixture item', d: true }] });
    assert.equal((await push([note], account.token)).status, 200);
    const pull = async () => {
      const response = await request('/notes/pull?after=0', 'GET', undefined, account.token);
      assert.equal(response.status, 200);
      assert.deepEqual((await json(response)).rows[0].items, [{ text: 'fixture item', done: true }]);
    };
    await pull();
    await collections.notes(db).updateOne({ _id: note.id }, { $unset: { contentHash: '' } });
    await pull();
  });

  await t.test('concurrent creates cannot exceed the note quota', async () => {
    const account = await user();
    await collections.atomicUsers(db).updateOne({ _id: account.id }, { $set: { noteLimit: 1 } });
    const responses = await Promise.all([push([row()], account.token), push([row()], account.token)]);
    assert.deepEqual(responses.map((r) => r.status).sort(), [200, 409]);
    assert.equal(await collections.notes(db).countDocuments({ userId: account.id, deleted: false }), 1);
  });

  await t.test('concurrent vault creation returns one 201 and one 409', async () => {
    const account = await user(), body = { verifier: 'v', kdfMemory: 65536, kdfIterations: 3, kdfParallelism: 1 };
    const statuses = (await Promise.all([request('/vault', 'POST', body, account.token), request('/vault', 'POST', body, account.token)])).map((r) => r.status);
    assert.deepEqual(statuses.sort(), [201, 409]);
  });

  await t.test('operations abandoned by a dead request are settled from stored results, never guessed', async () => {
    const account = await user();
    // 1) Nothing committed: the charge is refunded and the next request proceeds.
    const lost = [row(), row()], lostId = randomUUID();
    // The route fingerprints zod-parsed rows, so a later retry through HTTP must match these.
    const parse = (rows: object[]) => rows.map((r) => remoteNoteRowSchema.parse(r));
    const lostOp = await beginSync(db, account.id, lostId, parse(lost), 'standard');
    assert.equal(lostOp.charged, 5); assert.equal((await wallet(account.id)).energy, 15);
    const next = await push([row()], account.token);
    assert.equal(next.status, 200);
    const settled = (await syncOperations(db).findOne({ _id: lostOp._id }))!;
    assert.equal(settled.status, 'complete');
    assert.deepEqual(settled.results.map((r) => r.error), ['note_write_interrupted', 'note_write_interrupted']);
    assert.equal(settled.refunded, 5);
    assert.equal(await refundCount(account.id), 1);
    assert.equal((await wallet(account.id)).energy, 15); // refunded 5, charged 5 for the new request
    assert.equal((await push(lost, account.token, lostId)).status, 502); // a late retry sees the recorded outcome

    // 2) One note committed before the crash: no refund, and a recorded failure cannot override the stored success.
    const committed = row(), missing = row(), partialId = randomUUID();
    await collections.atomicUsers(db).updateOne({ _id: account.id }, { $set: { energy: 100 } });
    const partial = await beginSync(db, account.id, partialId, parse([committed, missing]), 'instant');
    const fields = { userId: account.id, kind: 'text' as const, pinned: false, deleted: false, encV: 0 as const, driveFileId: 'file-x', driveRevisionId: null,
      updatedAt: new Date(), lastSyncedAt: new Date(), syncStatus: 'synced' as const };
    await saveNoteMetadata(db, account.id, committed.id, fields, { _id: committed.id, ...fields, folderId: null, createdAt: new Date(), localVersion: 1 }, partial._id);
    await recordSyncResult(db, partial, { id: committed.id, ok: false, error: 'note_write_failed' });
    const energyBefore = (await wallet(account.id)).energy;
    assert.equal((await request('/notes/count', 'GET', undefined, account.token)).status, 200); // GET does not settle
    assert.equal((await syncOperations(db).findOne({ _id: partial._id }))!.status, 'pending');
    assert.equal((await push([row()], account.token, randomUUID(), 'instant')).status, 200); // a new push does
    const outcome = (await syncOperations(db).findOne({ _id: partial._id }))!;
    assert.deepEqual(outcome.results.map((r) => [r.id, r.ok]), [[committed.id, true], [missing.id, false]]);
    assert.equal(outcome.refunded, 0);
    assert.equal((await wallet(account.id)).energy, energyBefore - 10); // only the new instant push was charged

    // 3) A closed operation refuses further commits, so a late request cannot write unaccounted metadata.
    const late = row();
    await assert.rejects(saveNoteMetadata(db, account.id, late.id, fields, { _id: late.id, ...fields, folderId: null, createdAt: new Date(), localVersion: 1 }, partial._id), /sync_operation_closed/);
    assert.equal(await collections.notes(db).findOne({ _id: late.id }), null);
  });

  for (const failure of ['missing', 'corrupt'] as const) {
    await t.test(`R16 ${failure} live file refuses its page and a repaired file returns at the same cursor`, async () => {
      const account = await user();
      const notes = Array.from({ length: 12 }, (_, i) => row({ title: `fixture ${i}` }));
      assert.equal((await push(notes, account.token)).status, 200);
      const metadata = await collections.notes(db).find({ userId: account.id }).sort({ syncSequence: 1 }).toArray();
      const broken = metadata[10];
      const original = structuredClone(files.get(broken.driveFileId));
      const counter = await db.collection('sync_counters').findOne({ _id: account.id } as any);
      const beforeWrites = writes;
      if (failure === 'missing') missingFiles.add(broken.driveFileId);
      else files.set(broken.driveFileId, { version: 999 });
      let cursor: number;
      try {
        const first = await request('/notes/pull?after=0', 'GET', undefined, account.token);
        assert.equal(first.status, 200);
        const page = await json(first);
        assert.equal(page.rows.length, 10);
        assert.equal(page.hasMore, true);
        cursor = page.nextCursor;
        for (let attempt = 0; attempt < 2; attempt++) {
          const response = await request(`/notes/pull?after=${cursor}`, 'GET', undefined, account.token);
          assert.equal(response.status, 409, 'unreadable live content must not advance the cursor');
          assert.deepEqual(await json(response), { error: 'note_content_unavailable' });
        }
        assert.deepEqual(await collections.notes(db).find({ userId: account.id }).sort({ syncSequence: 1 }).toArray(), metadata);
        assert.deepEqual(await db.collection('sync_counters').findOne({ _id: account.id } as any), counter);
        assert.equal(writes, beforeWrites, 'pull must not modify Drive');
      } finally {
        missingFiles.delete(broken.driveFileId);
        files.set(broken.driveFileId, original);
      }
      // Restore only the fixture file, without editing the note or allocating a new sequence.
      const retry = await request(`/notes/pull?after=${cursor!}`, 'GET', undefined, account.token);
      assert.equal(retry.status, 200);
      const recovered = await json(retry);
      assert.deepEqual(recovered.rows.map((r: any) => r.id), metadata.slice(10).map((m) => m._id));
      assert.equal(recovered.nextCursor, counter!.value);
      assert.equal(recovered.hasMore, false);
      assert.equal(recovered.skipped, 0);
      assert.equal(writes, beforeWrites);
    });

    await t.test(`R16 ${failure} tombstone still delivers a deletion without content`, async () => {
      const account = await user(), note = row();
      assert.equal((await push([note], account.token)).status, 200);
      await refill(account.id);
      assert.equal((await push([{ ...note, deleted: true, base_version: 1 }], account.token)).status, 200);
      const metadata = (await collections.notes(db).findOne({ _id: note.id }))!;
      const original = structuredClone(files.get(metadata.driveFileId));
      if (failure === 'missing') missingFiles.add(metadata.driveFileId);
      else files.set(metadata.driveFileId, { version: 999 });
      try {
        const response = await request('/notes/pull?after=1', 'GET', undefined, account.token);
        assert.equal(response.status, 200);
        const page = await json(response);
        assert.equal(page.rows.length, 1);
        assert.equal(page.rows[0].id, note.id);
        assert.equal(page.rows[0].deleted, true);
        assert.equal(page.rows[0].title, '');
        assert.equal(page.rows[0].body, '');
        assert.equal(page.rows[0].payload, null);
        assert.equal(page.nextCursor, metadata.syncSequence);
        assert.equal(page.skipped, 0);
      } finally {
        missingFiles.delete(metadata.driveFileId);
        files.set(metadata.driveFileId, original);
      }
    });
  }

  await t.test('files and folders deleted in Drive: pull refuses live omissions, push recreates them, wipe tolerates them', async () => {
    const account = await user(), a = row({ title: 'A' }), b = row({ title: 'B' });
    assert.equal((await push([a, b], account.token)).status, 200);
    const meta = async (id: string) => (await collections.notes(db).findOne({ _id: id }))!;
    const oldFileOfA = (await meta(a.id)).driveFileId;
    missingFiles.add(oldFileOfA);

    // Pull refuses an incomplete page; a later push can still recreate the missing file.
    const pulled = await request('/notes/pull', 'GET', undefined, account.token);
    assert.equal(pulled.status, 409);
    assert.deepEqual(await json(pulled), { error: 'note_content_unavailable' });
    assert.equal(await collections.logs(db).countDocuments({ userId: account.id, event: 'notes_unreadable' }), 1);

    // The next edit writes the note to a new file and records it.
    await refill(account.id);
    const edited = await push([{ ...a, title: 'A edited', base_version: 1 }], account.token);
    assert.equal(edited.status, 200);
    const repaired = await meta(a.id);
    assert.notEqual(repaired.driveFileId, oldFileOfA);
    assert.equal(files.get(repaired.driveFileId).title, 'A edited');
    const again = await json(await request('/notes/pull', 'GET', undefined, account.token));
    assert.deepEqual(again.rows.map((r: any) => r.id).sort(), [a.id, b.id].sort());
    assert.equal(again.skipped, 0);

    // Deleting a note whose file is already gone needs no new file.
    missingFiles.add(repaired.driveFileId);
    const before = writes;
    await refill(account.id);
    assert.equal((await push([{ ...a, deleted: true, base_version: 2 }], account.token)).status, 200);
    assert.equal(writes, before);
    assert.equal((await meta(a.id)).deleted, true);

    // The app folder itself is gone: it is recreated once and the note lands in the new folder.
    missingFolder = 'test-folder';
    const c = row({ title: 'C' });
    await refill(account.id);
    assert.equal((await push([c], account.token)).status, 200);
    assert.equal(foldersEnsured, 1);
    assert.equal((await collections.googleAccounts(db).findOne({ userId: account.id }))!.driveRootFolderId, 'recreated-folder');
    assert.equal(await collections.logs(db).countDocuments({ userId: account.id, event: 'drive_folder_recreated' }), 1);

    const preWipeVersion = (await meta(c.id)).localVersion;
    // Wiping an account must not fail because some files are already gone.
    missingFiles.add((await meta(b.id)).driveFileId);
    const wiped = await request('/notes', 'DELETE', undefined, account.token);
    assert.equal(wiped.status, 200);
    assert.ok((await json(wiped)).deleted >= 3);
    // A cloud wipe leaves no tombstones: a pull must not tell any device to delete its own local notes.
    assert.equal(await collections.notes(db).countDocuments({ userId: account.id }), 0);
    const afterWipe = await json(await request('/notes/pull?after=0', 'GET', undefined, account.token));
    assert.deepEqual(afterWipe.rows, []);
    // The account keeps working: a device that still holds a note writes it again with its old version.
    await refill(account.id);
    const restored = await push([{ ...c, base_version: preWipeVersion }], account.token);
    assert.equal(restored.status, 200);
    const restoredVersion = (await json(restored)).results[0].version;
    assert.ok(restoredVersion > preWipeVersion);
    assert.equal((await meta(c.id)).localVersion, restoredVersion);
  });

  await t.test('round trips: one-note sync operations stay within a small database command budget', async () => {
    // Each command is a network round trip in production; a function far from Atlas pays ~200 ms for each.
    const commands = async (work: () => Response | Promise<Response>) => {
      const before = mongoCommands.started;
      const response = await work();
      assert.ok(response.status < 300, `status ${response.status}`);
      return mongoCommands.started - before;
    };
    const account = await user();
    const counts = {
      firstPush: await commands(() => push([row()], account.token)),         // charges, grants the daily energy, creates a note
      instantPush: await commands(() => push([row()], account.token, randomUUID(), 'instant')), // charges 10
      pullOneRow: await commands(() => request('/notes/pull?after=1', 'GET', undefined, account.token)),  // one note to read from Drive
      pullNothing: await commands(() => request('/notes/pull?after=99', 'GET', undefined, account.token)),
      count: await commands(() => request('/notes/count', 'GET', undefined, account.token)),
    };
    const refusedFrom = mongoCommands.started;
    assert.equal((await push([row()], account.token)).status, 429); // inside the hour: refused before any charge
    (counts as Record<string, number>).cooldownPush = mongoCommands.started - refusedFrom;
    console.log('MONGO COMMANDS PER OPERATION', JSON.stringify(counts));
    for (const [name, limit] of Object.entries(BUDGET)) assert.ok((counts as Record<string, number>)[name] <= limit, `${name}: ${(counts as Record<string, number>)[name]} commands, budget ${limit}`);
  });

  await t.test('a revoked Google grant answers 401 google_reauth_required; the same request resumes after sign-in without a second charge', async () => {
    const account = await user(), first = row({ title: 'Before revoke' });
    assert.equal((await push([first], account.token)).status, 200);
    assert.equal((await wallet(account.id)).energy, 15);

    revoked = true;
    try {
      const pull = await request('/notes/pull', 'GET', undefined, account.token);
      assert.equal(pull.status, 401);
      assert.equal((await json(pull)).error, 'google_reauth_required');

      const requestId = randomUUID(), rows = [row({ title: 'During revoke' })];
      const denied = await push(rows, account.token, requestId, 'instant');
      assert.equal(denied.status, 401);
      assert.equal((await json(denied)).error, 'google_reauth_required');
      assert.equal(await collections.notes(db).countDocuments({ userId: account.id }), 1); // only the first note exists
      assert.equal((await wallet(account.id)).energy, 5); // the instant sync was accepted and charged, and is still open
      assert.equal((await syncOperations(db).findOne({ _id: `${account.id}:${requestId}` }))!.status, 'pending');

      revoked = false; // the user signed in again
      const resumed = await push(rows, account.token, requestId, 'instant');
      assert.equal(resumed.status, 200);
      const body = await json(resumed);
      assert.deepEqual([body.charged, body.refunded], [10, 0]);
      assert.equal((await wallet(account.id)).energy, 5); // no second charge
      assert.equal(await collections.energyLedger(db).countDocuments({ userId: account.id, kind: 'spend' }), 2);
      assert.equal((await syncOperations(db).findOne({ _id: `${account.id}:${requestId}` }))!.status, 'complete');
    } finally { revoked = false; }
  });

  await t.test('a standard sync starts once per hour; instant sync is always open; a refused sync costs nothing', async () => {
    const account = await user(), first = row(), second = row(), third = row(), requestId = randomUUID();
    const paid = await push([first], account.token, requestId);
    assert.equal(paid.status, 200); assert.equal((await json(paid)).charged, 5);
    const energy = (await wallet(account.id)).energy, before = writes;
    const operations = await syncOperations(db).countDocuments({ userId: account.id });

    const refused = await push([second], account.token);
    assert.equal(refused.status, 429);
    const body = await json(refused);
    assert.equal(body.error, 'sync_cooldown');
    assert.ok(body.retry_after_seconds > 3500 && body.retry_after_seconds <= 3600, `retry after ${body.retry_after_seconds}`);
    assert.equal(refused.headers.get('retry-after'), String(body.retry_after_seconds));
    assert.equal(writes, before);
    assert.equal((await wallet(account.id)).energy, energy);
    assert.equal(await syncOperations(db).countDocuments({ userId: account.id }), operations);
    assert.equal(await collections.notes(db).countDocuments({ _id: second.id }), 0);
    // A retry of the request that already finished is answered from its record, not refused.
    assert.equal((await push([first], account.token, requestId)).status, 200);

    // Instant sync is open at any time, costs 10, and leaves the standard clock alone.
    const standardAt = (await wallet(account.id)).lastStandardSyncAt;
    const instant = await push([second], account.token, randomUUID(), 'instant');
    assert.equal(instant.status, 200); assert.equal((await json(instant)).charged, 10);
    assert.equal((await wallet(account.id)).energy, energy - 10);
    assert.deepEqual((await wallet(account.id)).lastStandardSyncAt, standardAt);

    // The hour is counted by the Server's clock: after it, a standard sync is charged again.
    await collections.atomicUsers(db).updateOne({ _id: account.id }, { $set: { lastStandardSyncAt: new Date(Date.now() - 61 * 60 * 1000), energy: 50 } });
    const later = await push([third], account.token);
    assert.equal(later.status, 200); assert.equal((await json(later)).charged, 5);
  });

  await t.test('a note that already holds exactly what a push sends is not written to Drive again', async () => {
    const account = await user(), note = row();
    const created = await json(await push([note], account.token));
    assert.equal(created.results[0].unchanged, undefined);
    assert.ok((await collections.notes(db).findOne({ _id: note.id }))!.contentHash);

    await refill(account.id);
    const before = writes;
    const same = await push([{ ...note, base_version: 1 }], account.token);
    assert.equal(same.status, 200);
    const [result] = (await json(same)).results;
    assert.deepEqual([result.ok, result.unchanged, result.version], [true, true, 1]);
    assert.equal(writes, before);
    assert.equal((await collections.notes(db).findOne({ _id: note.id }))!.localVersion, 1);

    // A real edit, and a batch that mixes an unchanged note, an edit and a new note.
    await refill(account.id);
    const edited = await json(await push([{ ...note, title: 'changed', base_version: 1 }], account.token));
    assert.equal(edited.results[0].version, 2); assert.equal(writes, before + 1);
    const fresh = row();
    await refill(account.id);
    const mixed = await json(await push([{ ...note, title: 'changed', base_version: 2 }, fresh], account.token));
    assert.deepEqual(mixed.results.map((r: any) => [r.ok, r.unchanged ?? false]), [[true, true], [true, false]]);
    assert.equal(writes, before + 2);
    // Pinning is content too, and deleting an already deleted note changes nothing.
    await refill(account.id);
    assert.equal((await json(await push([{ ...note, title: 'changed', pinned: true, base_version: 2 }], account.token))).results[0].version, 3);
    await refill(account.id);
    assert.equal((await push([{ ...note, title: 'changed', pinned: true, deleted: true, base_version: 3 }], account.token)).status, 200);
    await refill(account.id);
    const gone = (await json(await push([{ ...note, title: 'changed', pinned: true, deleted: true, base_version: 4 }], account.token))).results[0];
    assert.deepEqual([gone.ok, gone.unchanged], [true, true]);
  });

  await t.test('a batch is written to Drive in parallel and committed in the order it was sent', async () => {
    const account = await user(), notes = Array.from({ length: 12 }, (_, i) => row({ title: `n${i}` }));
    peakWrites = 0;
    const response = await push(notes, account.token);
    assert.equal(response.status, 200);
    const body = await json(response);
    assert.deepEqual(body.results.map((r: any) => r.id), notes.map((n) => n.id));
    assert.deepEqual(body.results.map((r: any) => r.seq), Array.from({ length: 12 }, (_, i) => i + 1));
    // Bounded at 8 in flight: 12 notes take two rounds.
    assert.ok(peakWrites > 4 && peakWrites <= 8, `peak writes in flight: ${peakWrites}`);
  });

  await t.test('one push carries up to 100 notes', async () => {
    const account = await user();
    await collections.atomicUsers(db).updateOne({ _id: account.id }, { $set: { noteLimit: 100, energy: 100 } });
    assert.equal((await push(Array.from({ length: 101 }, () => row()), account.token)).status, 400);
    const response = await push(Array.from({ length: 100 }, () => row()), account.token);
    assert.equal(response.status, 200);
    assert.equal(await collections.notes(db).countDocuments({ userId: account.id, deleted: false }), 100);
  });

  await t.test('a batch may delete a note and add one at the limit, but a stale delete frees no room', async () => {
    const account = await user(), a = row(), b = row(), c = row(), d = row();
    await collections.atomicUsers(db).updateOne({ _id: account.id }, { $set: { noteLimit: 2 } });
    assert.equal((await push([a, b], account.token)).status, 200);
    await refill(account.id);
    const full = await push([c], account.token);
    assert.equal(full.status, 409); assert.equal((await json(full)).error, 'note_limit_reached');
    await refill(account.id);
    assert.equal((await push([{ ...a, deleted: true, base_version: 1 }, c], account.token)).status, 200);
    assert.equal(await collections.notes(db).countDocuments({ userId: account.id, deleted: false }), 2);
    // The delete of b names an old version, so it conflicts and removes nothing: adding d must not fit.
    await refill(account.id);
    assert.equal((await push([{ ...b, deleted: true, base_version: 0 }, d], account.token)).status, 409);
    assert.equal(await collections.notes(db).countDocuments({ userId: account.id, deleted: false }), 2);
  });

  await t.test('R12 a failed deletion cannot fund a new note and failed replay refunds only once', async () => {
    const account = await user(), original = row(), replacement = row();
    assert.equal((await push([original], account.token)).status, 200);
    await refill(account.id);
    await collections.atomicUsers(db).updateOne({ _id: account.id }, { $set: { noteLimit: 1 } });
    const rows = [replacement, { ...original, deleted: true, base_version: 1 }], requestId = randomUUID();
    failDelete = true;
    try {
      const response = await push(rows, account.token, requestId);
      assert.equal(response.status, 502);
      const body = await json(response);
      assert.equal(await collections.notes(db).countDocuments({ userId: account.id, deleted: false }), 1);
      assert.equal(await collections.notes(db).findOne({ _id: replacement.id }), null);
      assert.ok(![...files.values()].some((file) => file.id === replacement.id), 'blocked insert must not write Drive');
      assert.ok(body.results.every((r: any) => !r.ok));
      assert.deepEqual([body.charged, body.refunded], [5, 5]);
      assert.equal((await wallet(account.id)).energy, 100);
      const afterWrites = writes;
      assert.deepEqual(await json(await push(rows, account.token, requestId)), body);
      assert.equal(writes, afterWrites);
      assert.equal(await refundCount(account.id), 1);
    } finally { failDelete = false; }
  });

  await t.test('R12 only successful deletions supply capacity in a partially failing replacement batch', async () => {
    const account = await user(), a = row({ title: 'DELETE_FAIL' }), b = row();
    const initial = await push([a, b], account.token);
    assert.equal(initial.status, 200);
    const versions = new Map<string, number>((await json(initial)).results.map((r: any) => [r.id, r.version]));
    await refill(account.id);
    await collections.atomicUsers(db).updateOne({ _id: account.id }, { $set: { noteLimit: 2 } });
    const c = row(), d = row();
    failTitle = 'DELETE_FAIL';
    try {
      const response = await push([c, d, { ...a, deleted: true, base_version: versions.get(a.id) }, { ...b, deleted: true, base_version: versions.get(b.id) }], account.token);
      assert.equal(response.status, 502);
      const body = await json(response);
      assert.equal(await collections.notes(db).countDocuments({ userId: account.id, deleted: false }), 2);
      assert.equal(body.results.find((r: any) => r.id === b.id).ok, true);
      assert.equal(body.results.find((r: any) => r.id === c.id).ok, true);
      assert.equal(body.results.find((r: any) => r.id === d.id).ok, false);
      assert.ok(![...files.values()].some((file) => file.id === d.id));
      assert.deepEqual([body.charged, body.refunded], [5, 0]);
    } finally { failTitle = ''; }
  });

  await t.test('R12 a failed deletion cannot fund restoration of a tombstone', async () => {
    const account = await user(), active = row(), deleted = row({ deleted: true });
    assert.equal((await push([active, deleted], account.token)).status, 200);
    const tombstone = (await collections.notes(db).findOne({ _id: deleted.id }))!;
    const priorFile = structuredClone(files.get(tombstone.driveFileId));
    await refill(account.id);
    await collections.atomicUsers(db).updateOne({ _id: account.id }, { $set: { noteLimit: 1 } });
    failDelete = true;
    try {
      const response = await push([{ ...deleted, title: 'RESTORED', deleted: false, base_version: tombstone.localVersion }, { ...active, deleted: true, base_version: 1 }], account.token);
      assert.equal(response.status, 502);
      assert.equal(await collections.notes(db).countDocuments({ userId: account.id, deleted: false }), 1);
      assert.equal((await collections.notes(db).findOne({ _id: deleted.id }))!.deleted, true);
      assert.deepEqual(files.get(tombstone.driveFileId), priorFile, 'blocked restore must not alter Drive');
    } finally { failDelete = false; }
  });

  await t.test('note capacity is bought one tier at a time, the last tier costs more, and a repeated call charges once', async () => {
    const account = await user();
    const upgrade = (from: number) => request('/energy/note-limit', 'POST', { from_limit: from }, account.token);
    const poor = await upgrade(30);
    assert.equal(poor.status, 409); assert.equal((await json(poor)).error, 'insufficient_coins');
    assert.equal((await wallet(account.id)).noteLimit, 30);

    // 10 + 20 + 30: exactly enough for every tier up to the ceiling, nothing left over.
    await collections.atomicUsers(db).updateOne({ _id: account.id }, { $set: { coins: 60 } });
    const first = await json(await upgrade(30));
    assert.deepEqual([first.wallet.note_limit, first.wallet.coins], [40, 50]);
    // The same call again, as after a lost response: the purchase went through, so nothing more is charged.
    const repeat = await upgrade(30);
    assert.equal(repeat.status, 200);
    assert.deepEqual([(await json(repeat)).wallet.coins, (await wallet(account.id)).noteLimit], [50, 40]);
    // A caller that is ahead of the Server is refused.
    assert.equal((await json(await upgrade(50))).error, 'invalid_amount');

    assert.equal((await json(await upgrade(40))).wallet.note_limit, 50);
    // Strangelet: 50 -> 100 costs 30 coins, not the earlier tiers' cheaper prices.
    const strangelet = await json(await upgrade(50));
    assert.deepEqual([strangelet.wallet.note_limit, strangelet.wallet.coins], [100, 0]);
    const capped = await upgrade(100);
    assert.equal(capped.status, 409); assert.equal((await json(capped)).error, 'note_limit_ceiling');
    assert.deepEqual([(await wallet(account.id)).coins, (await wallet(account.id)).noteLimit], [0, 100]);
    const purchases = await collections.energyLedger(db)
      .find({ userId: account.id, kind: 'purchase' })
      .sort({ createdAt: 1 })
      .toArray();
    assert.deepEqual(purchases.map((p) => p.coinsDelta), [-10, -20, -30]);

    // The Server publishes the tiers it enforces, and a pushed batch obeys the new limit.
    const state = await json(await request('/energy', 'GET', undefined, account.token));
    assert.equal(state.wallet.note_limit, 100);
    assert.equal(state.limits.note_limit_ceiling, 100);
    assert.deepEqual(
      state.limits.note_limit_tiers.map((t: any) => [t.limit, t.name, t.cost_coins]),
      [[30, 'Tachyon', 0], [40, 'Antimatter', 10], [50, 'Monopole', 20], [100, 'Strangelet', 30]],
    );
    await refill(account.id);
    assert.equal((await push(Array.from({ length: 60 }, () => row()), account.token)).status, 200);
  });

  await t.test('a client can neither spend nor refund energy itself', async () => {
    const account = await user();
    for (const path of ['/energy/spend', '/energy/spend-standard', '/energy/refund']) {
      const response = await request(path, 'POST', { amount: 1, reason: 'x' }, account.token);
      assert.equal(response.status, 410, path);
    }
  });

  await t.test('R10 deleted-note history has no automatic expiry, and only the newest 5 sessions stay valid', async () => {
    const ttl = (await collections.notes(db).indexes()).filter((index) => index.expireAfterSeconds !== undefined);
    assert.deepEqual(ttl, [], 'deletion history must remain available to long-offline clients');

    const account = await user(), tokens = [account.token];
    for (let i = 0; i < 7; i++) { await delay(3); tokens.push(await createSession(db, account.id)); }
    assert.equal(await collections.sessions(db).countDocuments({ userId: account.id, revoked: false }), 5);
    assert.ok(await verifySession(db, tokens[tokens.length - 1]));
    assert.equal(await verifySession(db, tokens[0]), null);
  });

  await t.test('Google login falls back to the profile endpoint when the token response has no ID token', async () => {
    const verifier = { async verifyIdToken() { throw new Error('must not be called without an ID token'); } } as any;
    const sub = randomUUID(), setup = async () => ({ notesId: 'folder-p' });
    const tokens = { access_token: 'access', refresh_token: 'refresh', expiry_date: Date.now() + 3600000 };
    const viaProfile = await completeGoogleLogin(db, verifier, tokens, 'agent', setup as any,
      async () => ({ sub, email: 'Profile@Example.com', email_verified: true, name: 'P' })) as { user: { id: string; email: string } };
    assert.equal(viaProfile.user.email, 'profile@example.com');
    assert.equal((await collections.googleAccounts(db).findOne({ googleAccountId: sub }))!.userId, viaProfile.user.id);
    assert.deepEqual(await completeGoogleLogin(db, verifier, tokens, 'agent', setup as any, async () => null), { error: 'incomplete_token_response' });
    assert.deepEqual(await completeGoogleLogin(db, verifier, { ...tokens, access_token: undefined }, 'agent', setup as any, async () => ({})), { error: 'incomplete_token_response' });
    assert.deepEqual(await completeGoogleLogin(db, verifier, tokens, 'agent', setup as any,
      async () => ({ sub: randomUUID(), email: 'unverified@example.com', email_verified: false })), { error: 'invalid_id_token' });
  });

  await t.test('R10 sync operation receipts have no automatic expiry', async () => {
    const indexes = await db.collection('sync_operations').indexes();
    assert.deepEqual(indexes.filter((index) => index.expireAfterSeconds !== undefined), [],
      'pending charges and completed replay outcomes must not expire');
  });

  // R10 characterization, not desired guarantees. Remove only an expired fixture row
  // to model TTL cleanup deterministically, without waiting for Mongo's TTL monitor.
  // The suite's existing index tests verify the configured 30-day TTL separately.
  const expiredAt = () => new Date(Date.now() - 31 * 24 * 60 * 60 * 1000);
  const expireFixtureOperation = async (userId: string, requestId: string) => {
    const _id = `${userId}:${requestId}`;
    assert.ok(await syncOperations(db).findOne({ _id, userId }));
    const createdAt = expiredAt();
    await syncOperations(db).updateOne({ _id, userId }, { $set: { createdAt } });
    // The real TTL monitor may also remove it between these two statements.
    await syncOperations(db).deleteOne({ _id, userId, createdAt });
    assert.equal(await syncOperations(db).findOne({ _id, userId }), null);
  };

  await t.test('R10 expired tombstone hides deletion from an old cursor and permits a stale edit to recreate it', async () => {
    const account = await user(), note = row();
    const created = await json(await push([note], account.token));
    const oldVersion = created.results[0].version, oldCursor = created.results[0].seq;
    await refill(account.id);
    const deletedResponse = await push([{ ...note, deleted: true, base_version: oldVersion }], account.token);
    assert.equal(deletedResponse.status, 200);
    const deleted = await json(deletedResponse);
    const beforeExpiry = await json(await request(`/notes/pull?after=${oldCursor}`, 'GET', undefined, account.token));
    assert.equal(beforeExpiry.rows.length, 1);
    assert.equal(beforeExpiry.rows[0].id, note.id);
    assert.equal(beforeExpiry.rows[0].deleted, true, 'retained tombstone delivers the deletion');

    const staleEdit = { ...note, title: 'Offline edit from before deletion', base_version: oldVersion };
    await refill(account.id);
    const beforeWrites = writes;
    const rejected = await push([staleEdit], account.token);
    assert.equal(rejected.status, 502);
    assert.equal((await json(rejected)).results[0].error, 'note_conflict');
    assert.equal(writes, beforeWrites, 'retained tombstone prevents stale Drive writes');

    const updatedAt = expiredAt();
    await collections.notes(db).updateOne({ _id: note.id, userId: account.id, deleted: true }, { $set: { updatedAt } });
    await collections.notes(db).deleteOne({ _id: note.id, userId: account.id, deleted: true, updatedAt });
    assert.equal(await collections.notes(db).findOne({ _id: note.id }), null);
    const afterExpiry = await json(await request(`/notes/pull?after=${oldCursor}`, 'GET', undefined, account.token));
    assert.deepEqual(afterExpiry.rows, [], 'absence does not carry a deletion instruction');
    assert.equal(afterExpiry.nextCursor, deleted.results[0].seq, 'cursor advances past the missing tombstone');
    assert.equal(afterExpiry.hasMore, false);

    await refill(account.id);
    const restoredResponse = await push([staleEdit], account.token);
    assert.equal(restoredResponse.status, 200, 'current behavior accepts a stale base when metadata is absent');
    const restored = await json(restoredResponse);
    const metadata = (await collections.notes(db).findOne({ _id: note.id, userId: account.id }))!;
    assert.equal(metadata.deleted, false);
    assert.ok(restored.results[0].version > deleted.results[0].version, 'R5 monotonic versions do not prevent resurrection');
    assert.equal(files.get(metadata.driveFileId).title, staleEdit.title);
    assert.equal(writes, beforeWrites + 1);
  });

  await t.test('R10 pending request expiry loses its prepaid charge while a retained pending request resumes once', async () => {
    for (const expired of [false, true]) {
      const account = await user(), requestId = randomUUID(), rows = [row()];
      await energyGrantDaily(db, account.id); // Isolate receipt charges from the account's first daily grant.
      await refill(account.id);
      // Fixture represents a crash after beginSync committed its charge, before any Drive write.
      // Normalize rows exactly as the route does before fingerprinting them.
      await beginSync(db, account.id, requestId, rows.map((r) => remoteNoteRowSchema.parse(r)), 'instant');
      assert.equal((await wallet(account.id)).energy, 90);
      if (expired) await expireFixtureOperation(account.id, requestId);
      const beforeWrites = writes;
      const resumed = await push(rows, account.token, requestId, 'instant');
      assert.equal(resumed.status, 200);
      assert.equal(writes, beforeWrites + 1);
      assert.equal((await wallet(account.id)).energy, expired ? 80 : 90);
      assert.equal(await collections.energyLedger(db).countDocuments({ userId: account.id, kind: 'spend' }), expired ? 2 : 1);
      assert.equal(await refundCount(account.id), 0, 'deleted pending operation is unavailable for abandoned-operation refund');
    }
  });

  await t.test('R10 expired completed unchanged request can charge again without another Drive write', async () => {
    const account = await user(), note = row();
    const created = await json(await push([note], account.token));
    await refill(account.id);
    const rows = [{ ...note, base_version: created.results[0].version }], requestId = randomUUID();
    const beforeWrites = writes;
    const first = await push(rows, account.token, requestId, 'instant');
    assert.equal(first.status, 200);
    const result = await json(first);
    assert.equal(result.results[0].unchanged, true);
    assert.equal(result.charged, 10);
    assert.equal((await wallet(account.id)).energy, 90);
    assert.deepEqual(await json(await push(rows, account.token, requestId, 'instant')), result);
    assert.equal((await wallet(account.id)).energy, 90, 'retained record replays without charging');
    const spends = await collections.energyLedger(db).countDocuments({ userId: account.id, kind: 'spend' });

    await expireFixtureOperation(account.id, requestId);
    const repeated = await push(rows, account.token, requestId, 'instant');
    assert.equal(repeated.status, 200);
    assert.deepEqual(await json(repeated), result, 'identical response does not prove no second charge');
    assert.equal(writes, beforeWrites);
    assert.equal((await wallet(account.id)).energy, 80);
    assert.equal(await collections.energyLedger(db).countDocuments({ userId: account.id, kind: 'spend' }), spends + 1);
  });

  await t.test('R10 expired completed changed request conflicts and refunds instead of replaying its success', async () => {
    const account = await user(), requestId = randomUUID(), rows = [row()];
    await energyGrantDaily(db, account.id); // Isolate receipt charges from the account's first daily grant.
    await refill(account.id);
    const first = await push(rows, account.token, requestId, 'instant');
    assert.equal(first.status, 200);
    const firstBody = await json(first), beforeWrites = writes;
    assert.deepEqual(await json(await push(rows, account.token, requestId, 'instant')), firstBody);
    assert.equal((await wallet(account.id)).energy, 90);

    await expireFixtureOperation(account.id, requestId);
    const repeated = await push(rows, account.token, requestId, 'instant');
    assert.equal(repeated.status, 502);
    const result = await json(repeated);
    assert.equal(result.results[0].error, 'note_conflict');
    assert.deepEqual([result.charged, result.refunded], [10, 10]);
    assert.equal(writes, beforeWrites);
    assert.equal((await wallet(account.id)).energy, 90, 'not every expired replay causes a net second charge');
    assert.equal(await refundCount(account.id), 1);
    assert.deepEqual(await json(await push(rows, account.token, requestId, 'instant')), result);
    assert.equal(await refundCount(account.id), 1, 'newly recorded failure is itself replay-safe');
  });

  await t.test('log rows expire after 30 days and the energy ledger is kept', async () => {
    const logTtl = (await collections.logs(db).indexes()).find((index) => index.name === 'logs_ttl');
    assert.deepEqual(logTtl?.key, { createdAt: 1 });
    assert.equal(logTtl?.expireAfterSeconds, 30 * 24 * 60 * 60);
    const ledger = await collections.energyLedger(db).indexes();
    assert.equal(ledger.some((index) => index.expireAfterSeconds !== undefined), false);
  });

  await t.test('R10 year-old tombstone still delivers deletion and rejects stale edits, while explicit wipe preserves receipts', async () => {
    const account = await user(), note = row();
    const created = await json(await push([note], account.token));
    await refill(account.id);
    const requestId = randomUUID();
    const removed = await push([{ ...note, deleted: true, base_version: created.results[0].version }], account.token, requestId);
    assert.equal(removed.status, 200);
    const old = new Date(Date.now() - 366 * 24 * 60 * 60 * 1000);
    await collections.notes(db).updateOne({ _id: note.id }, { $set: { updatedAt: old } });
    const pulled = await json(await request(`/notes/pull?after=${created.results[0].seq}`, 'GET', undefined, account.token));
    assert.equal(pulled.rows[0].id, note.id);
    assert.equal(pulled.rows[0].deleted, true);
    await refill(account.id);
    const beforeWrites = writes;
    const rejected = await push([{ ...note, title: 'Old offline edit', base_version: created.results[0].version }], account.token);
    assert.equal(rejected.status, 502);
    assert.equal((await json(rejected)).results[0].error, 'note_conflict');
    assert.equal(writes, beforeWrites);
    const receipt = await syncOperations(db).findOne({ _id: `${account.id}:${requestId}` });
    assert.equal((await request('/notes', 'DELETE', undefined, account.token)).status, 200);
    assert.equal(await collections.notes(db).countDocuments({ userId: account.id }), 0);
    assert.deepEqual(await syncOperations(db).findOne({ _id: `${account.id}:${requestId}` }), receipt);
    assert.deepEqual((await json(await request('/notes/pull?after=0', 'GET', undefined, account.token))).rows, [],
      'explicit cloud wipe still does not instruct clients to delete local notes');
  });

  for (const mode of ['standard', 'instant'] as const) {
    await t.test(`R10 year-old ${mode} receipts preserve pending charges, completed replay and abandoned refunds`, async () => {
      const account = await user(), requestId = randomUUID(), rows = [row()];
      await energyGrantDaily(db, account.id);
      await refill(account.id);
      const pending = await beginSync(db, account.id, requestId, rows.map((r) => remoteNoteRowSchema.parse(r)), mode);
      const old = new Date(Date.now() - 366 * 24 * 60 * 60 * 1000);
      await syncOperations(db).updateOne({ _id: pending._id }, { $set: { createdAt: old } });
      if (mode === 'standard') await collections.atomicUsers(db).updateOne({ _id: account.id }, { $set: { lastStandardSyncAt: old } });
      const beforeEnergy = (await wallet(account.id)).energy, beforeWrites = writes;
      const resumed = await push(rows, account.token, requestId, mode);
      assert.equal(resumed.status, 200);
      const completed = await json(resumed);
      assert.equal((await wallet(account.id)).energy, beforeEnergy);
      assert.equal(writes, beforeWrites + 1);
      assert.deepEqual(await json(await push(rows, account.token, requestId, mode)), completed);
      assert.equal((await wallet(account.id)).energy, beforeEnergy);
      assert.equal(writes, beforeWrites + 1);
      assert.equal(await collections.energyLedger(db).countDocuments({ userId: account.id, kind: 'spend' }), 1);

      await refill(account.id);
      const abandoned = await beginSync(db, account.id, randomUUID(), [row()], mode);
      await syncOperations(db).updateOne({ _id: abandoned._id }, { $set: { createdAt: old } });
      if (mode === 'standard') await collections.atomicUsers(db).updateOne({ _id: account.id }, { $set: { lastStandardSyncAt: old } });
      const later = await push([row()], account.token, randomUUID(), mode);
      assert.equal(later.status, 200);
      assert.equal((await syncOperations(db).findOne({ _id: abandoned._id }))!.refunded, pending.charged);
      assert.equal(await refundCount(account.id), 1);
      assert.equal((await wallet(account.id)).energy, 100 - pending.charged);
    });
  }

  await t.test('R10 reports raw BSON receipt size at fixed fixture batch sizes without storing note text', async () => {
    const account = await user(), note = row();
    await push([note], account.token);
    const receipt = (await syncOperations(db).findOne({ userId: account.id }))!;
    const tombstoneShape = { ...(await collections.notes(db).findOne({ _id: note.id }))!, deleted: true };
    for (const count of [1, 50, 100]) {
      const results = Array.from({ length: count }, () => ({ ...receipt.results[0], id: randomUUID() }));
      const sample = { ...receipt, rowIds: results.map((r) => r.id), results };
      assert.equal(JSON.stringify(sample).includes(note.body), false);
      console.log(`RETENTION_BSON rows=${count} receiptBytes=${BSON.calculateObjectSize(sample)} tombstoneBytes=${BSON.calculateObjectSize(tombstoneShape)}`);
    }
  });

  await t.test('returning Google login links by subject, reuses the refresh token and repairs missing Drive setup', async () => {
    const sub = randomUUID();
    const verifier = { async verifyIdToken({ idToken }: { idToken: string }) { return { getPayload: () => JSON.parse(idToken) }; } } as any;
    const login = (claims: object, tokens: object = {}, setup: any = async () => ({ notesId: 'folder-1' })) => completeGoogleLogin(db, verifier, {
      access_token: 'access', refresh_token: 'refresh-1', expiry_date: Date.now() + 3600000,
      id_token: JSON.stringify({ sub, email: 'Person@Example.com', email_verified: true, name: 'Person', ...claims }), ...tokens }, 'test-agent', setup);

    await assert.rejects(login({}, {}, async () => { throw new Error('drive_setup_failed'); }), /drive_setup_failed/);
    let account = (await collections.googleAccounts(db).findOne({ googleAccountId: sub }))!;
    assert.equal(account.driveRootFolderId, null);

    const returning = await login({ email: 'Moved@Example.com' }, { refresh_token: undefined, access_token: 'access-2' }, async () => ({ notesId: 'folder-2' })) as { user: { id: string; email: string } };
    assert.equal(returning.user.id, account.userId);
    assert.equal(returning.user.email, 'moved@example.com');
    account = (await collections.googleAccounts(db).findOne({ googleAccountId: sub }))!;
    assert.equal(account.driveRootFolderId, 'folder-2');
    assert.equal(decryptToken(account.encryptedRefreshToken), 'refresh-1');
    assert.equal(decryptToken(account.encryptedAccessToken), 'access-2');
    assert.equal(await collections.users(db).countDocuments({ _id: account.userId }), 1);

    assert.deepEqual(await login({ sub: randomUUID(), email: 'unverified@example.com', email_verified: false }), { error: 'invalid_id_token' });
    const noRefresh = await login({ sub: randomUUID(), email: 'norefresh@example.com' }, { refresh_token: undefined });
    assert.equal((noRefresh as { error: string }).error, 'refresh_token_required');
    assert.equal(await collections.users(db).findOne({ email: 'norefresh@example.com' }), null);
  });

  await t.test('OAuth state is stored hashed, bound to a cookie, and rejected when the binding or lifetime is wrong', async () => {
    const start = await app.request('/api/auth/google');
    assert.equal(start.status, 302);
    const cookie = start.headers.get('set-cookie')!;
    assert.match(cookie, /atomic_oauth_state=/); assert.match(cookie, /HttpOnly/i); assert.match(cookie, /SameSite=Lax/i);
    const binding = /atomic_oauth_state=([^;]+)/.exec(cookie)![1];
    const state = new URL(start.headers.get('location')!).searchParams.get('state')!;
    const hash = (value: string) => createHash('sha256').update(value).digest('hex');
    const states = db.collection<{ _id: string; binding: string; expiresAt: Date }>('oauth_states');
    const stored = (await states.findOne({ _id: hash(state) }))!;
    assert.equal(stored.binding, hash(binding));
    assert.equal(await states.findOne({ _id: state }), null);

    const callback = (query: string, cookieHeader?: string) => app.request(`/api/auth/callback?${query}`, { headers: cookieHeader ? { cookie: cookieHeader } : {} });
    assert.equal((await callback(`code=x&state=${state}`)).status, 400);
    assert.equal((await callback(`code=x&state=${state}`, 'atomic_oauth_state=wrong')).status, 400);
    assert.equal((await callback('code=x&state=unknown', `atomic_oauth_state=${binding}`)).status, 400);
    assert.ok(await states.findOne({ _id: hash(state) }), 'a rejected callback must not consume the state');
    await states.updateOne({ _id: hash(state) }, { $set: { expiresAt: new Date(Date.now() - 1000) } });
    assert.equal((await callback(`code=x&state=${state}`, `atomic_oauth_state=${binding}`)).status, 400);
  });

  await t.test('the App feed delivers what the Controller published, with per-user read and dismiss state', async () => {
    const DAY = 24 * 60 * 60 * 1000;
    const publish = async (fields: object) => {
      const response = await request('/admin/notifications', 'POST', { type: 'general', subject: 'feed test', description: 'hello', ...fields }, undefined, 'test-admin-key');
      assert.equal(response.status, 200, JSON.stringify(fields));
      const body = await json(response);
      return { id: body.row.id as string, size: body.audience_size as number };
    };
    const reader = await user(), bystander = await user(), dormant = await user();
    await collections.atomicUsers(db).updateOne({ _id: reader.id }, { $set: { lastDailyGrantAt: new Date() } });
    await collections.atomicUsers(db).updateOne({ _id: dormant.id }, { $set: { lastDailyGrantAt: new Date(Date.now() - 10 * DAY) } });
    await collections.sessions(db).updateMany({ userId: dormant.id }, { $set: { createdAt: new Date(Date.now() - 10 * DAY) } });

    const everyone = await publish({});
    const toReader = await publish({ target_user_id: reader.id });
    const toBystander = await publish({ target_user_id: bystander.id });
    const active = await publish({ target_audience: 'active' });
    const inactive = await publish({ target_audience: 'inactive' });
    const welcome = await publish({ target_audience: 'new' });
    assert.equal(welcome.size, 0, 'nobody yet: it reaches accounts created from now on');
    const pinned = await publish({ priority: 'critical', dismissible: false });
    const expired = await publish({ expires_at: new Date(Date.now() - 1000).toISOString() });
    const resolved = await publish({ status: 'resolved' });
    const newAppsOnly = await publish({ min_app_version: '2.0.0' });
    const oldAppsOnly = await publish({ max_app_version: '1.9.9' });
    assert.equal(toReader.size, 1);
    assert.ok(everyone.size >= 3);
    assert.equal((await request('/admin/notifications', 'POST', { type: 'general', subject: 's', description: 'd', target_audience: 'user' }, undefined, 'test-admin-key')).status, 400);

    const feed = async (account: { token: string }, version?: string) => {
      const response = await request(`/notifications${version ? `?app_version=${version}` : ''}`, 'GET', undefined, account.token);
      assert.equal(response.status, 200);
      return (await json(response)).rows as { id: string; is_read: boolean; dismissible: boolean; created_at: string }[];
    };
    const ids = async (account: { token: string }, version?: string) => new Set((await feed(account, version)).map((n) => n.id));
    const readerSees = await ids(reader, '1.18.2');
    for (const n of [everyone, toReader, active, pinned]) assert.ok(readerSees.has(n.id));
    for (const n of [toBystander, inactive, expired, resolved, newAppsOnly, oldAppsOnly]) assert.ok(!readerSees.has(n.id));
    const dormantSees = await ids(dormant, '1.18.2');
    for (const n of [everyone, inactive, pinned]) assert.ok(dormantSees.has(n.id));
    for (const n of [active, toReader]) assert.ok(!dormantSees.has(n.id));
    // A welcome for new accounts: not for accounts made before it, yes for one made after.
    assert.ok(!readerSees.has(welcome.id) && !dormantSees.has(welcome.id));
    const newcomer = await user();
    const newcomerSees = await ids(newcomer, '1.18.2');
    for (const n of [welcome, everyone, pinned]) assert.ok(newcomerSees.has(n.id));
    assert.ok(!newcomerSees.has(active.id), 'active was decided before the account existed');
    assert.equal(((await json(await request('/public/notifications/active'))).rows as { id: string }[]).some((n) => n.id === welcome.id), false,
      'welcome messages stay off the public website');
    // An App that does not send its version sees every range.
    const anyVersion = await ids(reader);
    assert.ok(anyVersion.has(newAppsOnly.id) && anyVersion.has(oldAppsOnly.id));
    const ordered = (await feed(reader)).map((n) => n.created_at);
    assert.deepEqual(ordered, [...ordered].sort().reverse(), 'newest first');

    const post = (path: string, account = reader) => request(`/notifications${path}`, 'POST', undefined, account.token);
    assert.equal((await feed(reader)).find((n) => n.id === everyone.id)!.is_read, false);
    assert.equal((await post(`/${everyone.id}/read`)).status, 200);
    assert.equal((await post(`/${everyone.id}/read`)).status, 200, 'repeatable');
    assert.equal((await feed(reader)).find((n) => n.id === everyone.id)!.is_read, true);
    assert.equal((await feed(bystander)).find((n) => n.id === everyone.id)!.is_read, false, 'read state is per user');
    assert.equal((await post(`/${toBystander.id}/read`)).status, 404, "another user's message");
    assert.equal((await post('/not-a-uuid/read')).status, 400);
    assert.equal((await post(`/${pinned.id}/dismiss`)).status, 409);
    assert.equal((await post(`/${toReader.id}/dismiss`)).status, 200);
    assert.ok(!(await ids(reader)).has(toReader.id), 'dismissed');
    // Reading all in this App version must not pre-read an excluded-version
    // announcement. The no-version request remains compatible with old Apps.
    assert.equal((await post('/read-all?app_version=2.03.5')).status, 200);
    assert.ok((await feed(reader, '2.03.5')).every((n) => n.is_read));
    assert.equal((await feed(reader)).find((n) => n.id === oldAppsOnly.id)!.is_read, false);
    assert.equal((await post('/read-all?app_version=bad')).status, 400);
    const all = await json(await post('/read-all'));
    assert.ok(all.marked >= 1);
    assert.ok((await feed(reader)).every((n) => n.is_read));
    assert.equal((await request('/notifications')).status, 401);

    const listed = (await json(await request('/admin/notifications', 'GET', undefined, undefined, 'test-admin-key'))).rows as { id: string; reads: number; recipients: number | null }[];
    assert.ok(listed.find((n) => n.id === everyone.id)!.reads >= 1);
    assert.equal(listed.find((n) => n.id === active.id)!.recipients, active.size);
    assert.equal(listed.find((n) => n.id === everyone.id)!.recipients, null);
    assert.equal((await request(`/admin/notifications?id=${active.id}`, 'DELETE', undefined, undefined, 'test-admin-key')).status, 200);
    assert.equal(await collections.notificationRecipients(db).countDocuments({ notificationId: active.id }), 0);
    assert.equal(await collections.notificationStates(db).countDocuments({ notificationId: active.id }), 0);
  });

  for (const traffic of [60, 120]) {
    await t.test(`R15 pinned notices survive ${traffic} newer ordinary notices`, async () => {
      const reader = await user();
      const { notificationSchema } = await import('../src/db/collections');
      const now = Date.now();
      const pinned = notificationSchema.parse({
        _id: randomUUID(), type: 'general', subject: 'Required update', description: 'fixture',
        targetUserId: reader.id, dismissible: false, createdAt: new Date(now - 86400000),
      });
      const ordinary = Array.from({ length: traffic }, (_, index) => notificationSchema.parse({
        _id: randomUUID(), type: 'general', subject: `ordinary ${index}`, description: 'fixture',
        targetUserId: reader.id, createdAt: new Date(now + 60000 + index),
      }));
      const fixtures = [pinned, ...ordinary];
      await collections.notifications(db).insertMany(fixtures);
      try {
        const start = mongoCommands.started;
        const response = await request('/notifications?app_version=2.03.9', 'GET', undefined, reader.token);
        const commands = mongoCommands.started - start;
        assert.equal(response.status, 200);
        const rows = (await json(response)).rows as { id: string; is_read: boolean; created_at: string }[];
        console.log('NOTIFICATION_BUDGET', JSON.stringify({ traffic, commands, rows: rows.length }));
        assert.equal(rows.length, 50, 'response stays bounded');
        assert.ok(rows.some((n) => n.id === pinned._id), 'new ordinary traffic cannot evict an active pin');
        assert.ok(rows.some((n) => n.id === ordinary.at(-1)!._id), 'newest ordinary notice remains visible');
        assert.deepEqual(rows.map((n) => n.created_at), rows.map((n) => n.created_at).sort().reverse());
        assert.ok(commands <= 6, `notification feed command budget: ${commands}`);
        const readAll = await request('/notifications/read-all?app_version=2.03.9', 'POST', undefined, reader.token);
        assert.equal(readAll.status, 200);
        assert.ok((await collections.notificationStates(db).findOne({ userId: reader.id, notificationId: pinned._id }))?.readAt);
        assert.equal((await request(`/notifications/${pinned._id}/dismiss`, 'POST', undefined, reader.token)).status, 409);
        await collections.notifications(db).updateOne({ _id: pinned._id }, { $set: { status: 'resolved' } });
        const resolvedFeed = (await json(await request('/notifications', 'GET', undefined, reader.token))).rows as { id: string }[];
        assert.ok(!resolvedFeed.some((n) => n.id === pinned._id), 'resolved pin leaves the feed');
      } finally {
        await collections.notifications(db).deleteMany({ _id: { $in: fixtures.map((n) => n._id) } });
        await collections.notificationStates(db).deleteMany({ userId: reader.id });
      }
    });
  }

  await t.test('failed republication cannot extend an existing notification audience', async () => {
    const recipient = await user();
    const id = randomUUID();
    const publish = (target_audience: string) => request('/admin/notifications', 'POST', {
      id, type: 'general', subject: 'publication rollback', description: 'fixture', target_audience,
    }, undefined, 'test-admin-key');
    // A currently active account must not receive a notice published to inactive accounts.
    assert.equal((await publish('inactive')).status, 200);
    const before = await collections.notificationRecipients(db).find({ notificationId: id }).sort({ _id: 1 }).toArray();
    const { reachableNotification } = await import('../src/lib/notificationFeed');
    assert.equal(await reachableNotification(db, recipient.id, id), null);
    // The accepted optional ID can collide with an existing notification. A refused
    // request must not attach its newly resolved audience to the existing document.
    assert.equal((await publish('active')).status, 500);
    assert.equal(await reachableNotification(db, recipient.id, id), null, 'failed publication must not grant access');
    assert.deepEqual(await collections.notificationRecipients(db).find({ notificationId: id }).sort({ _id: 1 }).toArray(), before);
    assert.equal((await collections.notifications(db).findOne({ _id: id }))!.targetAudience, 'inactive');
  });

  await t.test('recipient insertion failure leaves no partial publication', async () => {
    const recipient = await user();
    const id = randomUUID();
    // Simulate a leftover recipient from an earlier failed attempt. A duplicate
    // can fail midway through insertMany while other recipient inserts succeed.
    const existing = { _id: `${id}:${recipient.id}`, notificationId: id, userId: recipient.id };
    await collections.notificationRecipients(db).insertOne(existing);
    const response = await request('/admin/notifications', 'POST', {
      id, type: 'general', subject: 'recipient rollback', description: 'fixture', target_audience: 'active',
    }, undefined, 'test-admin-key');
    assert.equal(response.status, 500);
    assert.equal(await collections.notifications(db).findOne({ _id: id }), null, 'failed recipient write must roll back the notice');
    assert.deepEqual(await collections.notificationRecipients(db).find({ notificationId: id }).toArray(), [existing],
      'failed publication must leave pre-existing recipients unchanged');
  });

  await t.test('Controller sign-in is throttled per client and "log out everywhere" only moves forward', async () => {
    const attempt = async (client: string, result: string) => json(await request('/admin/controller/login-attempts', 'POST', { client, result }, undefined, 'test-admin-key'));
    const ip = '203.0.113.9';
    assert.deepEqual(await attempt(ip, 'check'), { allowed: true, retry_after_seconds: 0 });
    for (let i = 1; i < 5; i++) assert.equal((await attempt(ip, 'failure')).allowed, true, `failure ${i}`);
    const locked = await attempt(ip, 'failure');
    assert.equal(locked.allowed, false);
    assert.ok(locked.retry_after_seconds > 800 && locked.retry_after_seconds <= 900);
    assert.equal((await attempt(ip, 'check')).allowed, false);
    assert.equal((await attempt('198.51.100.7', 'check')).allowed, true, 'another client is not locked');
    assert.equal(await collections.controllerLoginAttempts(db).countDocuments({ _id: ip }), 0, 'the address is stored hashed');
    // Once the lock and the window have passed, the count starts again.
    await collections.controllerLoginAttempts(db).updateMany({}, { $set: { windowStart: new Date(Date.now() - 16 * 60 * 1000), lockedUntil: new Date(Date.now() - 1000) } });
    assert.equal((await attempt(ip, 'check')).allowed, true);
    assert.equal((await attempt(ip, 'failure')).allowed, true);
    assert.equal((await collections.controllerLoginAttempts(db).findOne({}))!.failures, 1);
    await attempt(ip, 'success');
    assert.equal(await collections.controllerLoginAttempts(db).countDocuments({}), 0);
    // Guesses sent at the same time all count.
    await Promise.all(Array.from({ length: 5 }, () => attempt('burst-client', 'failure')));
    assert.equal((await attempt('burst-client', 'check')).allowed, false);
    assert.equal((await request('/admin/controller/login-attempts', 'POST', { client: ip, result: 'check' })).status, 401);

    const epoch = async (revokedBefore?: number) => request('/admin/controller/session-epoch', revokedBefore === undefined ? 'GET' : 'POST',
      revokedBefore === undefined ? undefined : { revoked_before: revokedBefore }, undefined, 'test-admin-key');
    assert.deepEqual(await json(await epoch()), { revoked_before: null });
    const first = Date.now();
    assert.equal((await json(await epoch(first))).revoked_before, first);
    assert.equal((await json(await epoch(first - 60000))).revoked_before, first, 'never moves back');
    assert.equal((await epoch(Date.now() + 60 * 60 * 1000)).status, 400);
    assert.equal((await json(await epoch())).revoked_before, first);
    assert.equal((await request('/admin/controller/session-epoch')).status, 401);
  });
  await t.test('coin batches: migration, new grants, FEFO, replay, expiry and concurrent spending', async (ct) => {
    const { readCoinWallet, prepareCoinWallet, coinDetails } = await import('../src/lib/coinLots');
    const { coinExpiry } = await import('../src/lib/coinPolicy');
    const { energyUpgradeNoteLimit } = await import('../src/lib/energy');
    const legacy = await user();
    await collections.atomicUsers(db).updateOne({ _id: legacy.id }, { $set: { coins: 40 } });
    const zero = await user();
    await collections.atomicUsers(db).updateOne({ _id: zero.id }, { $set: { coins: 0 } });
    const priorLedger = await collections.energyLedger(db).countDocuments({ userId: legacy.id });
    process.env.COIN_EXPIRY_ACTIVATED_AT = '2026-01-01T00:00:00.000Z';
    ct.after(() => { delete process.env.COIN_EXPIRY_ACTIVATED_AT; });
    const lots = (id: string) => collections.coinLots(db).find({ userId: id }).sort({ creditedAt: 1, _id: 1 }).toArray();
    const wallet = (id: string) => collections.atomicUsers(db).findOne({ _id: id }).then((w) => w!);
    const adjust = (id: string, coins: number, requestId = randomUUID(), energy = 0) => request('/admin/energy', 'POST',
      { user_id: id, coins_delta: coins, energy_delta: energy, request_id: requestId }, undefined, 'test-admin-key');
    const reconcile = async (id: string) => {
      const records = await lots(id);
      assert.equal((await wallet(id)).coins, records.reduce((n, l) => n + l.remaining, 0));
      assert.ok(records.every((l) => l.remaining >= 0 && l.remaining <= l.amount));
    };
    await ct.test('concurrent first access preserves exact legacy balance without a fabricated credit', async () => {
      await Promise.all([readCoinWallet(db, legacy.id), readCoinWallet(db, legacy.id)]);
      assert.equal((await lots(legacy.id)).length, 1);
      assert.equal((await lots(legacy.id))[0].source, 'legacy');
      assert.equal((await lots(legacy.id))[0].expiresAt, null);
      assert.equal((await lots(legacy.id))[0].remaining, 40);
      assert.equal(await collections.energyLedger(db).countDocuments({ userId: legacy.id }), priorLedger);
      await readCoinWallet(db, zero.id);
      assert.equal((await lots(zero.id)).length, 0);
      assert.equal((await wallet(zero.id)).coinLotsVersion, 1);
      await reconcile(legacy.id);
    });
    await ct.test('new welcome coins expire, while duplicate grants have only one batch', async () => {
      const fresh = await user();
      const gift = (await lots(fresh.id))[0];
      assert.equal(gift.source, 'welcome');
      assert.equal(gift.remaining, 5);
      assert.equal(gift.expiresAt!.toISOString(), coinExpiry(gift.creditedAt).toISOString());
      const id = randomUUID();
      const results = await Promise.all([adjust(legacy.id, 50, id), adjust(legacy.id, 50, id)]);
      assert.deepEqual(results.map((r) => r.status), [200, 200]);
      assert.equal((await wallet(legacy.id)).coins, 90);
      assert.equal((await lots(legacy.id)).length, 2);
      assert.equal(await collections.coinOperations(db).countDocuments({ userId: legacy.id, requestId: id }), 1);
      assert.equal((await adjust(legacy.id, 49, id)).status, 409);
      const first = (await lots(legacy.id)).find((l) => l.source === 'controller')!;
      assert.equal(first.expiresAt!.toISOString(), coinExpiry(first.creditedAt).toISOString());
      assert.equal((await adjust(legacy.id, 50)).status, 200);
      assert.equal((await collections.coinLots(db).findOne({ _id: first._id }))!.expiresAt!.getTime(), first.expiresAt!.getTime());
      await reconcile(legacy.id);
    });
    await ct.test('spending consumes earliest expiry then legacy; conversion replay cannot charge again', async () => {
      const grants = (await lots(legacy.id)).filter((l) => l.source === 'controller');
      // Fixture-only dates: keep both unexpired and make the second credit expire first.
      await collections.coinLots(db).updateOne({ _id: grants[0]._id }, { $set: { expiresAt: new Date(Date.now() + 86400000 * 60) } });
      await collections.coinLots(db).updateOne({ _id: grants[1]._id }, { $set: { expiresAt: new Date(Date.now() + 86400000 * 30) } });
      const id = randomUUID();
      await Promise.all([energyConvert(db, legacy.id, 1, id), energyConvert(db, legacy.id, 1, id)]);
      assert.equal((await wallet(legacy.id)).energy, 40);
      assert.equal((await collections.coinLots(db).findOne({ _id: grants[1]._id }))!.remaining, 49);
      assert.equal((await collections.coinLots(db).findOne({ _id: grants[0]._id }))!.remaining, 50);
      assert.equal((await collections.coinLots(db).findOne({ _id: `${legacy.id}:opening` }))!.remaining, 40);
      await assert.rejects(energyConvert(db, legacy.id, 2, id), /coin_request_mismatch/);
      await assert.rejects(energyConvert(db, legacy.id, 1), /coin_request_id_required/);
      const count = await collections.coinOperations(db).countDocuments({ userId: legacy.id });
      await assert.rejects(energyConvert(db, legacy.id, 3, randomUUID()), /energy_cap_exceeded/);
      assert.equal(await collections.coinOperations(db).countDocuments({ userId: legacy.id }), count);
      // Capacity's existing from_limit guard remains safe even across different request IDs.
      await Promise.all([energyUpgradeNoteLimit(db, legacy.id, 30, randomUUID()), energyUpgradeNoteLimit(db, legacy.id, 30, randomUUID())]);
      assert.equal((await wallet(legacy.id)).noteLimit, 40);
      assert.equal((await collections.coinLots(db).findOne({ _id: grants[1]._id }))!.remaining, 39);
      assert.equal((await adjust(legacy.id, -100)).status, 200);
      assert.equal((await collections.coinLots(db).findOne({ _id: `${legacy.id}:opening` }))!.remaining, 29);
      await reconcile(legacy.id);
    });
    await ct.test('exact expiry expires only unspent remainder once; energy and capacity stay intact', async () => {
      const account = await user();
      const gift = (await lots(account.id))[0];
      await energyConvert(db, account.id, 1, randomUUID());
      const at = gift.expiresAt!;
      await withTransaction(async (session) => {
        const current = (await collections.atomicUsers(db).findOne({ _id: account.id }, { session }))!;
        const before = await prepareCoinWallet(db, current, session, new Date(at.getTime() - 1));
        assert.equal(before.coins, 4);
        const expired = await prepareCoinWallet(db, before, session, at);
        assert.equal(expired.coins, 0);
      });
      await withTransaction(async (session) => {
        const current = (await collections.atomicUsers(db).findOne({ _id: account.id }, { session }))!;
        await prepareCoinWallet(db, current, session, at);
      });
      assert.equal(await collections.energyLedger(db).countDocuments({ userId: account.id, reason: 'coin_expired' }), 1);
      assert.equal((await wallet(account.id)).energy, 40);
      assert.equal((await wallet(account.id)).noteLimit, 30);
      await reconcile(account.id);
    });
    await ct.test('parallel spends cannot use one coin twice; expired balances never authorize spending', async () => {
      assert.equal((await adjust(zero.id, 1)).status, 200);
      const outcomes = await Promise.allSettled([energyConvert(db, zero.id, 1, randomUUID()), energyConvert(db, zero.id, 1, randomUUID())]);
      assert.equal(outcomes.filter((r) => r.status === 'fulfilled').length, 1);
      assert.equal((await wallet(zero.id)).coins, 0);
      assert.equal((await wallet(zero.id)).energy, 40);
      assert.equal((await adjust(zero.id, 7)).status, 200);
      await collections.coinLots(db).updateMany({ userId: zero.id, remaining: { $gt: 0 } }, { $set: { expiresAt: new Date(Date.now() - 1) } });
      await assert.rejects(energyConvert(db, zero.id, 1, randomUUID()), /insufficient_coins/);
      assert.equal((await wallet(zero.id)).coins, 0, 'read-time expiry commits even when the later spend fails');
      const missingId = await request('/admin/energy', 'POST', { user_id: zero.id, coins_delta: 2 }, undefined, 'test-admin-key');
      assert.equal(missingId.status, 409);
      const clampedId = randomUUID();
      const clamped = await Promise.all([adjust(zero.id, -100, clampedId), adjust(zero.id, -100, clampedId)]);
      assert.deepEqual(clamped.map((r) => r.status), [200, 200], 'zero-effect adjustments are also replay-safe');
      assert.equal(await collections.coinOperations(db).countDocuments({ userId: zero.id, requestId: clampedId }), 1);
      await reconcile(zero.id);
    });
    await ct.test('batch pagination is stable across timestamp ties and reconciliation is read-only', async () => {
      const account = await user();
      const at = new Date();
      await withTransaction(async (session) => {
        await collections.coinLots(db).insertMany(Array.from({ length: 55 }, () => {
          const id = randomUUID(); return { _id: id, userId: account.id, source: 'controller' as const,
            creditedAt: at, expiresAt: coinExpiry(at), amount: 1, remaining: 1, operationId: id };
        }), { session });
        await collections.atomicUsers(db).updateOne({ _id: account.id }, { $inc: { coins: 55 } }, { session });
      });
      const first = await json(await request('/energy/coins', 'GET', undefined, account.token));
      assert.equal(first.rows.length, 50); assert.ok(first.next_cursor);
      const second = await json(await request(`/energy/coins?cursor=${first.next_cursor}`, 'GET', undefined, account.token));
      assert.equal(second.rows.length, 6); assert.equal(second.next_cursor, null);
      assert.equal(new Set([...first.rows, ...second.rows].map((row: { id: string }) => row.id)).size, 56);
      const { auditCoinBalances } = await import('../src/lib/coinLots');
      const before = await collections.energyLedger(db).countDocuments({});
      const report = await auditCoinBalances(db);
      assert.equal(report.mismatchedWallets, 0); assert.equal(report.invalidLots, 0);
      assert.equal(await collections.energyLedger(db).countDocuments({}), before);
      const index = await collections.coinLots(db).find({ userId: account.id }).sort({ creditedAt: -1, _id: -1 }).limit(51).explain('executionStats');
      assert.ok(index.executionStats.totalDocsExamined <= 51);
      assert.equal((await request(`/admin/coins?user_id=${account.id}`)).status, 401);
      const adminPage = await json(await request(`/admin/coins?user_id=${account.id}`, 'GET', undefined, undefined, 'test-admin-key'));
      assert.equal(adminPage.rows.length, 50);
    });
    await ct.test('grant racing expiry, current reads, and rollback of configuration preserve batch authority', async () => {
      const account = await user();
      await collections.coinLots(db).updateMany({ userId: account.id }, { $set: { expiresAt: new Date(Date.now() - 1) } });
      const outcomes = await Promise.all([readCoinWallet(db, account.id), adjust(account.id, 9)]);
      assert.equal((outcomes[1] as Response).status, 200);
      assert.equal((await wallet(account.id)).coins, 9);
      assert.equal(await collections.energyLedger(db).countDocuments({ userId: account.id, reason: 'coin_expired' }), 1);
      const details = await json(await request('/energy/coins', 'GET', undefined, account.token));
      assert.equal(details.coins, 9); assert.equal(details.non_expiring_coins, 0); assert.equal(details.next_expiry_coins, 9);
      assert.equal(details.rows.length, 2);
      const accountEmail = (await collections.users(db).findOne({ _id: account.id }))!.email;
      const lookup = await json(await request(`/admin/user?email=${encodeURIComponent(accountEmail)}`, 'GET', undefined, undefined, 'test-admin-key'));
      assert.equal(lookup.coins, lookup.coin_details.coins);
      assert.equal(lookup.coins, 9);
      assert.equal((await request('/energy/coins')).status, 401);
      assert.equal((await request('/energy/coins?cursor=bad', 'GET', undefined, account.token)).status, 400);
      const other = await user();
      const isolated = await coinDetails(db, other.id);
      assert.equal(isolated!.rows.length, 1);
      assert.notEqual(isolated!.rows[0].id, details.rows[0].id);
      delete process.env.COIN_EXPIRY_ACTIVATED_AT;
      assert.equal((await adjust(account.id, 2)).status, 200);
      assert.equal((await lots(account.id)).filter((l) => l.source === 'controller').length, 2);
      assert.equal((await wallet(account.id)).coins, 11);
      await reconcile(account.id);
    });
    for (const collection of [collections.coinLots(db), collections.coinOperations(db)]) {
      assert.ok((await collection.listIndexes().toArray()).every((index) => index.expireAfterSeconds === undefined));
    }
  });

});
