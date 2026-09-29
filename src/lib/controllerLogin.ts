import { createHash } from 'node:crypto';
import type { Db } from 'mongodb';
import { collections } from '../db/collections.js';

/**
 * State the Controller (Atomic-Notes-Community) cannot keep itself: it runs as stateless serverless functions,
 * so a sign-in throttle or a "log out everywhere" needs a store both of its instances share. The Controller
 * reaches these through the admin API with its admin key.
 */

/** Wrong sign-ins a client may make within [LOGIN_WINDOW_MS] before it is locked out for [LOGIN_LOCK_MS]. */
export const LOGIN_MAX_FAILURES = 5;
export const LOGIN_WINDOW_MS = 15 * 60 * 1000;
export const LOGIN_LOCK_MS = 15 * 60 * 1000;

const SESSION_EPOCH = 'controller_session_epoch';

/** The client's address is only ever stored hashed. */
const clientKey = (client: string) => createHash('sha256').update(`controller-login:${client}`).digest('hex');

export type LoginGate = { allowed: boolean; retry_after_seconds: number };

function gate(lockedUntil: Date | null | undefined, now: Date): LoginGate {
  const wait = lockedUntil ? Math.ceil((lockedUntil.getTime() - now.getTime()) / 1000) : 0;
  return wait > 0 ? { allowed: false, retry_after_seconds: wait } : { allowed: true, retry_after_seconds: 0 };
}

/** Whether [client] may try to sign in now. */
export async function checkLogin(db: Db, client: string, now = new Date()): Promise<LoginGate> {
  const doc = await collections.controllerLoginAttempts(db).findOne({ _id: clientKey(client) });
  return gate(doc?.lockedUntil, now);
}

/**
 * Counts one wrong sign-in from [client]. The count restarts once its window has passed; the failure that
 * reaches [LOGIN_MAX_FAILURES] locks the client out. One atomic update, so parallel guesses all count.
 */
export async function recordLoginFailure(db: Db, client: string, now = new Date()): Promise<LoginGate> {
  const windowCutoff = new Date(now.getTime() - LOGIN_WINDOW_MS);
  const fresh = { $or: [{ $eq: [{ $type: '$windowStart' }, 'missing'] }, { $lt: ['$windowStart', windowCutoff] }] };
  const after = await collections.controllerLoginAttempts(db).findOneAndUpdate(
    { _id: clientKey(client) },
    [
      {
        $set: {
          failures: { $cond: [fresh, 1, { $add: ['$failures', 1] }] },
          windowStart: { $cond: [fresh, now, '$windowStart'] },
        },
      },
      {
        $set: {
          lockedUntil: {
            $cond: [{ $gte: ['$failures', LOGIN_MAX_FAILURES] }, new Date(now.getTime() + LOGIN_LOCK_MS), { $ifNull: ['$lockedUntil', null] }],
          },
        },
      },
      // Kept only while it matters: until the window ends or the lock lifts, whichever is later.
      { $set: { expiresAt: { $max: [{ $add: ['$windowStart', LOGIN_WINDOW_MS] }, { $ifNull: ['$lockedUntil', now] }] } } },
    ],
    { upsert: true, returnDocument: 'after' },
  );
  return gate(after?.lockedUntil, now);
}

/** A right sign-in clears the client's count. */
export async function recordLoginSuccess(db: Db, client: string): Promise<void> {
  await collections.controllerLoginAttempts(db).deleteOne({ _id: clientKey(client) });
}

/** Controller sessions issued before this time (ms, the Controller's clock) are no longer valid. */
export async function controllerSessionEpoch(db: Db): Promise<number | null> {
  return (await collections.adminSettings(db).findOne({ _id: SESSION_EPOCH }))?.value ?? null;
}

/** Ends every Controller session issued before [revokedBefore]. Never moves the time backwards. */
export async function revokeControllerSessions(db: Db, revokedBefore: number): Promise<number> {
  const after = await collections.adminSettings(db).findOneAndUpdate(
    { _id: SESSION_EPOCH },
    [{ $set: { value: { $max: [{ $ifNull: ['$value', 0] }, revokedBefore] }, updatedAt: '$$NOW' } }],
    { upsert: true, returnDocument: 'after' },
  );
  return after?.value ?? revokedBefore;
}
