import type { EnergyLedgerDoc } from '../db/collections.js';

export const LEDGER_WINDOW_MS = 24 * 60 * 60 * 1000;
export type LedgerKind = EnergyLedgerDoc['kind'];
export type KindCounts = Partial<Record<LedgerKind, number>>;
export type RecentContribution = {
  at: number; transactions: number; coinsGranted: number; energySpent: number;
};
export type ArchivedStatistics = { userId: string; projectedAt: number; byKind: KindCounts; recent: RecentContribution[] };

/** Pure projection for future transactional pruning; does not delete or persist anything. */
export function projectArchivedStatistics(userId: string, rows: readonly EnergyLedgerDoc[], asOf: number): ArchivedStatistics {
  if (!Number.isSafeInteger(asOf)) throw new Error('invalid_statistics_time');
  const byKind: KindCounts = {}, recent = new Map<number, RecentContribution>(), ids = new Set<string>();
  for (const row of rows) {
    if (row.userId !== userId) throw new Error('statistics_owner_mismatch');
    if (ids.has(row._id)) throw new Error('duplicate_statistics_entry');
    ids.add(row._id);
    const at = row.createdAt.getTime();
    if (!Number.isSafeInteger(at)) throw new Error('invalid_statistics_time');
    byKind[row.kind] = (byKind[row.kind] ?? 0) + 1;
    // Match the existing Controller's inclusive cutoff, including future-dated legacy entries.
    if (at < asOf - LEDGER_WINDOW_MS) continue;
    const contribution = recent.get(at) ?? { at, transactions: 0, coinsGranted: 0, energySpent: 0 };
    contribution.transactions++;
    contribution.coinsGranted += Math.max(0, row.coinsDelta);
    contribution.energySpent += Math.max(0, -row.energyDelta);
    recent.set(at, contribution);
  }
  return { userId, projectedAt: asOf, byKind, recent: [...recent.values()].sort((a, b) => a.at - b.at) };
}

/** Combines disjoint retained rows and archived contributions at or after projection time. */
export function combineLedgerStatistics(retained: readonly EnergyLedgerDoc[], archived: ArchivedStatistics, asOf: number) {
  if (asOf < archived.projectedAt) throw new Error('statistics_time_regression');
  const live = projectArchivedStatistics(archived.userId, retained, asOf);
  const byKind: KindCounts = { ...archived.byKind };
  for (const [kind, count] of Object.entries(live.byKind)) {
    byKind[kind as LedgerKind] = (byKind[kind as LedgerKind] ?? 0) + count;
  }
  const recent = [...live.recent, ...archived.recent].filter(row => row.at >= asOf - LEDGER_WINDOW_MS);
  return { tx_24h: recent.reduce((sum, row) => sum + row.transactions, 0),
    coins_granted_24h: recent.reduce((sum, row) => sum + row.coinsGranted, 0),
    energy_spent_24h: recent.reduce((sum, row) => sum + row.energySpent, 0), ledger_by_kind: byKind };
}
