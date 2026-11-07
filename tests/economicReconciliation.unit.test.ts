import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import {
  REORDER_WINDOW_MS, Tally, reconcileOwner, refHash, summarizeInvariants, walletChain,
  type InvariantId, type LedgerRecord, type OperationRecord, type OwnerBundle,
} from '../src/db/economicReconciliation.js';
import { reconciliationArguments, runReadOnlyReconciliation } from '../src/db/economicReconciliationRunner.js';
import { assertSanitized } from '../src/db/queryDiagnostics.js';

// Synthetic, in-memory records shaped like the real writers' output. No database.
const owner = randomUUID();
const T0 = Date.parse('2030-01-01T00:00:00.000Z');
const at = (minutes: number) => new Date(T0 + minutes * 60_000);
const asOf = at(60 * 24 * 400);
const context = { asOf, ledgerMayExpire: false };

let counter = 0;
type Balance = { coins: number; energy: number };
/** Builds a chained history like the real writers: each row stores the balance after its own delta. */
function history(start: Balance, entries: (Partial<LedgerRecord> & { coinsDelta?: number; energyDelta?: number; minute: number })[]) {
  let { coins, energy } = start;
  const rows: LedgerRecord[] = entries.map(({ minute, ...entry }) => {
    coins += entry.coinsDelta ?? 0; energy += entry.energyDelta ?? 0;
    return { _id: randomUUID(), userId: owner, kind: 'admin_adjust', coinsDelta: 0, energyDelta: 0, note: '',
      ...entry, resultingCoins: coins, resultingEnergy: energy, createdAt: at(minute) };
  });
  return { rows, wallet: { _id: owner, coins, energy } };
}
const op = (minute: number, extra: Partial<OperationRecord> = {}): OperationRecord => ({ _id: `${owner}:op-${++counter}`,
  mode: 'instant', rowIds: ['n1'], charged: 10, refunded: 0, status: 'complete', results: [{ id: 'n1', ok: true }],
  createdAt: at(minute), logoutTagged: false, ...extra });
const bundle = (extra: Partial<OwnerBundle>): OwnerBundle =>
  ({ wallet: null, ledger: [], operations: [], lots: [], receipts: [], archived: false, ...extra });
function run(b: OwnerBundle, ctx = context) {
  const tally = new Tally();
  reconcileOwner(b, ctx, tally);
  return tally.result();
}
const counts = (r: ReturnType<typeof run>, id: InvariantId) => {
  const { conforming, discrepant, unknown, reasons } = r[id];
  return { conforming, discrepant, unknown, reasons };
};
const spend = (minute: number, amount = 10) => ({ kind: 'spend', energyDelta: -amount, minute });
const syncRefund = (minute: number, amount: number) => ({ kind: 'admin_adjust', energyDelta: amount, syncRefund: true, minute });

test('replay: one stored operation and one charge row reconcile; a duplicated charge row or receipt row does not', () => {
  const ok = history({ coins: 0, energy: 100 }, [spend(10)]);
  const single = run(bundle({ wallet: ok.wallet, ledger: ok.rows, operations: [op(10)] }));
  assert.deepEqual(counts(single, 'sync_charge_ledger'), { conforming: 1, discrepant: 0, unknown: 0, reasons: {} });
  for (const id of ['sync_charge_policy', 'sync_refund_bounds', 'sync_settlement_results', 'wallet_ledger_chain'] as const) {
    assert.equal(single[id].conforming, 1, id);
  }
  // A second charge row for the same single operation (a non-idempotent replay) is discrepant.
  const doubled = history({ coins: 0, energy: 100 }, [spend(10), spend(10)]);
  const twice = run(bundle({ wallet: doubled.wallet, ledger: doubled.rows, operations: [op(10)] }));
  assert.deepEqual(counts(twice, 'sync_charge_ledger'), { conforming: 0, discrepant: 1, unknown: 0, reasons: { unmatched_charge_rows: 1 } });
  assert.equal(twice.wallet_ledger_chain.conforming, 1, 'the duplicate is internally consistent; only the reconciliation finds it');
  assert.equal(twice.sync_charge_ledger.samples.length, 1);
  assert.match(twice.sync_charge_ledger.samples[0].ref, /^[0-9a-f]{12}$/);

  // Coin replay: one receipt and one ledger row per request id.
  const lot = { _id: `${owner}:opening`, amount: 5, remaining: 4, expiresAt: at(60 * 24 * 180) };
  const receipt = { _id: `${owner}:request-1`, allocations: [{ lotId: lot._id, amount: 1 }], createdAt: at(5) };
  const convert = { kind: 'convert', coinsDelta: -1, energyDelta: 40, coinOperationId: receipt._id, lotIds: [lot._id], minute: 5 };
  const once = history({ coins: 5, energy: 0 }, [convert]);
  const coinWallet = { ...once.wallet, coinLotsVersion: 1, coinPolicyActivatedAt: at(0) };
  const replayed = run(bundle({ wallet: coinWallet, ledger: once.rows, lots: [lot], receipts: [receipt] }));
  assert.equal(replayed.coin_receipt_ledger.conforming, 1);
  assert.equal(replayed.coin_row_provenance.conforming, 1);
  assert.equal(replayed.lot_consumption.conforming, 1);
  assert.equal(replayed.wallet_lot_balance.conforming, 1);
  const repeated = history({ coins: 5, energy: 0 }, [convert, { ...convert, minute: 6 }]);
  const duplicate = run(bundle({ wallet: { ...repeated.wallet, coinLotsVersion: 1 }, ledger: repeated.rows,
    lots: [{ ...lot, remaining: 3 }], receipts: [receipt] }));
  assert.deepEqual(counts(duplicate, 'coin_receipt_ledger').reasons, { duplicate_ledger_rows: 1 });
});

test('missing legacy source: rows without stored references are counted as unlinked, never matched', () => {
  // A legacy wallet: no operations survive, and no coin row carries a reference.
  const legacy = history({ coins: 0, energy: 0 }, [
    { coinsDelta: 5, minute: 0 }, { kind: 'daily_grant', energyDelta: 20, minute: 10 },
    { kind: 'convert', coinsDelta: -1, energyDelta: 40, minute: 20 }, spend(30, 5), syncRefund(31, 5), spend(40, 5)]);
  const result = run(bundle({ wallet: legacy.wallet, ledger: legacy.rows }));
  assert.deepEqual(counts(result, 'coin_row_provenance'), { conforming: 0, discrepant: 0, unknown: 2, reasons: { unlinked_legacy: 2 } });
  assert.deepEqual(counts(result, 'sync_charge_ledger'), { conforming: 0, discrepant: 0, unknown: 1, reasons: { unlinked_legacy: 1 } });
  assert.equal(result.sync_charge_ledger.rowsOutsideWindow, 2);
  assert.deepEqual(counts(result, 'sync_refund_ledger'), { conforming: 0, discrepant: 0, unknown: 1, reasons: { unlinked_legacy: 1 } });
  assert.equal(result.sync_refund_ledger.rowsOutsideWindow, 1);
  assert.equal(result.wallet_ledger_chain.conforming, 1);

  // Old charge rows before the oldest retained operation stay unmatched even when an amount would "fit":
  // only rows inside the retained window are reconciled, so no row is attributed to a deleted operation.
  const mixed = history({ coins: 0, energy: 100 }, [spend(0), spend(100)]);
  const windowed = run(bundle({ wallet: mixed.wallet, ledger: mixed.rows, operations: [op(100)] }));
  assert.deepEqual(counts(windowed, 'sync_charge_ledger'), { conforming: 1, discrepant: 0, unknown: 0, reasons: {} });
  assert.equal(windowed.sync_charge_ledger.rowsOutsideWindow, 1);

  // Rows written after coin-lot activation without references are current writers, not legacy.
  const current = history({ coins: 0, energy: 0 }, [{ coinsDelta: 5, minute: 10 }, { kind: 'purchase', coinsDelta: -5, minute: 20 }]);
  const activated = run(bundle({ wallet: { ...current.wallet, coinLotsVersion: 1, coinPolicyActivatedAt: at(5) }, ledger: current.rows,
    lots: [{ _id: `${owner}:opening`, amount: 5, remaining: 0, expiresAt: null }] }));
  assert.deepEqual(counts(activated, 'coin_row_provenance').reasons, { unlinked_current: 2 });
  // Consumption with only an unreferenced debit to explain it cannot be decided.
  assert.deepEqual(counts(activated, 'lot_consumption'), { conforming: 0, discrepant: 0, unknown: 1, reasons: { unlinked_consumption: 1 } });
  // A reference to a record that is not this owner's is discrepant.
  const foreign = history({ coins: 1, energy: 0 }, [{ kind: 'convert', coinsDelta: -1, energyDelta: 40, coinOperationId: 'other:request', minute: 1 }]);
  assert.deepEqual(counts(run(bundle({ wallet: foreign.wallet, ledger: foreign.rows })), 'coin_row_provenance').reasons, { reference_not_owned: 1 });
});

test('refund: capped refunds reconcile; orphan, excessive, delivered and missing refunds are discrepant', () => {
  // Refunds are capped at the energy cap (syncOperation.ts:183): 5 of 10 refunded, all rows failed.
  const capped = history({ coins: 0, energy: 105 }, [spend(10), { kind: 'daily_grant', energyDelta: 20, minute: 11 }, syncRefund(12, 5)]);
  const failed = op(10, { refunded: 5, results: [{ id: 'n1', ok: false }] });
  const result = run(bundle({ wallet: capped.wallet, ledger: capped.rows, operations: [failed] }));
  assert.equal(result.sync_refund_ledger.conforming, 1);
  assert.equal(result.sync_refund_bounds.conforming, 1);
  assert.equal(result.sync_charge_ledger.conforming, 1);
  assert.equal(result.wallet_ledger_chain.conforming, 1);

  const orphan = history({ coins: 0, energy: 90 }, [spend(10), syncRefund(12, 10)]);
  assert.deepEqual(counts(run(bundle({ wallet: orphan.wallet, ledger: orphan.rows, operations: [op(10)] })), 'sync_refund_ledger').reasons,
    { orphan_refund_rows: 1 });

  const ops = [op(10, { refunded: 15, results: [{ id: 'n1', ok: false }] }), op(20, { refunded: 10 }),
    op(30, { status: 'pending', refunded: 10, results: [] })];
  const bounds = run(bundle({ operations: ops }));
  assert.deepEqual(counts(bounds, 'sync_refund_bounds').reasons,
    { pending_with_refund: 1, refund_exceeds_charge: 1, refund_with_delivered_row: 1 });
  assert.deepEqual(counts(bounds, 'sync_settlement_results'), { conforming: 2, discrepant: 0, unknown: 1, reasons: { pending_operation: 1 } });

  // A refunded operation with no refund row: discrepant, unless retention trimmed the owner's history.
  const charged = history({ coins: 0, energy: 100 }, [spend(10)]);
  const missing = bundle({ wallet: charged.wallet, ledger: charged.rows, operations: [op(10, { refunded: 10, results: [{ id: 'n1', ok: false }] })] });
  assert.deepEqual(counts(run(missing), 'sync_refund_ledger').reasons, { missing_refund_rows: 1 });
  assert.deepEqual(counts(run({ ...missing, archived: true }), 'sync_refund_ledger'),
    { conforming: 0, discrepant: 0, unknown: 1, reasons: { ledger_history_trimmed: 1 } });
  assert.deepEqual(counts(run(missing, { ...context, ledgerMayExpire: true }), 'sync_refund_ledger').reasons, { ledger_history_trimmed: 1 });

  // Charge policy: current costs only; zero-row and unpaid emergency logout batches charge nothing.
  const policy = run(bundle({ operations: [op(1, { mode: 'standard', charged: 5 }), op(2, { charged: 7 }), op(3, { rowIds: [], results: [], charged: 0 }),
    op(4, { rowIds: [], results: [], charged: 10 }), op(5, { charged: 0, logoutTagged: true }), op(6, { charged: 0 })] }));
  assert.deepEqual(counts(policy, 'sync_charge_policy'), { conforming: 3, discrepant: 3, unknown: 0,
    reasons: { charge_not_current_policy: 2, charged_without_rows: 1 } });
});

test('expiration: settled, due-unsettled, early, repeated and post-expiry consumption are counted exactly', () => {
  const expires = at(60 * 24 * 180);
  const lot = { _id: `${owner}:lot-a`, amount: 5, remaining: 0, expiresAt: expires };
  const receipt = { _id: `${owner}:request-a`, allocations: [{ lotId: lot._id, amount: 1 }], createdAt: at(10) };
  const expiryMinute = 60 * 24 * 181;
  const settled = history({ coins: 5, energy: 0 }, [
    { kind: 'convert', coinsDelta: -1, energyDelta: 40, coinOperationId: receipt._id, lotIds: [lot._id], minute: 10 },
    { coinsDelta: -4, reason: 'coin_expired', lotIds: [lot._id], minute: expiryMinute }]);
  const wallet = { ...settled.wallet, coinLotsVersion: 1, coinPolicyActivatedAt: at(0) };
  const result = run(bundle({ wallet, ledger: settled.rows, lots: [lot], receipts: [receipt] }));
  for (const id of ['lot_bounds', 'lot_consumption', 'lot_expiry', 'wallet_lot_balance', 'coin_receipt_ledger', 'wallet_ledger_chain'] as const) {
    assert.deepEqual(counts(result, id), { conforming: 1, discrepant: 0, unknown: 0, reasons: {} }, id);
  }
  assert.equal(result.coin_row_provenance.conforming, 2, 'the expiry row is linked to its lot');

  // Due but not yet settled: expiry is lazy (coinLots.ts:34), so this is conforming, with a reason.
  const due = run(bundle({ wallet: { _id: owner, coins: 4, energy: 0, coinLotsVersion: 1 }, lots: [{ ...lot, remaining: 4 }],
    receipts: [receipt], ledger: history({ coins: 5, energy: 0 }, [{ kind: 'convert', coinsDelta: -1, energyDelta: 0,
      coinOperationId: receipt._id, lotIds: [lot._id], minute: 10 }]).rows }));
  assert.deepEqual(counts(due, 'lot_expiry'), { conforming: 1, discrepant: 0, unknown: 0, reasons: { due_unsettled: 1 } });

  const late = { ...receipt, createdAt: at(60 * 24 * 182) };
  const early = { coinsDelta: -4, reason: 'coin_expired', lotIds: [lot._id], minute: 60 };
  const cases = [
    { name: 'consumed_after_expiry', receipts: [late], entries: [early] },
    { name: 'expired_before_due', receipts: [receipt], entries: [early] },
    { name: 'repeated_expiry', receipts: [receipt], entries: [{ ...early, coinsDelta: -2, minute: expiryMinute },
      { ...early, coinsDelta: -2, minute: expiryMinute + 1 }] },
  ];
  for (const c of cases) {
    const rows = history({ coins: 5, energy: 0 }, c.entries).rows;
    assert.deepEqual(counts(run(bundle({ lots: [{ ...lot, remaining: 1 }], receipts: c.receipts, ledger: rows })), 'lot_expiry').reasons,
      { [c.name]: 1 }, c.name);
  }
  // Consumption that no stored record explains is discrepant when nothing unlinked or trimmed could explain it.
  assert.deepEqual(counts(run(bundle({ lots: [{ ...lot, remaining: 2 }] })), 'lot_consumption').reasons, { unexplained_consumption: 1 });
  assert.deepEqual(counts(run(bundle({ lots: [{ ...lot, remaining: 2 }], archived: true })), 'lot_consumption').reasons, { unlinked_consumption: 1 });
  assert.deepEqual(counts(run(bundle({ lots: [{ ...lot, remaining: 5 }], receipts: [receipt] })), 'lot_consumption').reasons, { over_explained: 1 });
  // Negative and inconsistent lots are bounds discrepancies; dependent checks cannot be decided.
  const negative = run(bundle({ wallet: { _id: owner, coins: 3, energy: 0, coinLotsVersion: 1 }, lots: [{ ...lot, remaining: -1 }] }));
  assert.deepEqual(counts(negative, 'lot_bounds').reasons, { negative_remaining: 1 });
  assert.deepEqual(counts(negative, 'lot_consumption').reasons, { invalid_lot: 1 });
  assert.deepEqual(counts(negative, 'lot_expiry').reasons, { invalid_lot: 1 });
  assert.deepEqual(counts(negative, 'wallet_lot_balance').reasons, { invalid_lot: 1 });
  const mismatch = run(bundle({ wallet: { _id: owner, coins: 3, energy: 0, coinLotsVersion: 1 }, lots: [{ ...lot, remaining: 2 }] }));
  assert.deepEqual(counts(mismatch, 'wallet_lot_balance').reasons, { scalar_lot_mismatch: 1 });
  assert.deepEqual(counts(run(bundle({ wallet: { _id: owner, coins: 2, energy: 0 }, lots: [{ ...lot, remaining: 2 }] })),
    'wallet_lot_balance').reasons, { lots_without_migration: 1 });
});

test('balance chain: sequence order is strict; unmarked order tolerates only commit reordering inside the window', () => {
  const { rows, wallet } = history({ coins: 0, energy: 100 }, [spend(0), spend(1), { kind: 'daily_grant', energyDelta: 20, minute: 2 }]);
  assert.deepEqual(walletChain(wallet, rows), { outcome: 'conforming', reason: null });
  assert.deepEqual(walletChain({ ...wallet, energy: wallet.energy + 1 }, rows), { outcome: 'discrepant', reason: 'tail_mismatch' });
  // Marked wallets: historySequence is the commit order.
  const sequenced = rows.map((row, i) => ({ ...row, historySequence: i + 1 }));
  assert.equal(walletChain({ ...wallet, historyRetentionVersion: 1 }, sequenced).outcome, 'conforming');
  const swapped = sequenced.map((row, i) => ({ ...row, historySequence: [2, 1, 3][i] }));
  assert.deepEqual(walletChain({ ...wallet, historyRetentionVersion: 1 }, swapped), { outcome: 'discrepant', reason: 'chain_break' });
  assert.deepEqual(walletChain({ ...wallet, historyRetentionVersion: 1 }, rows), { outcome: 'unknown', reason: 'malformed_rows' });
  // Unmarked: a transaction that computed its time earlier but committed later is still a valid order...
  const retried = rows.map((row, i) => i === 1 ? { ...row, createdAt: at(-1) } : row);
  assert.equal(walletChain(wallet, retried).outcome, 'conforming');
  // ...but not when the inversion exceeds one retry window: the only admissible order ends at the wrong balance.
  const far = rows.map((row, i) => i === 1 ? { ...row, createdAt: new Date(T0 - REORDER_WINDOW_MS - 60_000) } : row);
  assert.deepEqual(walletChain(wallet, far), { outcome: 'discrepant', reason: 'tail_mismatch' });
  // A gap in the chain (an unledgered balance change) is a break.
  const gap = rows.map((row, i) => i === 2 ? { ...row, resultingEnergy: (row.resultingEnergy as number) + 3 } : row);
  assert.deepEqual(walletChain({ ...wallet, energy: wallet.energy + 3 }, gap), { outcome: 'discrepant', reason: 'chain_break' });
  assert.deepEqual(walletChain(wallet, []), { outcome: 'unknown', reason: 'no_retained_rows' });
  assert.deepEqual(walletChain({ _id: owner, coins: 'x', energy: 1 }, rows), { outcome: 'unknown', reason: 'malformed_wallet' });
  // Many interchangeable rows in one window are resolved once per distinct step, not by enumerating permutations.
  const burst = history({ coins: 0, energy: 120 }, Array.from({ length: 60 }, (_, i) => i % 2 ? syncRefund(0, 10) : spend(0)));
  assert.equal(walletChain(burst.wallet, burst.rows).outcome, 'conforming');
});

test('reports are deterministic, sanitized counts and the runner refuses unsafe inputs before connecting', async () => {
  const { rows, wallet } = history({ coins: 0, energy: 100 }, [spend(10), spend(11)]);
  const b = bundle({ wallet, ledger: rows, operations: [op(10)] });
  const first = run(b), second = run(structuredClone(b));
  assert.deepEqual(first, second);
  const summary = summarizeInvariants(first);
  assert.deepEqual(summary.discrepantInvariants, ['sync_charge_ledger']);
  assert.equal(summary.countsDigest, summarizeInvariants(run(structuredClone(b))).countsDigest);
  assert.match(summary.countsDigest, /^[0-9a-f]{16}$/);
  const text = JSON.stringify({ first, summary });
  assert.ok(!text.includes(owner));
  for (const row of rows) assert.ok(!text.includes(String(row._id)));
  assertSanitized({ first, summary });
  assert.equal(refHash('x'), refHash('x'));
  assert.notEqual(refHash('x'), refHash('y'));

  assert.deepEqual(reconciliationArguments(['--read-only', '--database', 'atomic_notes']), { database: 'atomic_notes' });
  const id = randomUUID();
  assert.deepEqual(reconciliationArguments(['--read-only', '--database', 'db1', '--owner', id, '--as-of', '2030-01-01T00:00:00.000Z']),
    { database: 'db1', owner: id, asOf: new Date('2030-01-01T00:00:00.000Z') });
  for (const bad of [[], ['--apply'], ['--read-only'], ['--read-only', '--database', 'a.b'], ['--read-only', '--database', 'x', '--owner', 'nope'],
    ['--read-only', '--database', 'x', '--as-of', '2030-01-01'], ['--read-only', '--database', 'x', '--owner', id, '--owner', id],
    ['--read-only', '--database', 'x', '--repair']]) {
    assert.throws(() => reconciliationArguments(bad), /^Error: usage:/, JSON.stringify(bad));
  }
  await assert.rejects(runReadOnlyReconciliation(undefined, 'x'), /explain_uri_required/);
  await assert.rejects(runReadOnlyReconciliation('http://example.invalid', 'x'), /explain_uri_invalid/);
  await assert.rejects(runReadOnlyReconciliation('mongodb://127.0.0.1:1', 'bad.name'), /reconciliation_database_invalid/);
});

// Bounded diagnostics: samples are the smallest `sampleLimit` candidates under the report's sort key,
// retained in O(limit) memory, while every counter stays exact.
type Sample = { reason: string; ref: string };
const sampleOrder = (a: Sample, b: Sample) => a.reason.localeCompare(b.reason) || a.ref.localeCompare(b.ref);
const discrepancies = (n: number) => Array.from({ length: n }, (_, i) =>
  ({ reason: ['scalar_lot_mismatch', 'lots_without_migration', 'malformed_lot'][i % 3], subject: `subject-${i % 1_700}` }));
/** Deterministic Fisher-Yates shuffle (mulberry32), so a failure is reproducible. */
function shuffled<T>(items: readonly T[], seed: number): T[] {
  const out = [...items];
  let s = seed >>> 0;
  const next = () => { s = (s + 0x6d2b79f5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 2 ** 32; };
  for (let i = out.length - 1; i > 0; i--) { const j = Math.floor(next() * (i + 1)); [out[i], out[j]] = [out[j], out[i]]; }
  return out;
}

test('samples: retained buffer never exceeds the limit while counters stay exact', () => {
  const limit = 4, input = discrepancies(5_000);
  const tally = new Tally(limit);
  let peak = 0;
  for (const [i, { reason, subject }] of input.entries()) {
    tally.add('lot_bounds', 'discrepant', reason, subject);
    if (i % 2 === 0) tally.add('lot_bounds', 'conforming', null, subject);
    tally.add('lot_consumption', 'unknown', 'invalid_lot', subject);
    peak = Math.max(peak, ...Object.values(tally.invariants).map(entry => entry.samples.length));
  }
  assert.ok(peak <= limit, `retained ${peak} samples with limit ${limit}`);
  const result = tally.result();
  assert.equal(result.lot_bounds.discrepant, 5_000);
  assert.equal(result.lot_bounds.conforming, 2_500);
  assert.deepEqual(result.lot_bounds.reasons, { lots_without_migration: 1_667, malformed_lot: 1_666, scalar_lot_mismatch: 1_667 });
  assert.equal(result.lot_bounds.samples.length, limit);
  assert.equal(result.lot_consumption.unknown, 5_000);
  assert.deepEqual(result.lot_consumption.samples, [], 'only discrepant outcomes are sampled');

  const none = new Tally(0);
  for (const { reason, subject } of input) none.add('lot_bounds', 'discrepant', reason, subject);
  assert.equal(none.invariants.lot_bounds.samples.length, 0);
  assert.equal(none.result().lot_bounds.discrepant, 5_000);
  for (const bad of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) assert.throws(() => new Tally(bad), RangeError, String(bad));
});

test('samples: shuffled input orders give byte-identical samples and counters, equal to sort-all-then-slice', () => {
  // Includes repeated subjects, so equal keys are retained exactly as the unbounded sort would retain them.
  const input = discrepancies(3_000);
  const expected = input.map(({ reason, subject }) => ({ reason, ref: refHash(subject) })).sort(sampleOrder);
  for (const limit of [1, 3, 10, 2_999, 3_000, 3_500]) {
    const outputs = new Set<string>();
    for (const seed of [1, 2, 3, 42, 2030]) {
      const tally = new Tally(limit);
      for (const { reason, subject } of seed === 1 ? input : shuffled(input, seed)) tally.add('coin_receipt_ledger', 'discrepant', reason, subject);
      const result = tally.result();
      assert.deepEqual(result.coin_receipt_ledger.samples, expected.slice(0, limit), `limit ${limit} seed ${seed}`);
      outputs.add(JSON.stringify(result));
    }
    assert.equal(outputs.size, 1, `limit ${limit}: output depends on input order`);
  }
});
