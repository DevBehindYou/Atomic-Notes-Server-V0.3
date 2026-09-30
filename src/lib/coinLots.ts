import { createHash, randomUUID } from 'node:crypto';
import type { ClientSession, Db } from 'mongodb';
import { collections, type AtomicUserDoc, type CoinAllocation, type CoinLotDoc } from '../db/collections.js';
import { withTransaction } from '../db/mongo.js';
import { coinExpiry, coinPolicyActivation } from './coinPolicy.js';
import { httpError } from './httpError.js';

export function usesCoinLots(wallet: AtomicUserDoc, now = new Date()): boolean {
  // Once migrated, never fall back to scalar-only writes, even if the activation setting is removed.
  return wallet.coinLotsVersion === 1 || coinPolicyActivation(now) !== null;
}

/** Caller owns the transaction. Initialization and expiry contend on the wallet before creating records. */
export async function prepareCoinWallet(
  db: Db, wallet: AtomicUserDoc, session: ClientSession, now = new Date(), welcome = false,
): Promise<AtomicUserDoc> {
  if (!usesCoinLots(wallet, now)) return wallet;
  const userId = wallet._id;
  if (wallet.coinLotsVersion !== 1) {
    const activatedAt = coinPolicyActivation(now)!;
    await collections.atomicUsers(db).updateOne({ _id: userId }, {
      $set: { coinLotsVersion: 1, coinPolicyActivatedAt: activatedAt },
    }, { session });
    if (wallet.coins > 0) {
      await collections.coinLots(db).insertOne({
        _id: `${userId}:opening`, userId, source: welcome ? 'welcome' : 'legacy',
        creditedAt: now, expiresAt: welcome ? coinExpiry(now) : null,
        amount: wallet.coins, remaining: wallet.coins, operationId: `${userId}:opening`,
      }, { session });
    }
    wallet = { ...wallet, coinLotsVersion: 1, coinPolicyActivatedAt: activatedAt };
  }
  const due = await collections.coinLots(db).find({
    userId, remaining: { $gt: 0 }, expiresAt: { $ne: null, $lte: now },
  }, { session }).sort({ expiresAt: 1, _id: 1 }).toArray();
  if (!due.length) return wallet;
  const expired = due.reduce((n, lot) => n + lot.remaining, 0);
  if (expired > wallet.coins) throw new Error('coin_balance_invariant');
  await collections.atomicUsers(db).updateOne({ _id: userId }, { $inc: { coins: -expired } }, { session });
  for (const lot of due) {
    wallet = { ...wallet, coins: wallet.coins - lot.remaining };
    await collections.coinLots(db).updateOne({ _id: lot._id }, { $set: { remaining: 0 } }, { session });
    await collections.energyLedger(db).insertOne({
      _id: randomUUID(), userId, kind: 'admin_adjust', reason: 'coin_expired', lotIds: [lot._id],
      coinsDelta: -lot.remaining, energyDelta: 0, resultingCoins: wallet.coins,
      resultingEnergy: wallet.energy, note: `${lot.remaining} Atomic Coins expired`, createdAt: now,
    }, { session });
  }
  return wallet;
}

/** Allocate earliest expiry first, then credit time/ID, with grandfathered coins last. */
export async function spendCoinLots(db: Db, wallet: AtomicUserDoc, amount: number, session: ClientSession): Promise<CoinAllocation[]> {
  if (wallet.coinLotsVersion !== 1 || amount === 0) return [];
  if (!Number.isSafeInteger(amount) || amount < 0 || amount > wallet.coins) throw httpError('insufficient_coins', 409);
  const lots = await collections.coinLots(db).find({ userId: wallet._id, remaining: { $gt: 0 } }, { session }).toArray();
  lots.sort((a, b) => (a.expiresAt?.getTime() ?? Infinity) - (b.expiresAt?.getTime() ?? Infinity)
    || a.creditedAt.getTime() - b.creditedAt.getTime() || a._id.localeCompare(b._id));
  const allocations: CoinAllocation[] = [];
  let remaining = amount;
  for (const lot of lots) {
    if (!remaining) break;
    const used = Math.min(remaining, lot.remaining);
    await collections.coinLots(db).updateOne({ _id: lot._id }, { $inc: { remaining: -used } }, { session });
    allocations.push({ lotId: lot._id, amount: used }); remaining -= used;
  }
  if (remaining) throw new Error('coin_balance_invariant');
  return allocations;
}

export async function creditCoinLot(db: Db, wallet: AtomicUserDoc, amount: number, operationId: string, session: ClientSession, now: Date) {
  if (wallet.coinLotsVersion !== 1 || amount === 0) return;
  await collections.coinLots(db).insertOne({
    _id: operationId, userId: wallet._id, source: 'controller', creditedAt: now,
    expiresAt: coinExpiry(now), amount, remaining: amount, operationId,
  }, { session });
}

export function coinFingerprint(kind: string, values: unknown[]): string {
  return createHash('sha256').update(JSON.stringify([kind, ...values])).digest('hex');
}

export function coinOperationId(userId: string, requestId: string): string { return `${userId}:${requestId}`; }

export async function replayCoinOperation(db: Db, userId: string, requestId: string | undefined, fingerprint: string, session: ClientSession) {
  if (!requestId) return null;
  const op = await collections.coinOperations(db).findOne({ _id: coinOperationId(userId, requestId) }, { session });
  if (op && op.fingerprint !== fingerprint) throw httpError('coin_request_mismatch', 409);
  return op?.result ?? null;
}

export function requireCoinRequestId(wallet: AtomicUserDoc, requestId?: string): void {
  if (wallet.coinLotsVersion === 1 && !requestId) throw httpError('coin_request_id_required', 409);
}

export async function recordCoinOperation(db: Db, wallet: AtomicUserDoc, requestId: string | undefined,
  fingerprint: string, allocations: CoinAllocation[], session: ClientSession, now = new Date()) {
  if (!requestId) return;
  await collections.coinOperations(db).insertOne({
    _id: coinOperationId(wallet._id, requestId), userId: wallet._id, requestId, fingerprint,
    allocations, result: wallet, createdAt: now,
  }, { session });
}

/** Read-time settlement also works when no background job has run. Does not create a missing wallet. */
export async function readCoinWallet(db: Db, userId: string): Promise<AtomicUserDoc | null> {
  const wallet = await collections.atomicUsers(db).findOne({ _id: userId });
  if (!wallet || !usesCoinLots(wallet)) return wallet;
  return withTransaction(async (session) => {
    const current = await collections.atomicUsers(db).findOne({ _id: userId }, { session });
    return current ? prepareCoinWallet(db, current, session) : null;
  });
}

export function lotToWire(lot: CoinLotDoc, now: Date) {
  return { id: lot._id, source: lot.source, credited_at: lot.creditedAt.toISOString(),
    expires_at: lot.expiresAt?.toISOString() ?? null, amount: lot.amount,
    remaining: lot.expiresAt && lot.expiresAt <= now ? 0 : lot.remaining };
}

/** Paginated stable credit order, computed at one server instant. No client clock or TTL dependency. */
export async function coinDetails(db: Db, userId: string, before?: { at: Date; id: string }) {
  return withTransaction(async (session) => {
    const now = new Date();
    const current = await collections.atomicUsers(db).findOne({ _id: userId }, { session });
    if (!current) return null;
    const wallet = await prepareCoinWallet(db, current, session, now);
    if (wallet.coinLotsVersion !== 1) return { enabled: false, server_time: now.toISOString(), rows: [], next_cursor: null };
    const rows = await collections.coinLots(db).find({ userId, ...(before ? { $or: [
      { creditedAt: { $lt: before.at } }, { creditedAt: before.at, _id: { $lt: before.id } },
    ] } : {}) }, { session }).sort({ creditedAt: -1, _id: -1 }).limit(51).toArray();
    const active = await collections.coinLots(db).find({ userId, remaining: { $gt: 0 } }, { session }).toArray();
    const nonExpiring = active.filter((l) => !l.expiresAt).reduce((n, l) => n + l.remaining, 0);
    const next = active.filter((l) => l.expiresAt).sort((a, b) => a.expiresAt!.getTime() - b.expiresAt!.getTime())[0]?.expiresAt;
    const last = rows[49];
    return { enabled: true, server_time: now.toISOString(), coins: wallet.coins,
      non_expiring_coins: nonExpiring, next_expiry_at: next?.toISOString() ?? null,
      next_expiry_coins: next ? active.filter((l) => l.expiresAt?.getTime() === next.getTime()).reduce((n, l) => n + l.remaining, 0) : 0,
      rows: rows.slice(0, 50).map((l) => lotToWire(l, now)),
      next_cursor: rows.length > 50 ? Buffer.from(JSON.stringify({ at: last.creditedAt.toISOString(), id: last._id })).toString('base64url') : null };
  });
}
