import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import type { Document } from 'mongodb';
import { assertFixtureCleanup, fixtureDatabase } from './clientFixtureSafety.js';

// C27: the history below is written by the production charge, refund, grant,
// conversion, purchase, admin-credit and expiry functions against a generated
// local database. Legacy rows and three injected discrepancies are inserted by
// hand afterwards. The reconciliation then runs through the guarded read-only
// client; the test proves exact counts and that the run changed nothing.
const uri = process.env.MONGODB_URI;
const database = fixtureDatabase(uri); // canonical local replica set only; generated database name
process.env.MONGODB_DB_NAME = database;
const ADMIN_KEY = 'atomic-disposable-c27-admin-key'; // public, valid only in this generated test process
process.env.ADMIN_API_KEY = ADMIN_KEY;
process.env.TOKEN_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');
delete process.env.COIN_EXPIRY_ACTIVATED_AT;
const { getDb, closeDb, withTransaction } = await import('../src/db/mongo.js');
const { collections, ensureIndexes } = await import('../src/db/collections.js');
const { energyEnsure, energyConvert, energyGrantDaily, energyUpgradeNoteLimit } = await import('../src/lib/energy.js');
const { beginSync, debitSyncInSession, finishSync, fingerprintOf, recordSyncResult } = await import('../src/lib/syncOperation.js');
const { prepareCoinWallet } = await import('../src/lib/coinLots.js');
const { coinExpiry } = await import('../src/lib/coinPolicy.js');
const { initializeLedgerSequence } = await import('../src/lib/ledgerSequence.js');
const { default: adminRoute } = await import('../src/routes/admin.js');
const { SYNC_REFUND_NOTE } = await import('../src/db/economicReconciliation.js');
const { runReadOnlyReconciliation } = await import('../src/db/economicReconciliationRunner.js');

const DAY = 24 * 60 * 60 * 1000;
type Mode = 'standard' | 'instant';
const rowsOf = (n: number) => Array.from({ length: n }, () => ({ id: randomUUID() }));

test('reconciliation counts replay, legacy, refund and expiry cases exactly and writes nothing', { timeout: 300000 }, async (t) => {
  const db = await getDb();
  assertFixtureCleanup(db.databaseName, database);
  let owns = false;
  try {
    assert.equal((await db.listCollections({}, { nameOnly: true }).toArray()).length, 0, 'refuse a database collision');
    owns = true;
    await ensureIndexes(db); // production index definitions only
    const ledgerCount = (userId: string) => collections.energyLedger(db).countDocuments({ userId });
    /** Production push path: beginSync, stored per-row results, Server-side settlement. `null` leaves it pending. */
    const push = async (userId: string, mode: Mode, rows: { id: string }[], outcomes: boolean[] | null) => {
      const requestId = randomUUID();
      const operation = await beginSync(db, userId, requestId, rows, mode);
      if (outcomes) {
        for (const [i, ok] of outcomes.entries()) await recordSyncResult(db, operation, ok
          ? { id: rows[i].id, ok: true, updated_at: new Date().toISOString(), version: 1 } : { id: rows[i].id, ok: false, error: 'note_write_failed' });
        await finishSync(db, operation);
      }
      return { requestId, rows, mode, operation };
    };
    /** The same debit body the route, logout and recovery paths share, without the route's grant-before-charge. */
    const debit = async (userId: string, mode: Mode, rows: { id: string }[]) => {
      const requestId = randomUUID();
      const operation = await withTransaction(session =>
        debitSyncInSession(db, userId, requestId, rows, mode, fingerprintOf(rows, mode), new Date(), session));
      return { requestId, rows, mode, operation };
    };
    const settle = async (pushed: { operation: Parameters<typeof finishSync>[1]; rows: { id: string }[] }, outcomes: boolean[]) => {
      for (const [i, ok] of outcomes.entries()) await recordSyncResult(db, pushed.operation, ok
        ? { id: pushed.rows[i].id, ok: true, updated_at: new Date().toISOString(), version: 1 } : { id: pushed.rows[i].id, ok: false, error: 'note_write_failed' });
      return finishSync(db, pushed.operation);
    };
    /** Replaying a stored request id returns the stored operation and writes no ledger row. */
    const replay = async (userId: string, pushed: { requestId: string; rows: { id: string }[]; mode: Mode }) => {
      const before = await ledgerCount(userId);
      const again = await beginSync(db, userId, pushed.requestId, pushed.rows, pushed.mode);
      assert.equal(again.status, 'complete');
      await finishSync(db, again);
      assert.equal(await ledgerCount(userId), before, 'replay writes no charge or refund');
      return again;
    };
    const expireAt = async (userId: string, now: Date) => withTransaction(async session => {
      const wallet = await collections.atomicUsers(db).findOne({ _id: userId }, { session });
      await prepareCoinWallet(db, wallet!, session, now);
    });
    const admin = async (body: object) => {
      const response = await adminRoute.request('/energy', { method: 'POST',
        headers: { 'content-type': 'application/json', 'x-admin-api-key': ADMIN_KEY }, body: JSON.stringify(body) });
      assert.equal(response.status, 200);
      await response.arrayBuffer();
    };
    const wallet = async (userId: string) => (await collections.atomicUsers(db).findOne({ _id: userId }))!;

    // A: scalar (pre-lot) wallet. Charges, a capped refund, replays, a full refund, a partial failure,
    // a zero-row request and an abandoned request settled by the next one.
    const A = randomUUID();
    await energyEnsure(db, A);
    await energyConvert(db, A, 2);
    await energyConvert(db, A, 1); // 120 energy: the cap
    await settle(await debit(A, 'instant', rowsOf(1)), [true]);
    await settle(await debit(A, 'standard', rowsOf(1)), [true]);
    const capped = await debit(A, 'instant', rowsOf(1));
    await energyGrantDaily(db, A); // lands between the charge and the refund, filling the cap
    const cappedResult = await settle(capped, [false]);
    assert.deepEqual([cappedResult.charged, cappedResult.refunded], [10, 5]);
    await replay(A, capped);
    const refunded = await push(A, 'instant', rowsOf(2), [false, false]);
    assert.equal((await replay(A, refunded)).refunded, 10);
    await push(A, 'instant', rowsOf(2), [true, false]);
    await push(A, 'instant', [], []);
    const abandoned = await push(A, 'instant', rowsOf(1), null);
    await push(A, 'instant', rowsOf(1), [true]); // settles the abandoned operation first
    assert.equal((await db.collection('sync_operations').findOne({ _id: abandoned.operation._id } as Document))!.refunded, 10);
    assert.deepEqual([(await wallet(A)).coins, (await wallet(A)).energy, await ledgerCount(A)], [2, 100, 14]);

    // Coin lots (expiry policy activated only inside this process, for the remaining owners).
    process.env.COIN_EXPIRY_ACTIVATED_AT = '2020-01-01T00:00:00.000Z';
    const expiryNow = new Date(coinExpiry(new Date()).getTime() + 31 * DAY);
    const asOf = new Date(expiryNow.getTime() + DAY);

    // B: welcome lot, linked conversion and its replay, linked admin credit, an unlinked purchase
    // (energyUpgradeNoteLimit accepts no request id), then expiry of the remainder.
    const B = randomUUID();
    await energyEnsure(db, B);
    const convertB = randomUUID();
    await energyConvert(db, B, 1, convertB);
    const beforeReplay = await ledgerCount(B);
    await energyConvert(db, B, 1, convertB);
    assert.equal(await ledgerCount(B), beforeReplay, 'coin replay writes nothing');
    await admin({ user_id: B, request_id: randomUUID(), coins_delta: 10, energy_delta: 0 });
    await energyUpgradeNoteLimit(db, B, 30);
    assert.equal(await db.collection('coin_operations').countDocuments({ userId: B }), 2, 'the purchase left no receipt');
    await expireAt(B, expiryNow);
    assert.deepEqual([(await wallet(B)).coins, await ledgerCount(B)], [0, 5]);

    // E: an active welcome lot that is due at asOf but unsettled. F: fully explained by conversion plus expiry.
    const E = randomUUID(), F = randomUUID();
    for (const owner of [E, F]) { await energyEnsure(db, owner); await energyConvert(db, owner, 1, randomUUID()); }
    await expireAt(F, expiryNow);

    // G: sequenced history trimmed by the retention writer: 26 failed syncs, each charged and refunded.
    const G = randomUUID();
    await energyEnsure(db, G);
    await withTransaction(session => initializeLedgerSequence(db, G, session));
    await energyConvert(db, G, 2, randomUUID());
    for (let i = 0; i < 26; i++) await push(G, 'instant', rowsOf(1), [false]);
    assert.equal(await ledgerCount(G), 50, 'retention keeps the newest 50 rows');
    const archive = await db.collection('ledger_history_archives').findOne({ _id: G } as Document);
    assert.equal(Object.values(archive!.byKind as Record<string, number>).reduce((n, v) => n + v, 0), 5);

    // D1-D4: real histories, then one injected discrepancy each.
    const [D1, D2, D3, D4] = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];
    for (const owner of [D1, D2, D3, D4]) await energyEnsure(db, owner);
    for (const owner of [D1, D2, D4]) await energyConvert(db, owner, 2, randomUUID());
    await energyConvert(db, D3, 1, randomUUID());
    await push(D1, 'instant', rowsOf(1), [true]);
    await push(D2, 'instant', rowsOf(1), [true]);
    const partial = await push(D4, 'instant', rowsOf(2), [true, false]);
    // D1: an orphan sync refund row, balance-consistent so only the refund reconciliation can see it.
    const d1 = await wallet(D1);
    await collections.energyLedger(db).insertOne({ _id: randomUUID(), userId: D1, kind: 'admin_adjust', coinsDelta: 0, energyDelta: 10,
      resultingCoins: d1.coins, resultingEnergy: d1.energy + 10, note: SYNC_REFUND_NOTE, createdAt: new Date() });
    await collections.atomicUsers(db).updateOne({ _id: D1 }, { $inc: { energy: 10 } });
    // D2: a second charge row for its single charged operation (a double charge), also balance-consistent.
    const d2 = await wallet(D2);
    await collections.energyLedger(db).insertOne({ _id: randomUUID(), userId: D2, kind: 'spend', coinsDelta: 0, energyDelta: -10,
      resultingCoins: d2.coins, resultingEnergy: d2.energy - 10, note: 'Instant sync', createdAt: new Date() });
    await collections.atomicUsers(db).updateOne({ _id: D2 }, { $inc: { energy: -10 } });
    // D3: a lot with negative remaining coins.
    const injectedAt = new Date();
    await collections.coinLots(db).insertOne({ _id: `${D3}:c27-injected`, userId: D3, source: 'controller', creditedAt: injectedAt,
      expiresAt: coinExpiry(injectedAt), amount: 2, remaining: -1, operationId: `${D3}:c27-injected` });
    // D4: an operation whose stored refund exceeds its charge, with one delivered row.
    await db.collection('sync_operations').updateOne({ _id: partial.operation._id } as Document, { $set: { refunded: 15 } });
    delete process.env.COIN_EXPIRY_ACTIVATED_AT;

    // C: a legacy wallet with an imported, internally consistent history and no provenance at all.
    const C = randomUUID();
    const base = Date.parse('2025-01-01T00:00:00.000Z');
    await collections.atomicUsers(db).insertOne({ _id: C, username: '', noteLimit: 30, coins: 7, energy: 30, energyCap: 120,
      lastDailyGrantAt: null, lastStandardSyncAt: null, createdAt: new Date(base) });
    let coins = 0, energy = 0;
    const legacy = [['admin_adjust', 5, 0, 'Legacy import'], ['daily_grant', 0, 20, 'Daily energy grant'], ['convert', -1, 40, 'Converted 1 coins'],
      ['spend', 0, -5, 'Standard sync'], ['admin_adjust', 0, 5, SYNC_REFUND_NOTE], ['spend', 0, -5, 'Standard sync'],
      ['admin_adjust', 3, -25, 'Legacy import']] as const;
    await collections.energyLedger(db).insertMany(legacy.map(([kind, coinsDelta, energyDelta, note], i) => {
      coins += coinsDelta; energy += energyDelta;
      return { _id: randomUUID(), userId: C, kind, coinsDelta, energyDelta, resultingCoins: coins, resultingEnergy: energy, note,
        createdAt: new Date(base + i * 60 * 60 * 1000) };
    }));
    assert.deepEqual([coins, energy], [7, 30]);

    // Read-only reconciliation: same snapshot reader as the operator script, through the C25 command guard.
    const before = await db.command({ dbHash: 1 });
    const first = await runReadOnlyReconciliation(uri, database, { asOf });
    const second = await runReadOnlyReconciliation(uri, database, { asOf });
    const scoped = await runReadOnlyReconciliation(uri, database, { asOf, owner: D2 });
    const after = await db.command({ dbHash: 1 });
    assert.equal(after.md5, before.md5, 'the reconciliation wrote nothing');
    assert.deepEqual(after.collections, before.collections);
    const allowed = new Set(['aggregate', 'buildInfo', 'count', 'endSessions', 'find', 'getMore', 'hello', 'isMaster', 'ismaster',
      'killCursors', 'listCollections', 'listIndexes', 'ping', 'saslContinue', 'saslStart']);
    for (const run of [first, second, scoped]) {
      assert.deepEqual(run.violations, []);
      assert.deepEqual(Object.keys(run.commands).filter(name => !allowed.has(name)), [], JSON.stringify(run.commands));
      assert.equal(run.report.snapshot, true);
    }
    assert.deepEqual(second.report, first.report, 'repeatable on the same data');
    const report = first.report;
    t.diagnostic(`ECONOMIC_RECONCILIATION_REPORT ${JSON.stringify({ population: report.population, catalog: report.catalog,
      summary: report.summary, commands: first.commands })}`);
    for (const [id, tally] of Object.entries(report.invariants)) {
      t.diagnostic(`ECONOMIC_RECONCILIATION_INVARIANT ${id} ${JSON.stringify({ conforming: tally.conforming, discrepant: tally.discrepant,
        unknown: tally.unknown, reasons: tally.reasons, rowsOutsideWindow: tally.rowsOutsideWindow })}`);
    }

    // Sanitized: no owner, record, lot or receipt ids, notes, or database name.
    const text = JSON.stringify([first.report, scoped.report]);
    for (const secret of [A, B, C, E, F, G, D1, D2, D3, D4, convertB, database, 'Legacy import', 'Instant sync', SYNC_REFUND_NOTE]) {
      assert.ok(!text.includes(secret));
    }

    assert.deepEqual(report.population, { wallets: 10, ownersWithoutWallet: 0, ledgerRows: 97, syncOperations: 37, coinLots: 10,
      coinReceipts: 9, archivedOwners: 1, malformedOwnerRows: 0 });
    assert.deepEqual(report.catalog, { ledgerTtlIndexes: 0, syncOperationTtlIndexes: 0 });
    const expected: Record<string, [number, number, number, Record<string, number>]> = {
      wallet_ledger_chain: [10, 0, 0, {}],
      wallet_lot_balance: [7, 0, 1, { invalid_lot: 1 }],
      coin_row_provenance: [10, 0, 14, { unlinked_current: 8, unlinked_legacy: 6 }],
      sync_charge_policy: [37, 0, 0, {}],
      sync_refund_bounds: [36, 1, 0, { refund_exceeds_charge: 1 }],
      sync_settlement_results: [37, 0, 0, {}],
      sync_charge_ledger: [3, 1, 2, { ledger_history_trimmed: 1, unlinked_legacy: 1, unmatched_charge_rows: 1 }],
      sync_refund_ledger: [1, 2, 2, { ledger_history_trimmed: 1, missing_refund_rows: 1, orphan_refund_rows: 1, unlinked_legacy: 1 }],
      lot_bounds: [9, 1, 0, { negative_remaining: 1 }],
      lot_consumption: [7, 0, 3, { invalid_lot: 1, unlinked_consumption: 2 }],
      lot_expiry: [9, 0, 1, { due_unsettled: 6, invalid_lot: 1 }],
      coin_receipt_ledger: [8, 0, 1, { ledger_history_trimmed: 1 }],
    };
    const actual = Object.fromEntries(Object.entries(report.invariants).map(([id, tally]) =>
      [id, [tally.conforming, tally.discrepant, tally.unknown, tally.reasons]]));
    assert.deepEqual(actual, expected);
    assert.equal(report.invariants.sync_charge_ledger.rowsOutsideWindow, 2);
    assert.equal(report.invariants.sync_refund_ledger.rowsOutsideWindow, 1);
    assert.deepEqual(report.summary.discrepantInvariants, ['sync_refund_bounds', 'sync_charge_ledger', 'sync_refund_ledger', 'lot_bounds']);
    assert.deepEqual([report.summary.conforming, report.summary.discrepant, report.summary.unknown], [174, 5, 24]);

    // Owner scope: only that owner's records, still sanitized.
    assert.equal(scoped.report.scope, 'single-owner');
    assert.deepEqual(scoped.report.population, { wallets: 1, ownersWithoutWallet: 0, ledgerRows: 5, syncOperations: 1, coinLots: 1,
      coinReceipts: 1, archivedOwners: 0, malformedOwnerRows: 0 });
    assert.deepEqual(scoped.report.summary.discrepantInvariants, ['sync_charge_ledger']);
  } finally {
    assertFixtureCleanup(db.databaseName, database);
    if (owns) await db.dropDatabase();
    await closeDb();
  }
});
