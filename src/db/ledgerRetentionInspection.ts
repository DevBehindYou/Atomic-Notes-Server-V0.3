import type { Db } from 'mongodb';
import { inspectLedgerIntegrity } from './ledgerIntegrityInspection.js';

export function ledgerInspectionArguments(args: string[]): void {
  if (args.length) throw new Error('usage: db:inspect-ledger-history (inspection only; no apply mode)');
}

type OrderingIndex = { key: Record<string, unknown>; partialFilterExpression?: unknown; sparse?: boolean;
  hidden?: boolean; collation?: unknown; expireAfterSeconds?: number; unique?: boolean };

/** Readiness only. A sequence index must coexist with multiple unsequenced legacy rows per owner. */
export function ledgerOrderingIndexReady(indexes: readonly OrderingIndex[], mode: 'legacy' | 'sequence'): boolean {
  const key = mode === 'legacy' ? { userId: 1, createdAt: -1, _id: -1 } : { userId: 1, historySequence: -1 };
  return indexes.some(index => JSON.stringify(index.key) === JSON.stringify(key)
    && !index.partialFilterExpression && !index.sparse && !index.hidden && !index.collation
    && index.expireAfterSeconds === undefined && (mode !== 'sequence' || !index.unique));
}

/** Read-only counts. Does not return account IDs, transaction notes, balances or connection details. */
export async function inspectLedgerRetention(db: Db) {
  const { withTransaction } = await import('./mongo.js');
  const counts = await withTransaction(async session => {
    const history = await db.collection('energy_ledger').aggregate<{
      accounts: number; rows: number; overLimitAccounts: number; removableRows: number; largestHistory: number;
    }>([
      { $group: { _id: '$userId', rows: { $sum: 1 } } },
      { $group: { _id: null, accounts: { $sum: 1 }, rows: { $sum: '$rows' },
        overLimitAccounts: { $sum: { $cond: [{ $gt: ['$rows', 50] }, 1, 0] } },
        removableRows: { $sum: { $max: [{ $subtract: ['$rows', 50] }, 0] } }, largestHistory: { $max: '$rows' },
      } }, { $project: { _id: 0 } },
    ], { session }).toArray();
    const integrity = await inspectLedgerIntegrity(db, session);
    const archiveAccounts = await db.collection('ledger_history_archives').countDocuments({}, { session });
    const recentContributions = await db.collection('ledger_history_recent').countDocuments({}, { session });
    return { ...(history[0] ?? { accounts: 0, rows: 0, overLimitAccounts: 0, removableRows: 0, largestHistory: 0 }),
      ...integrity, archiveAccounts, recentContributions };
  }, { readConcern: { level: 'snapshot' } });
  // Catalog readiness is a separate read, not part of the data snapshot. Never create a missing collection.
  const exists = await db.listCollections({ name: 'energy_ledger' }, { nameOnly: true }).hasNext();
  const indexes = exists ? await db.collection('energy_ledger').indexes() : [];
  const orderingIndexReady = ledgerOrderingIndexReady(indexes, 'legacy');
  const sequenceOrderingIndexReady = ledgerOrderingIndexReady(indexes, 'sequence');
  return { mode: 'inspect-only' as const, limit: 50, ...counts, orderingIndexReady, sequenceOrderingIndexReady,
    blockers: [...(counts.orphanRows ? ['orphan_history_requires_review'] : []),
      ...(counts.malformedRows ? ['malformed_history_requires_review'] : []),
      ...(counts.invalidWalletIdentities || counts.partialWalletAccounts ? ['wallet_metadata_requires_review'] : []),
      ...(counts.invalidOrderedAccounts || counts.overLimitOrderedAccounts ? ['ordered_history_requires_review'] : []),
      ...(counts.sequencedUnmarkedRows ? ['unmarked_sequence_rows_require_review'] : []),
      ...(!orderingIndexReady ? ['ordering_index_requires_separate_review'] : []),
      ...(!sequenceOrderingIndexReady ? ['sequence_ordering_index_requires_separate_review'] : [])],
    activationReady: false as const };
}
