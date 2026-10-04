import { controllerLedgerStatistics } from './controllerLedgerStatistics.js';
import type { Db } from 'mongodb';
import { collections } from '../db/collections.js';

/**
 * Direct port of supabase/migrations/011_controller_stats.sql's
 * `controller_stats()` — read from the actual SQL, not reconstructed. Same
 * field names (snake_case, matching the Controller UI's existing
 * expectations) and the same definitions, including the "active_24h is a
 * proxy via the daily energy grant, there is no telemetry" reasoning from
 * that migration's own comment.
 *
 * Postgres computed all of this in one round trip via subqueries; Mongo has
 * no equivalent single-query shape as clean, so this runs the equivalent
 * queries in parallel instead. Fine for an admin dashboard — not a hot path.
 */
export async function computeControllerStats(db: Db) {
  const cutoff24h = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const cutoff7d = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

  const [
    totalUsers,
    active24h,
    new7d,
    totalNotes,
    vaults,
    walletTotals,
    activeNotifications,
    ledgerStats,
  ] = await Promise.all([
    collections.atomicUsers(db).countDocuments({}),
    collections.atomicUsers(db).countDocuments({ lastDailyGrantAt: { $gte: cutoff24h } }),
    collections.atomicUsers(db).countDocuments({ createdAt: { $gte: cutoff7d } }),
    collections.notes(db).countDocuments({ deleted: false }),
    collections.vaults(db).countDocuments({}),
    collections
      .atomicUsers(db)
      .aggregate<{ coins: number; energy: number }>([
        // Unmigrated balances are grandfathered. Migrated balances exclude due lots even for inactive users.
        { $lookup: { from: 'coin_lots', let: { userId: '$_id' }, pipeline: [
          { $match: { $expr: { $and: [{ $eq: ['$userId', '$$userId'] }, { $gt: ['$remaining', 0] },
            { $or: [{ $eq: ['$expiresAt', null] }, { $gt: ['$expiresAt', new Date()] }] }] } } },
          { $group: { _id: null, coins: { $sum: '$remaining' } } },
        ], as: 'spendable' } },
        { $group: { _id: null, coins: { $sum: { $cond: [{ $eq: ['$coinLotsVersion', 1] },
          { $ifNull: [{ $arrayElemAt: ['$spendable.coins', 0] }, 0] }, '$coins'] } }, energy: { $sum: '$energy' } } },
      ])
      .toArray(),
    collections.notifications(db).countDocuments({ status: 'active' }),
    controllerLedgerStatistics(db),
  ]);

  return {
    total_users: totalUsers,
    active_24h: active24h,
    new_7d: new7d,
    total_notes: totalNotes,
    vaults,
    coins_circulating: walletTotals[0]?.coins ?? 0,
    energy_outstanding: walletTotals[0]?.energy ?? 0,
    active_notifications: activeNotifications,
    ...ledgerStats,
  };
}
