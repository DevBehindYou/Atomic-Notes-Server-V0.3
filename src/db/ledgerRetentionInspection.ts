import type { Db } from 'mongodb';

export function ledgerInspectionArguments(args: string[]): void {
  if (args.length) throw new Error('usage: db:inspect-ledger-history (inspection only; no apply mode)');
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
    const orphan = await db.collection('energy_ledger').aggregate<{ rows: number }>([
      { $lookup: { from: 'atomic_users', localField: 'userId', foreignField: '_id', as: 'wallet' } },
      { $match: { 'wallet.0': { $exists: false } } }, { $count: 'rows' },
    ], { session }).toArray();
    const archiveAccounts = await db.collection('ledger_history_archives').countDocuments({}, { session });
    const recentContributions = await db.collection('ledger_history_recent').countDocuments({}, { session });
    return { ...(history[0] ?? { accounts: 0, rows: 0, overLimitAccounts: 0, removableRows: 0, largestHistory: 0 }),
      orphanRows: orphan[0]?.rows ?? 0, archiveAccounts, recentContributions };
  }, { readConcern: { level: 'snapshot' } });
  // Catalog readiness is a separate read, not part of the data snapshot. Never create a missing collection.
  const exists = await db.listCollections({ name: 'energy_ledger' }, { nameOnly: true }).hasNext();
  const indexes = exists ? await db.collection('energy_ledger').indexes() : [];
  const orderingIndexReady = indexes.some(index => JSON.stringify(index.key) === JSON.stringify({ userId: 1, createdAt: -1, _id: -1 })
    && !index.partialFilterExpression && !index.sparse && !index.hidden && !index.collation);
  return { mode: 'inspect-only' as const, limit: 50, ...counts, orderingIndexReady,
    blockers: [...(counts.orphanRows ? ['orphan_history_requires_review'] : []),
      ...(!orderingIndexReady ? ['ordering_index_requires_separate_review'] : [])],
    activationReady: false as const };
}
