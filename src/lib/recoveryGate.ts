import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Db, ClientSession } from 'mongodb';
import { withTransaction } from '../db/mongo.js';
import { recoveryGateSchema, nextRecoveryRevision, type RecoveryGate } from '../db/recoveryContract.js';

/** Inactive: used only by generated-database acceptance fixtures. */
type Lock = { _id: string; owner: string; expiresAt: Date };
const leaseSchema = z.object({ userId: z.string().uuid(), token: z.string().uuid(),
  wipeEpoch: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER), expiresAt: z.date() }).strict();
export type RecoveryLease = z.infer<typeof leaseSchema>;
export type RecoveryClock = () => Date;
const defaultClock = () => new Date();
const at = (clock: RecoveryClock) => new Date(z.date().parse(clock()).getTime());
const lost = () => new Error('recovery_fence_lost');
const gates = (db: Db) => db.collection<RecoveryGate>('note_sync_state');
const locks = (db: Db) => db.collection<Lock>('operation_locks');

/** Lease and persistent gate publish together; no production caller uses it. */
export async function acquireRecoveryLease(db: Db, userId: string, clock: RecoveryClock = defaultClock): Promise<RecoveryLease> {
  z.string().uuid().parse(userId);
  const token = randomUUID(), now = at(clock), expiresAt = z.date().parse(new Date(now.getTime() + 600000));
  try {
    return await withTransaction(async (session) => {
      const raw = await gates(db).findOne({ _id: userId }, { session });
      const previous = raw ? recoveryGateSchema.parse(raw) : null;
      if (previous?.leaseToken && previous.leaseExpiresAt! > now) throw new Error('operation_in_progress');
      const lock = await locks(db).updateOne({ _id: `notes:${userId}`, expiresAt: { $lte: now } },
        { $set: { owner: token, expiresAt } }, { upsert: true, session });
      if (!lock.matchedCount && !lock.upsertedCount) throw lost();
      const next = recoveryGateSchema.parse({ _id: userId, format: 1, wipeEpoch: previous?.wipeEpoch ?? 0,
        gateRevision: nextRecoveryRevision(previous?.gateRevision ?? 0), leaseToken: token, leaseExpiresAt: expiresAt, updatedAt: now });
      if (previous) {
        const replaced = await gates(db).replaceOne({ _id: userId, gateRevision: previous.gateRevision }, next, { session });
        if (replaced.matchedCount !== 1) throw lost();
      } else await gates(db).insertOne(next, { session });
      return leaseSchema.parse({ userId, token, wipeEpoch: next.wipeEpoch, expiresAt });
    });
  } catch (error) {
    if ((error as { code?: number })?.code === 11000) throw new Error('operation_in_progress');
    throw error;
  }
}

async function touchFence(db: Db, session: ClientSession, lease: RecoveryLease, now: Date): Promise<RecoveryGate> {
  const raw = await gates(db).findOne({ _id: lease.userId }, { session });
  if (!raw) throw lost();
  const current = recoveryGateSchema.parse(raw);
  const next = nextRecoveryRevision(current.gateRevision);
  const touched = await gates(db).updateOne({ _id: lease.userId, leaseToken: lease.token, wipeEpoch: lease.wipeEpoch,
    leaseExpiresAt: { $gt: now }, gateRevision: current.gateRevision },
  { $inc: { gateRevision: 1 }, $set: { updatedAt: now } }, { session });
  if (touched.matchedCount !== 1) throw lost();
  return { ...current, gateRevision: next, updatedAt: now };
}

/** All callback writes must use this session. Recheck expiry before commit. */
export async function withRecoveryFence<T>(db: Db, input: RecoveryLease,
  write: (session: ClientSession) => Promise<T>, clock: RecoveryClock = defaultClock): Promise<T> {
  const lease = leaseSchema.parse(input);
  return withTransaction(async (session) => {
    await touchFence(db, session, lease, at(clock));
    const result = await write(session);
    await touchFence(db, session, lease, at(clock));
    return result;
  });
}

/** Stale release cannot clear a newer lease. Gate survives TTL lock cleanup. */
export async function releaseRecoveryLease(db: Db, input: RecoveryLease, clock: RecoveryClock = defaultClock): Promise<boolean> {
  const lease = leaseSchema.parse(input), now = at(clock);
  return withTransaction(async (session) => {
    const raw = await gates(db).findOne({ _id: lease.userId }, { session });
    if (!raw) return false;
    const current = recoveryGateSchema.parse(raw);
    if (current.leaseToken !== lease.token) return false;
    const lock = await locks(db).findOne({ _id: `notes:${lease.userId}` }, { session });
    if (lock && lock.owner !== lease.token) throw lost();
    const next = recoveryGateSchema.parse({ ...current, gateRevision: nextRecoveryRevision(current.gateRevision),
      leaseToken: null, leaseExpiresAt: null, updatedAt: now });
    const cleared = await gates(db).replaceOne({ _id: lease.userId, leaseToken: lease.token, gateRevision: current.gateRevision }, next, { session });
    if (cleared.matchedCount !== 1) throw lost();
    await locks(db).deleteOne({ _id: `notes:${lease.userId}`, owner: lease.token }, { session });
    return true;
  });
}

/** Epoch and callback writes are atomic. No actual cloud-wipe route uses this. */
export async function withRecoveryWipe(db: Db, input: RecoveryLease,
  erase: (session: ClientSession) => Promise<void>, clock: RecoveryClock = defaultClock): Promise<RecoveryLease> {
  const lease = leaseSchema.parse(input);
  return withTransaction(async (session) => {
    const current = await touchFence(db, session, lease, at(clock));
    const wipeEpoch = nextRecoveryRevision(current.wipeEpoch);
    await erase(session);
    const changed = await gates(db).updateOne({ _id: lease.userId, leaseToken: lease.token,
      wipeEpoch: lease.wipeEpoch, gateRevision: current.gateRevision }, { $inc: { wipeEpoch: 1 } }, { session });
    if (changed.matchedCount !== 1) throw lost();
    const next = { ...lease, wipeEpoch };
    await touchFence(db, session, next, at(clock));
    return next;
  });
}
