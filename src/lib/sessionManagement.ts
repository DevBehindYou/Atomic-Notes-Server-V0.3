import { createHash } from 'node:crypto';
import type { ClientSession, Db } from 'mongodb';
import { z } from 'zod';
import { collections, sessionSchema, type SessionDoc } from '../db/collections.js';
import { withTransaction } from '../db/mongo.js';
import { httpError } from './httpError.js';
import { MAX_ACTIVE_SESSIONS } from './session.js';

const QUERY_DEADLINE_MS = 2000;
const handleSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
export const revokeManagedSessionSchema = z.object({ session_handle: handleSchema }).strict();
const storedHashSchema = z.string().regex(/^[a-f0-9]{64}$/);

function identity(user: unknown, rawToken: string) {
  const userId = z.string().uuid().parse(user);
  if (!rawToken) throw httpError('invalid_token', 401);
  return { userId, hash: createHash('sha256').update(rawToken).digest('hex') };
}
type Identity = ReturnType<typeof identity>;

async function boundedRead<T>(run: () => Promise<T>): Promise<T> {
  try { return await run(); } catch (error) {
    if ((error as { code?: unknown })?.code === 50) throw httpError('session_inventory_unavailable', 409);
    throw error;
  }
}

function publicHandle(userId: string, storedHash: string) {
  return createHash('sha256').update('atomic-notes/session-management/handle/v1\0')
    .update(userId).update('\0').update(storedHash).digest('base64url');
}

function validRow(row: unknown): SessionDoc | null {
  const parsed = sessionSchema.safeParse(row);
  if (!parsed.success || !storedHashSchema.safeParse(parsed.data._id).success ||
      !Number.isFinite(parsed.data.createdAt.getTime()) || !Number.isFinite(parsed.data.expiresAt.getTime())) return null;
  return parsed.data;
}

async function liveCurrent(db: Db, ctx: Identity, session?: ClientSession) {
  const row = validRow(await boundedRead(() => collections.sessions(db).findOne({ _id: ctx.hash, userId: ctx.userId,
    revoked: false, expiresAt: { $gt: new Date() } }, { session, maxTimeMS: QUERY_DEADLINE_MS })));
  if (!row) throw httpError('invalid_token', 401);
  if (row.logoutAttemptId !== undefined) throw httpError('session_logout_active', 409);
  return row;
}

async function inventory(db: Db, ctx: Identity, session?: ClientSession) {
  const rows = await boundedRead(() => collections.sessions(db).find({ userId: ctx.userId, revoked: false,
    expiresAt: { $gt: new Date() } }, { session, projection: {
      _id: 1, userId: 1, createdAt: 1, expiresAt: 1, revoked: 1, userAgent: 1,
      logoutAttemptId: 1, logoutAttemptRevision: 1,
    } }).sort({ createdAt: -1, _id: -1 }).limit(MAX_ACTIVE_SESSIONS + 1).maxTimeMS(QUERY_DEADLINE_MS).toArray());
  if (rows.length > MAX_ACTIVE_SESSIONS) throw httpError('session_inventory_overflow', 409);
  const parsed = rows.map(validRow);
  if (parsed.some(row => !row || row.userId !== ctx.userId)) throw httpError('session_inventory_invalid', 409);
  const valid = parsed as SessionDoc[];
  if (!valid.some(row => row._id === ctx.hash)) throw httpError('session_inventory_changed', 409);
  return valid;
}

function agentLabel(value: string | null | undefined): string | null {
  if (!value) return null;
  const cleaned = value.replace(/[\p{C}\p{Zl}\p{Zp}]/gu, '').trim();
  return Array.from(cleaned).slice(0, 80).join('') || null;
}

/** Read-only inventory. A final live-auth check retires reads started before
 * logout; a response already in flight can still finish after a later revoke.
 * Agent text is an untrusted display hint, never authenticated device identity.
 */
export async function listManagedSessions(db: Db, user: unknown, rawToken: string,
  hooks: { afterInventory?: () => Promise<void> } = {}) {
  const ctx = identity(user, rawToken);
  await liveCurrent(db, ctx);
  const rows = await inventory(db, ctx);
  await hooks.afterInventory?.();
  await liveCurrent(db, ctx);
  return { sessions: rows.map(row => ({ session_handle: publicHandle(ctx.userId, row._id),
    created_at: row.createdAt.toISOString(), expires_at: row.expiresAt.toISOString(),
    is_current: row._id === ctx.hash, agent_label: agentLabel(row.userAgent) })), limit: MAX_ACTIVE_SESSIONS };
}

/** Revoke exactly one OTHER session. The existing logout revision provides a
 * real transactional auth fence without a new field or sliding token expiry.
 * Bound Safe Logout attempts on either session must be resolved first.
 */
export async function revokeManagedSession(db: Db, user: unknown, rawToken: string, input: unknown,
  hooks: { beforeFence?: () => Promise<void>; afterWrites?: () => Promise<void>; beforeNoopReply?: () => Promise<void> } = {}) {
  const ctx = identity(user, rawToken), { session_handle: requested } = revokeManagedSessionSchema.parse(input);
  const changed = await withTransaction(async session => {
    const current = await liveCurrent(db, ctx, session);
    if (requested === publicHandle(ctx.userId, current._id)) throw httpError('current_session_requires_safe_logout', 409);
    const rows = await inventory(db, ctx, session);
    const target = rows.find(row => publicHandle(ctx.userId, row._id) === requested);
    if (!target) return false; // Same response for foreign, unknown and retired handles.
    if (target.logoutAttemptId !== undefined) throw httpError('session_logout_active', 409);
    const revision = current.logoutAttemptRevision ?? 0;
    if (!Number.isSafeInteger(revision) || revision < 0 || revision >= Number.MAX_SAFE_INTEGER) {
      throw httpError('session_revision_exhausted', 409);
    }
    await hooks.beforeFence?.();
    const fenced = await collections.sessions(db).updateOne({ _id: ctx.hash, userId: ctx.userId,
      revoked: false, expiresAt: { $gt: new Date() }, logoutAttemptId: { $exists: false },
      logoutAttemptRevision: current.logoutAttemptRevision === undefined ? { $exists: false } : revision },
    { $inc: { logoutAttemptRevision: 1 } }, { session });
    if (fenced.matchedCount !== 1) throw httpError('invalid_token', 401);
    const retired = await collections.sessions(db).updateOne({ _id: target._id, userId: ctx.userId,
      revoked: false, expiresAt: { $gt: new Date() }, logoutAttemptId: { $exists: false } },
    { $set: { revoked: true } }, { session });
    if (retired.matchedCount !== 1) throw httpError('session_inventory_changed', 409);
    await hooks.afterWrites?.();
    return true;
  });
  if (!changed) {
    await hooks.beforeNoopReply?.();
    await liveCurrent(db, ctx); // No-op transactions must also reject retired callers.
  }
  return { ok: true as const };
}
