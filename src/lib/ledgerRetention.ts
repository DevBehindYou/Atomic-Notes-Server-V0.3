import { validateOrderedHistory } from './ledgerSequence.js';
import type { ClientSession, Db, Sort } from 'mongodb';
import { withTransaction } from '../db/mongo.js';
import { collections } from '../db/collections.js';
import { combineLedgerStatistics, projectArchivedStatistics, type KindCounts, type RecentContribution, LEDGER_WINDOW_MS } from './ledgerStatistics.js';

type Archive = { _id: string; projectedAt: number; byKind: KindCounts };
type Recent = RecentContribution & { _id: string; userId: string };
export const ledgerArchives = (db: Db) => db.collection<Archive>('ledger_history_archives');
export const ledgerRecent = (db: Db) => db.collection<Recent>('ledger_history_recent');

/** Inactive building block: caller must commit/retry the whole transaction. Maximum 100 deletions. */
export async function archiveLedgerBatch(db: Db, userId: string, session: ClientSession, asOf: number): Promise<number> {
  if (!session.inTransaction()) throw new Error('ledger_transaction_required');
  if (!Number.isSafeInteger(asOf)) throw new Error('invalid_statistics_time');
  // Contend with all existing monetary writers before selecting any history rows.
  const wallet = await collections.atomicUsers(db).findOneAndUpdate({ _id: userId },
    { $inc: { historyRevision: 1 } }, { session, returnDocument: 'after' });
  if (!wallet) throw new Error('ledger_wallet_missing');
  const sort: Sort = wallet.historyRetentionVersion === 1 ? { historySequence: -1 } : { createdAt: -1, _id: -1 };
  if (wallet.historyRetentionVersion === 1) {
    const ordered = await collections.energyLedger(db).find({ userId }, { session }).limit(52).toArray();
    validateOrderedHistory(wallet, ordered);
  }
  const previous = await ledgerArchives(db).findOne({ _id: userId }, { session });
  if (previous && asOf < previous.projectedAt) throw new Error('statistics_time_regression');
  const rows = await collections.energyLedger(db).find({ userId }, { session })
    .sort(sort).skip(50).limit(100).toArray();
  const projection = projectArchivedStatistics(userId, rows, asOf);
  const counts = Object.fromEntries(Object.entries(projection.byKind).map(([kind, value]) => [`byKind.${kind}`, value]));
  await ledgerArchives(db).updateOne({ _id: userId }, {
    $set: { projectedAt: asOf }, ...(rows.length ? { $inc: counts } : {}),
  }, { session, upsert: true });
  for (const contribution of projection.recent) {
    await ledgerRecent(db).updateOne({ _id: `${userId}:${contribution.at}` }, {
      $setOnInsert: { userId, at: contribution.at },
      $inc: { transactions: contribution.transactions, coinsGranted: contribution.coinsGranted, energySpent: contribution.energySpent },
    }, { session, upsert: true });
  }
  if (rows.length) {
    const result = await collections.energyLedger(db).deleteMany({ userId, _id: { $in: rows.map(row => row._id) } }, { session });
    if (result.deletedCount !== rows.length) throw new Error('ledger_retention_count_mismatch');
  }
  // Inclusive boundary stays present; expiry is derived, never allowed to affect lifetime totals.
  await ledgerRecent(db).deleteMany({ userId, at: { $lt: asOf - LEDGER_WINDOW_MS } }, { session });
  return rows.length;
}

/** Inactive reader: one snapshot spans retained rows and archived contributions. */
export async function readRetainedLedgerStatistics(db: Db, userId: string, asOf: number) {
  return withTransaction(async session => {
    const retained = await collections.energyLedger(db).find({ userId }, { session }).toArray();
    const archive = await ledgerArchives(db).findOne({ _id: userId }, { session });
    const recent = await ledgerRecent(db).find({ userId, at: { $gte: asOf - LEDGER_WINDOW_MS } }, { session }).toArray();
    return combineLedgerStatistics(retained, { userId, projectedAt: archive?.projectedAt ?? asOf,
      byKind: archive?.byKind ?? {}, recent }, asOf);
  }, { readConcern: { level: 'snapshot' } });
}
