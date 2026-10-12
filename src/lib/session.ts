import { randomBytes, createHash } from 'node:crypto';
import type { Db } from 'mongodb';
import { collections } from '../db/collections.js';

const SESSION_TTL_MS = 180 * 24 * 60 * 60 * 1000; // Fixed 180 days from sign-in; no inactivity expiry.

function hashToken(rawToken: string): string {
  return createHash('sha256').update(rawToken).digest('hex');
}

/**
 * Creates a session and returns the RAW token to hand to the client. Only the
 * SHA-256 hash is stored in MongoDB — the raw token exists nowhere else,
 * same reasoning as never storing plaintext passwords. The sessions
 * collection has a TTL index on `expiresAt` (see db/collections.ts), so
 * expired sessions clean themselves up without a cron job.
 * The optional instant supports deterministic fixtures; callers default to
 * server wall time. Verification never extends a stored deadline.
 */
export async function createSession(db: Db, userId: string, userAgent?: string | null, now = new Date()): Promise<string> {
  const rawToken = randomBytes(32).toString('base64url');
  await collections.sessions(db).insertOne({
    _id: hashToken(rawToken),
    userId,
    createdAt: now,
    expiresAt: new Date(now.getTime() + SESSION_TTL_MS),
    revoked: false,
    userAgent: userAgent ?? null,
  });
  await limitActiveSessions(db, userId);
  return rawToken;
}

/**
 * Every sign-in makes a session valid for 180 days unless explicitly revoked. Keeping the newest
 * few means a phone, a tablet and a spare all work, while a token that was left behind stops working.
 */
export const MAX_ACTIVE_SESSIONS = 5;
async function limitActiveSessions(db: Db, userId: string) {
  const active = await collections.sessions(db).find({ userId, revoked: false }, { projection: { _id: 1 } })
    .sort({ createdAt: -1 }).skip(MAX_ACTIVE_SESSIONS).toArray();
  if (active.length > 0) await collections.sessions(db).updateMany({ _id: { $in: active.map((s) => s._id) } }, { $set: { revoked: true } });
}

/** Returns the session's userId if the raw token is valid, not revoked, and unexpired — else null. */
export async function verifySession(db: Db, rawToken: string, now = new Date()): Promise<string | null> {
  const doc = await collections.sessions(db).findOne({ _id: hashToken(rawToken) });
  if (!doc) return null;
  if (doc.revoked) return null;
  if (doc.expiresAt.getTime() <= now.getTime()) return null;
  return doc.userId;
}

/** Used by /auth/logout. Idempotent — revoking an already-revoked or unknown token is a no-op. */
export async function revokeSession(db: Db, rawToken: string): Promise<void> {
  await collections.sessions(db).updateOne({ _id: hashToken(rawToken) }, { $set: { revoked: true } });
}
