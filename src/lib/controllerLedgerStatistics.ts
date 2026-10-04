import type { Db } from 'mongodb';
import { collections } from '../db/collections.js';
import { withTransaction } from '../db/mongo.js';
import { ledgerArchives, ledgerRecent } from './ledgerRetention.js';
import { LEDGER_WINDOW_MS } from './ledgerStatistics.js';

/** Sequential reads in one snapshot prevent double counting a concurrently moved history row. */
export async function controllerLedgerStatistics(db: Db, asOf?: number) {
  if (asOf !== undefined && !Number.isSafeInteger(asOf)) throw new Error('invalid_statistics_time');
  return withTransaction(async session => {
    const anchor = await ledgerArchives(db).findOne({}, { session, sort: { projectedAt: -1 }, projection: { projectedAt: 1 } });
    // A normal dashboard read samples time after its snapshot is established. Explicit historical reads remain strict.
    const sampledAt = asOf ?? Date.now();
    if (anchor && anchor.projectedAt > sampledAt) throw new Error('statistics_time_regression');
    const live = await collections.energyLedger(db).aggregate<{
      _id: string; count: number; transactions: number; coins: number; energy: number;
    }>([{ $group: { _id: '$kind', count: { $sum: 1 },
      transactions: { $sum: { $cond: [{ $gte: ['$createdAt', new Date(sampledAt - LEDGER_WINDOW_MS)] }, 1, 0] } },
      coins: { $sum: { $cond: [{ $and: [{ $gte: ['$createdAt', new Date(sampledAt - LEDGER_WINDOW_MS)] }, { $gt: ['$coinsDelta', 0] }] }, '$coinsDelta', 0] } },
      energy: { $sum: { $cond: [{ $and: [{ $gte: ['$createdAt', new Date(sampledAt - LEDGER_WINDOW_MS)] }, { $lt: ['$energyDelta', 0] }] }, { $multiply: ['$energyDelta', -1] }, 0] } },
    } }], { session }).toArray();
    const archived = await ledgerArchives(db).aggregate<{ _id: string; count: number }>([
      { $project: { kinds: { $objectToArray: { $ifNull: ['$byKind', {}] } } } },
      { $unwind: '$kinds' }, { $group: { _id: '$kinds.k', count: { $sum: '$kinds.v' } } },
    ], { session }).toArray();
    const recent = await ledgerRecent(db).aggregate<{ transactions: number; coins: number; energy: number }>([
      { $match: { at: { $gte: sampledAt - LEDGER_WINDOW_MS } } },
      { $group: { _id: null, transactions: { $sum: '$transactions' }, coins: { $sum: '$coinsGranted' }, energy: { $sum: '$energySpent' } } },
    ], { session }).toArray();
    const result = { tx_24h: recent[0]?.transactions ?? 0, coins_granted_24h: recent[0]?.coins ?? 0,
      energy_spent_24h: recent[0]?.energy ?? 0, ledger_by_kind: {} as Record<string, number> };
    for (const row of live) {
      result.tx_24h += row.transactions; result.coins_granted_24h += row.coins; result.energy_spent_24h += row.energy;
      result.ledger_by_kind[row._id] = row.count;
    }
    for (const row of archived) result.ledger_by_kind[row._id] = (result.ledger_by_kind[row._id] ?? 0) + row.count;
    return result;
  }, { readConcern: { level: 'snapshot' } });
}
