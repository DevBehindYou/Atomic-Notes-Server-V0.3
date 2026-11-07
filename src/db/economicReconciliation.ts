import { createHash } from 'node:crypto';
import { ENERGY } from '../lib/energyPolicy.js';
import { ledgerProvenanceIssues } from './ledgerProvenanceInspection.js';

// C27: read-only economic reconciliation. Pure invariant logic over one owner's
// stored records. It never infers a link that is not stored: a record that can
// only be matched by guessing is counted as `unknown`, with a reason code.
// See docs/ECONOMIC_RECONCILIATION.md for the invariant table and citations.

/** Exact note of the only sync-refund writer (src/lib/syncOperation.ts:194). Compared on the server; never returned. */
export const SYNC_REFUND_NOTE = 'Refund: sync failed before any note succeeded';
/** Commit order may differ from `createdAt` by at most one transaction retry window (unmarked wallets only). */
export const REORDER_WINDOW_MS = 120_000;
const SEARCH_BUDGET = 20_000;
const MAX_CHAIN_ROWS = 5_000;

export type WalletRecord = {
  _id: unknown; coins?: unknown; energy?: unknown; coinLotsVersion?: unknown;
  coinPolicyActivatedAt?: unknown; historyRetentionVersion?: unknown;
};
/** `note` is projected to '' (string) or kept (non-string) so text never leaves the server. */
export type LedgerRecord = {
  _id: unknown; userId: unknown; kind?: unknown; coinsDelta?: unknown; energyDelta?: unknown;
  resultingCoins?: unknown; resultingEnergy?: unknown; note?: unknown; createdAt?: unknown;
  historySequence?: unknown; coinOperationId?: unknown; lotIds?: unknown; reason?: unknown; syncRefund?: boolean;
};
export type OperationRecord = {
  _id: unknown; mode?: unknown; rowIds?: unknown; charged?: unknown; refunded?: unknown; status?: unknown;
  results?: unknown; createdAt?: unknown; logoutTagged?: boolean;
};
export type LotRecord = { _id: unknown; amount?: unknown; remaining?: unknown; expiresAt?: unknown };
export type ReceiptRecord = { _id: unknown; allocations?: unknown; createdAt?: unknown };
export type OwnerBundle = {
  wallet: WalletRecord | null; ledger: LedgerRecord[]; operations: OperationRecord[];
  lots: LotRecord[]; receipts: ReceiptRecord[];
  /** Stored archive counts are positive: some ledger rows were removed by retention. */
  archived: boolean;
};
export type ReconcileContext = { asOf: Date; ledgerMayExpire: boolean; reorderWindowMs?: number };

export type Outcome = 'conforming' | 'discrepant' | 'unknown';
export const INVARIANTS = {
  wallet_ledger_chain: 'wallet',
  wallet_lot_balance: 'coin_lot_wallet',
  coin_row_provenance: 'coin_ledger_row',
  sync_charge_policy: 'sync_operation',
  sync_refund_bounds: 'sync_operation',
  sync_settlement_results: 'sync_operation',
  sync_charge_ledger: 'owner',
  sync_refund_ledger: 'owner',
  lot_bounds: 'coin_lot',
  lot_consumption: 'coin_lot',
  lot_expiry: 'expiring_coin_lot',
  coin_receipt_ledger: 'coin_receipt',
} as const;
export type InvariantId = keyof typeof INVARIANTS;

export type InvariantTally = {
  unit: string; conforming: number; discrepant: number; unknown: number;
  reasons: Record<string, number>;
  /** Sync ledger rows older than the owner's oldest retained operation: not matchable without guessing. */
  rowsOutsideWindow?: number;
  /** Truncated one-way hashes of discrepant record ids, for an operator to locate them locally. */
  samples: { reason: string; ref: string }[];
};

const int = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value);
const date = (value: unknown): value is Date => value instanceof Date && Number.isFinite(value.getTime());
const text = (value: unknown): value is string => typeof value === 'string' && value.length > 0;
/** Non-reversible short reference. 12 hex characters stay below the sanitizer's identifier patterns. */
export const refHash = (id: unknown) => createHash('sha256').update(`c27-ref:${String(id)}`).digest('hex').slice(0, 12);

export class Tally {
  readonly invariants: Record<InvariantId, InvariantTally>;
  constructor(private readonly sampleLimit = 10) {
    this.invariants = Object.fromEntries(Object.entries(INVARIANTS).map(([id, unit]) =>
      [id, { unit, conforming: 0, discrepant: 0, unknown: 0, reasons: {}, samples: [] }])) as unknown as Record<InvariantId, InvariantTally>;
    this.invariants.sync_charge_ledger.rowsOutsideWindow = 0;
    this.invariants.sync_refund_ledger.rowsOutsideWindow = 0;
  }
  add(id: InvariantId, outcome: Outcome, reason: string | null, subject: unknown) {
    const entry = this.invariants[id];
    entry[outcome]++;
    if (reason) entry.reasons[reason] = (entry.reasons[reason] ?? 0) + 1;
    if (outcome === 'discrepant' && reason) entry.samples.push({ reason, ref: refHash(subject) });
  }
  /** Deterministic: reasons and samples sorted, samples capped. */
  result(): Record<InvariantId, InvariantTally> {
    const out = {} as Record<InvariantId, InvariantTally>;
    for (const id of Object.keys(INVARIANTS) as InvariantId[]) {
      const entry = this.invariants[id];
      out[id] = { ...entry, reasons: Object.fromEntries(Object.entries(entry.reasons).sort(([a], [b]) => a.localeCompare(b))),
        samples: [...entry.samples].sort((a, b) => a.reason.localeCompare(b.reason) || a.ref.localeCompare(b.ref))
          .slice(0, this.sampleLimit) };
    }
    return out;
  }
}

// ---------------------------------------------------------------------------
// Wallet balance continuity
// ---------------------------------------------------------------------------
type Step = { id: unknown; coins: number; energy: number; resultCoins: number; resultEnergy: number; at: number; seq: number | null };
type ChainResult = { outcome: Outcome; reason: string | null };

function steps(rows: readonly LedgerRecord[]): Step[] | null {
  const result: Step[] = [];
  for (const row of rows) {
    if (!int(row.coinsDelta) || !int(row.energyDelta) || !int(row.resultingCoins) || !int(row.resultingEnergy) || !date(row.createdAt)) return null;
    result.push({ id: row._id, coins: row.coinsDelta, energy: row.energyDelta, resultCoins: row.resultingCoins,
      resultEnergy: row.resultingEnergy, at: row.createdAt.getTime(), seq: int(row.historySequence) ? row.historySequence : null });
  }
  return result;
}
const follows = (previous: Step, next: Step) =>
  previous.resultCoins + next.coins === next.resultCoins && previous.resultEnergy + next.energy === next.resultEnergy;

/**
 * Every writer stores the post-mutation balance in the same transaction as the
 * mutation, so consecutive rows chain and the last row equals the wallet.
 * Marked wallets are ordered by historySequence. Unmarked wallets are ordered by
 * createdAt, which can differ from commit order by one retry window; a break is
 * discrepant only when no ordering within that window chains.
 */
export function walletChain(wallet: WalletRecord, rows: readonly LedgerRecord[], windowMs = REORDER_WINDOW_MS): ChainResult {
  if (!int(wallet.coins) || !int(wallet.energy)) return { outcome: 'unknown', reason: 'malformed_wallet' };
  if (!rows.length) return { outcome: 'unknown', reason: 'no_retained_rows' };
  if (rows.length > MAX_CHAIN_ROWS) return { outcome: 'unknown', reason: 'history_too_large' };
  const parsed = steps(rows);
  if (!parsed) return { outcome: 'unknown', reason: 'malformed_rows' };
  const tail = (last: Step) => last.resultCoins === wallet.coins && last.resultEnergy === wallet.energy;
  if (wallet.historyRetentionVersion === 1) {
    if (parsed.some(step => step.seq === null) || new Set(parsed.map(step => step.seq)).size !== parsed.length) {
      return { outcome: 'unknown', reason: 'malformed_rows' };
    }
    const ordered = [...parsed].sort((a, b) => a.seq! - b.seq!);
    for (let i = 1; i < ordered.length; i++) if (!follows(ordered[i - 1], ordered[i])) return { outcome: 'discrepant', reason: 'chain_break' };
    return tail(ordered[ordered.length - 1]) ? { outcome: 'conforming', reason: null } : { outcome: 'discrepant', reason: 'tail_mismatch' };
  }
  const ordered = [...parsed].sort((a, b) => a.at - b.at || String(a.id).localeCompare(String(b.id)));
  const used = new Array<boolean>(ordered.length).fill(false);
  let budget = SEARCH_BUDGET, completed = false, exhausted = false;
  const signature = (step: Step) => `${step.coins}|${step.energy}|${step.resultCoins}|${step.resultEnergy}`;
  // Depth-first search over orderings that respect the window. Equivalent candidates are tried once per step.
  const search = (previous: Step | null, depth: number): boolean => {
    if (depth === ordered.length) { completed = true; return tail(previous!); }
    if (--budget < 0) { exhausted = true; return false; }
    let first = 0;
    while (used[first]) first++;
    const limit = ordered[first].at + windowMs;
    const tried = new Set<string>();
    for (let i = first; i < ordered.length && ordered[i].at <= limit; i++) {
      if (used[i] || (previous && !follows(previous, ordered[i]))) continue;
      const key = signature(ordered[i]);
      if (tried.has(key)) continue;
      tried.add(key);
      used[i] = true;
      const found = search(ordered[i], depth + 1);
      used[i] = false;
      if (found) return true;
      if (exhausted) return false;
    }
    return false;
  };
  if (search(null, 0)) return { outcome: 'conforming', reason: null };
  if (exhausted) return { outcome: 'unknown', reason: 'ambiguous_order' };
  return completed ? { outcome: 'discrepant', reason: 'tail_mismatch' } : { outcome: 'discrepant', reason: 'chain_break' };
}

// ---------------------------------------------------------------------------
// Per-owner reconciliation
// ---------------------------------------------------------------------------
const lotIdsOf = (row: LedgerRecord): string[] => Array.isArray(row.lotIds) ? [...new Set(row.lotIds.filter(text))] : [];
const hasReference = (row: LedgerRecord) => text(row.coinOperationId) || lotIdsOf(row).length > 0;
const isExpiryRow = (row: LedgerRecord) => row.reason === 'coin_expired';
type Allocation = { lotId: string; amount: number };
const allocationsOf = (receipt: ReceiptRecord): Allocation[] | null => {
  if (!Array.isArray(receipt.allocations)) return null;
  const result: Allocation[] = [];
  for (const item of receipt.allocations) {
    const record = item && typeof item === 'object' ? item as Record<string, unknown> : {};
    if (!text(record.lotId) || !int(record.amount) || record.amount <= 0) return null;
    result.push({ lotId: record.lotId, amount: record.amount });
  }
  return result;
};
const validLot = (lot: LotRecord) => int(lot.amount) && lot.amount >= 0 && int(lot.remaining) && lot.remaining >= 0 && lot.remaining <= lot.amount;
const syncCost = (mode: unknown) => mode === 'instant' ? ENERGY.syncInstantCost : mode === 'standard' ? ENERGY.syncStandardCost : null;

export function reconcileOwner(bundle: OwnerBundle, context: ReconcileContext, tally: Tally): void {
  const { wallet, ledger, operations, lots, receipts } = bundle;
  const trimmed = bundle.archived || context.ledgerMayExpire;
  const receiptIds = new Set(receipts.map(receipt => String(receipt._id)));
  const lotIds = new Set(lots.map(lot => String(lot._id)));

  if (wallet) {
    const chain = walletChain(wallet, ledger, context.reorderWindowMs);
    tally.add('wallet_ledger_chain', chain.outcome, chain.reason, wallet._id);
    if (wallet.coinLotsVersion === 1) {
      const invalid = lots.some(lot => typeof lot.remaining !== 'number' || !Number.isFinite(lot.remaining) || lot.remaining < 0);
      const sum = lots.reduce((n, lot) => n + (typeof lot.remaining === 'number' ? lot.remaining : 0), 0);
      if (invalid || !int(wallet.coins)) tally.add('wallet_lot_balance', 'unknown', 'invalid_lot', wallet._id);
      else tally.add('wallet_lot_balance', sum === wallet.coins ? 'conforming' : 'discrepant', sum === wallet.coins ? null : 'scalar_lot_mismatch', wallet._id);
    } else if (lots.length) {
      tally.add('wallet_lot_balance', 'discrepant', 'lots_without_migration', wallet._id);
    }
  }

  // Coin-moving rows: only stored references count, and only to this owner's records.
  const activatedAt = wallet?.coinLotsVersion === 1 && date(wallet.coinPolicyActivatedAt) ? wallet.coinPolicyActivatedAt.getTime() : null;
  let unlinkedDebits = false;
  for (const row of ledger) {
    if (!int(row.coinsDelta) || row.coinsDelta === 0) continue;
    const ids = lotIdsOf(row);
    const operationOwned = text(row.coinOperationId) && receiptIds.has(row.coinOperationId) ? 1 : 0;
    const lotsOwned = ids.filter(id => lotIds.has(id)).length;
    const issues = ledgerProvenanceIssues(row, { total: operationOwned, owned: operationOwned }, { total: lotsOwned, owned: lotsOwned });
    if (issues.includes('invalid_provenance_row')) tally.add('coin_row_provenance', 'discrepant', 'malformed_row', row._id);
    else if (issues.includes('missing_referenced_operation') || issues.includes('missing_referenced_lot')) {
      tally.add('coin_row_provenance', 'discrepant', 'reference_not_owned', row._id);
    } else if (issues.includes('no_explicit_references')) {
      if (row.coinsDelta < 0) unlinkedDebits = true;
      const current = activatedAt !== null && date(row.createdAt) && row.createdAt.getTime() >= activatedAt;
      tally.add('coin_row_provenance', 'unknown', current ? 'unlinked_current' : 'unlinked_legacy', row._id);
    } else tally.add('coin_row_provenance', 'conforming', null, row._id);
  }

  for (const op of operations) {
    const cost = syncCost(op.mode);
    const rowCount = Array.isArray(op.rowIds) ? op.rowIds.length : null;
    if (cost === null || rowCount === null || !int(op.charged)) tally.add('sync_charge_policy', 'discrepant', 'malformed_operation', op._id);
    else if (rowCount === 0) tally.add('sync_charge_policy', op.charged === 0 ? 'conforming' : 'discrepant', op.charged === 0 ? null : 'charged_without_rows', op._id);
    else {
      // Paid sync always debits the mode cost; an unpaid emergency logout batch is instant and charges 0.
      const allowed = op.charged === cost || (op.logoutTagged === true && op.mode === 'instant' && op.charged === 0);
      tally.add('sync_charge_policy', allowed ? 'conforming' : 'discrepant', allowed ? null : 'charge_not_current_policy', op._id);
    }

    const results = Array.isArray(op.results) ? op.results as unknown[] : null;
    const delivered = results?.some(r => !!r && typeof r === 'object' && (r as Record<string, unknown>).ok === true) ?? false;
    if (!int(op.refunded) || op.refunded < 0 || !int(op.charged)) tally.add('sync_refund_bounds', 'discrepant', 'malformed_operation', op._id);
    else if (op.refunded > op.charged) tally.add('sync_refund_bounds', 'discrepant', 'refund_exceeds_charge', op._id);
    else if (op.status === 'pending' && op.refunded !== 0) tally.add('sync_refund_bounds', 'discrepant', 'pending_with_refund', op._id);
    else if (op.refunded > 0 && delivered) tally.add('sync_refund_bounds', 'discrepant', 'refund_with_delivered_row', op._id);
    else tally.add('sync_refund_bounds', 'conforming', null, op._id);

    if (op.status === 'pending') tally.add('sync_settlement_results', 'unknown', 'pending_operation', op._id);
    else if (op.status !== 'complete') tally.add('sync_settlement_results', 'discrepant', 'unknown_status', op._id);
    else {
      const rowIds = Array.isArray(op.rowIds) ? op.rowIds.map(String) : [];
      const ids = (results ?? []).map(r => r && typeof r === 'object' ? (r as Record<string, unknown>).id : undefined);
      const wellFormed = results !== null && (results as unknown[]).every(r => !!r && typeof r === 'object'
        && typeof (r as Record<string, unknown>).id === 'string' && typeof (r as Record<string, unknown>).ok === 'boolean');
      const exact = wellFormed && ids.length === rowIds.length && new Set(ids).size === ids.length && ids.every(id => rowIds.includes(String(id)));
      tally.add('sync_settlement_results', exact ? 'conforming' : 'discrepant', exact ? null : 'results_mismatch', op._id);
    }
  }

  // Sync charge/refund rows carry no operation reference (syncOperation.ts:104,192). Reconcile per owner only,
  // inside the window that retained operations cover; older rows are counted but never matched.
  const opTimes = operations.map(op => op.createdAt).filter(date).map(d => d.getTime());
  const windowStart = opTimes.length ? Math.min(...opTimes) : null;
  const ownerSubject = wallet?._id ?? ledger[0]?.userId ?? operations[0]?._id;
  const aggregate = (id: 'sync_charge_ledger' | 'sync_refund_ledger', rows: LedgerRecord[], amounts: number[],
    names: { sign: 1 | -1; extra: string; missing: string }) => {
    if (!rows.length && !amounts.length) return;
    if (rows.some(row => !int(row.energyDelta) || !date(row.createdAt))) return tally.add(id, 'unknown', 'malformed_rows', ownerSubject);
    const inside = rows.filter(row => windowStart !== null && (row.createdAt as Date).getTime() >= windowStart);
    tally.invariants[id].rowsOutsideWindow! += rows.length - inside.length;
    if (!inside.length && !amounts.length) return tally.add(id, 'unknown', 'unlinked_legacy', ownerSubject);
    const rowSum = inside.reduce((n, row) => n + names.sign * (row.energyDelta as number), 0);
    const opSum = amounts.reduce((n, value) => n + value, 0);
    if (inside.length === amounts.length && rowSum === opSum) return tally.add(id, 'conforming', null, ownerSubject);
    if (inside.length === amounts.length) return tally.add(id, 'discrepant', 'amount_mismatch', ownerSubject);
    if (inside.length > amounts.length) return tally.add(id, 'discrepant', names.extra, ownerSubject);
    return tally.add(id, trimmed ? 'unknown' : 'discrepant', trimmed ? 'ledger_history_trimmed' : names.missing, ownerSubject);
  };
  const charges = operations.filter(op => int(op.charged) && op.charged > 0).map(op => op.charged as number);
  const refunds = operations.filter(op => int(op.refunded) && op.refunded > 0).map(op => op.refunded as number);
  aggregate('sync_charge_ledger', ledger.filter(row => row.kind === 'spend'), charges,
    { sign: -1, extra: 'unmatched_charge_rows', missing: 'missing_charge_rows' });
  aggregate('sync_refund_ledger', ledger.filter(row => row.kind === 'admin_adjust' && row.syncRefund === true && row.coinsDelta === 0),
    refunds, { sign: 1, extra: 'orphan_refund_rows', missing: 'missing_refund_rows' });

  const parsedReceipts = receipts.map(receipt => ({ receipt, allocations: allocationsOf(receipt) }));
  const expiryRows = ledger.filter(isExpiryRow);
  for (const lot of lots) {
    const id = String(lot._id);
    if (!validLot(lot)) {
      const reason = !int(lot.amount) || lot.amount < 0 || !int(lot.remaining) ? 'malformed_lot'
        : lot.remaining < 0 ? 'negative_remaining' : 'remaining_exceeds_amount';
      tally.add('lot_bounds', 'discrepant', reason, lot._id);
      tally.add('lot_consumption', 'unknown', 'invalid_lot', lot._id);
      if (lot.expiresAt !== null && lot.expiresAt !== undefined) tally.add('lot_expiry', 'unknown', 'invalid_lot', lot._id);
      continue;
    }
    tally.add('lot_bounds', 'conforming', null, lot._id);
    const amount = lot.amount as number, remaining = lot.remaining as number;
    const spends = parsedReceipts.flatMap(({ receipt, allocations }) => (allocations ?? [])
      .filter(a => a.lotId === id).map(a => ({ amount: a.amount, at: date(receipt.createdAt) ? receipt.createdAt.getTime() : null })));
    const expiries = expiryRows.filter(row => lotIdsOf(row).includes(id));
    const explained = spends.reduce((n, s) => n + s.amount, 0)
      + expiries.reduce((n, row) => n + (int(row.coinsDelta) ? -row.coinsDelta : 0), 0);
    const consumed = amount - remaining;
    if (explained === consumed) tally.add('lot_consumption', 'conforming', null, lot._id);
    else if (explained > consumed) tally.add('lot_consumption', 'discrepant', 'over_explained', lot._id);
    else if (unlinkedDebits || trimmed) tally.add('lot_consumption', 'unknown', 'unlinked_consumption', lot._id);
    else tally.add('lot_consumption', 'discrepant', 'unexplained_consumption', lot._id);

    if (!date(lot.expiresAt)) {
      if (expiries.length) tally.add('lot_expiry', 'discrepant', 'expired_non_expiring_lot', lot._id);
      continue;
    }
    const due = lot.expiresAt.getTime();
    if (spends.some(s => s.at !== null && s.at > due)) tally.add('lot_expiry', 'discrepant', 'consumed_after_expiry', lot._id);
    else if (expiries.some(row => !date(row.createdAt) || row.createdAt.getTime() < due)) tally.add('lot_expiry', 'discrepant', 'expired_before_due', lot._id);
    else if (expiries.length > 1) tally.add('lot_expiry', 'discrepant', 'repeated_expiry', lot._id);
    else if (expiries.length === 1 && remaining !== 0) tally.add('lot_expiry', 'discrepant', 'remaining_after_expiry', lot._id);
    // Expiry is settled lazily on the next wallet read (coinLots.ts:34); a due, unsettled lot is not an error.
    else if (due <= context.asOf.getTime() && remaining > 0) tally.add('lot_expiry', 'conforming', 'due_unsettled', lot._id);
    else tally.add('lot_expiry', 'conforming', null, lot._id);
  }

  for (const { receipt, allocations } of parsedReceipts) {
    const linked = ledger.filter(row => row.coinOperationId === receipt._id);
    if (allocations === null) { tally.add('coin_receipt_ledger', 'discrepant', 'malformed_receipt', receipt._id); continue; }
    if (linked.length > 1) { tally.add('coin_receipt_ledger', 'discrepant', 'duplicate_ledger_rows', receipt._id); continue; }
    if (!allocations.length) { tally.add('coin_receipt_ledger', 'conforming', null, receipt._id); continue; }
    if (!linked.length) {
      tally.add('coin_receipt_ledger', trimmed ? 'unknown' : 'discrepant', trimmed ? 'ledger_history_trimmed' : 'missing_ledger_row', receipt._id);
      continue;
    }
    const row = linked[0];
    const spent = allocations.reduce((n, a) => n + a.amount, 0);
    const allocated = [...new Set(allocations.map(a => a.lotId))].sort();
    const referenced = lotIdsOf(row).sort();
    if (!int(row.coinsDelta) || -row.coinsDelta !== spent) tally.add('coin_receipt_ledger', 'discrepant', 'allocation_amount_mismatch', receipt._id);
    else if (allocated.join('\n') !== referenced.join('\n')) tally.add('coin_receipt_ledger', 'discrepant', 'allocation_lot_mismatch', receipt._id);
    else tally.add('coin_receipt_ledger', 'conforming', null, receipt._id);
  }
}

export function summarizeInvariants(invariants: Record<InvariantId, InvariantTally>) {
  const values = Object.values(invariants);
  const counts = Object.fromEntries(Object.entries(invariants).map(([id, t]) =>
    [id, [t.conforming, t.discrepant, t.unknown, t.reasons, t.rowsOutsideWindow ?? null]]));
  return {
    conforming: values.reduce((n, t) => n + t.conforming, 0),
    discrepant: values.reduce((n, t) => n + t.discrepant, 0),
    unknown: values.reduce((n, t) => n + t.unknown, 0),
    discrepantInvariants: (Object.keys(invariants) as InvariantId[]).filter(id => invariants[id].discrepant > 0),
    /** Counts-only digest: equal for any two datasets with the same per-invariant outcomes. */
    countsDigest: createHash('sha256').update(JSON.stringify(counts)).digest('hex').slice(0, 16),
  };
}
