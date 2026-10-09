import { createHash } from 'node:crypto';
import type { ClientSession, Db } from 'mongodb';
import { z } from 'zod';
import { collections, type SessionDoc } from '../db/collections.js';
import { withTransaction } from '../db/mongo.js';
import { dailyGrantDue, energyGrantDaily, energyWallet } from './energy.js';
import { debitSyncInSession, finishSyncInSession, syncOperations, type SyncOperation } from './syncOperation.js';
import { logoutAttemptSchema, logoutBatchSchema, logoutBatchFingerprint, logoutReceiptsComplete,
  LOGOUT_BOUNDS, selectLogoutFunding, type LogoutAttempt } from './logoutContract.js';
import { remoteNoteRowSchema } from '../types/noteWire.js';

/** Inactive helpers: callers must hold the notes lock and reconcile older work.
 * No production route imports this module. Only metadata is stored here.
 */
type BoundSession = SessionDoc & { logoutAttemptId?: string; logoutAttemptRevision?: number };
type BoundOperation = SyncOperation & { logoutAttemptId: string; logoutSessionHash: string };
export const logoutAttempts = (db: Db) => db.collection<LogoutAttempt>('logout_attempts');
const boundSessions = (db: Db) => db.collection<BoundSession>('sessions');
const denied = (code: string) => Object.assign(new Error(code), { status: 409 });
const identity = (user: unknown, rawToken: string, attempt: unknown) => {
  const userId = z.string().uuid().parse(user), attemptId = z.string().uuid().parse(attempt);
  if (!rawToken) throw denied('logout_session_invalid');
  return { userId, attemptId, id: `${userId}:${attemptId}`, sessionHash: createHash('sha256').update(rawToken).digest('hex') };
};
type Identity = ReturnType<typeof identity>;
async function liveSession(db: Db, ctx: Identity, session: ClientSession, active: boolean) {
  const seen = await boundSessions(db).findOne({ _id: ctx.sessionHash, userId: ctx.userId, revoked: false,
    expiresAt: { $gt: new Date() } }, { session });
  if (!seen || (active && seen.logoutAttemptId !== ctx.id)) throw denied('logout_session_invalid');
  const revision = seen.logoutAttemptRevision ?? 0;
  if (!Number.isSafeInteger(revision) || revision < 0 || revision >= Number.MAX_SAFE_INTEGER) throw denied('logout_revision_exhausted');
  return seen;
}
async function touchSession(db: Db, ctx: Identity, session: ClientSession, seen: BoundSession) {
  const changed = await boundSessions(db).updateOne({ _id: ctx.sessionHash, userId: ctx.userId, revoked: false,
    expiresAt: { $gt: new Date() }, logoutAttemptId: seen.logoutAttemptId ?? { $exists: false },
    logoutAttemptRevision: seen.logoutAttemptRevision ?? { $exists: false } },
  { $inc: { logoutAttemptRevision: 1 }, $set: { logoutAttemptId: ctx.id } }, { session });
  if (changed.matchedCount !== 1) throw denied('logout_session_changed');
}
async function activeAttempt(db: Db, ctx: Identity, session: ClientSession) {
  const attempt = await logoutAttempts(db).findOne({ _id: ctx.id, userId: ctx.userId, sessionHash: ctx.sessionHash }, { session });
  if (!attempt) throw denied('logout_attempt_missing');
  const parsed = logoutAttemptSchema.parse(attempt);
  if (parsed.state !== 'prepared') throw denied('logout_attempt_closed');
  return parsed;
}

export async function admitLogoutAttempt(db: Db, user: unknown, rawToken: string, attempt: unknown,
  input: unknown, afterWrites?: () => Promise<void>) {
  const ctx = identity(user, rawToken, attempt);
  const batches = z.array(logoutBatchSchema).min(1).max(LOGOUT_BOUNDS.batches).parse(input);
  // Reject duplicate identities before preflight can initialize/grant a wallet.
  logoutAttemptSchema.parse({ _id: ctx.id, format: 1, userId: ctx.userId, attemptId: ctx.attemptId,
    sessionHash: ctx.sessionHash, funding: 'paid', batches, state: 'prepared', createdAt: new Date(0), updatedAt: new Date(0) });
  const prior = await logoutAttempts(db).findOne({ _id: ctx.id });
  if (!prior) {
    // Authentication before independent existing-policy daily-grant preflight.
    const live = await boundSessions(db).findOne({ _id: ctx.sessionHash, userId: ctx.userId, revoked: false, expiresAt: { $gt: new Date() } });
    if (!live || live.logoutAttemptId) throw denied('logout_attempt_active');
    if (await syncOperations(db).findOne({ userId: ctx.userId, status: 'pending' })) throw denied('logout_reconciliation_required');
    const wallet = await energyWallet(db, ctx.userId);
    if (dailyGrantDue(wallet)) await energyGrantDaily(db, ctx.userId);
  }
  return withTransaction(async session => {
    const seen = await liveSession(db, ctx, session, false);
    const previous = await logoutAttempts(db).findOne({ _id: ctx.id }, { session });
    if (previous) {
      const parsed = logoutAttemptSchema.parse(previous);
      if (parsed.userId !== ctx.userId || parsed.sessionHash !== ctx.sessionHash ||
          JSON.stringify(parsed.batches) !== JSON.stringify(batches)) throw denied('logout_attempt_mismatch');
      if (parsed.state !== 'prepared' || seen.logoutAttemptId !== ctx.id) throw denied('logout_attempt_closed');
      return parsed; // No debit, grant, new attempt, or touch on exact admission replay.
    }
    if (seen.logoutAttemptId) throw denied('logout_attempt_active');
    if (await syncOperations(db).findOne({ userId: ctx.userId, status: 'pending' }, { session })) throw denied('logout_reconciliation_required');
    const wallet = await collections.atomicUsers(db).findOne({ _id: ctx.userId }, { session });
    if (!wallet) throw denied('logout_wallet_missing');
    const fundingRevision = wallet.logoutFundingRevision ?? 0;
    if (!Number.isSafeInteger(fundingRevision) || fundingRevision < 0 || fundingRevision >= Number.MAX_SAFE_INTEGER) {
      throw denied('logout_revision_exhausted');
    }
    const now = new Date();
    const document = logoutAttemptSchema.parse({ _id: ctx.id, format: 1, userId: ctx.userId, attemptId: ctx.attemptId,
      sessionHash: ctx.sessionHash, funding: selectLogoutFunding(wallet.energy, batches.length),
      batches, state: 'prepared', createdAt: now, updatedAt: now });
    // Serialize against concurrent wallet writes without granting/debiting Energy.
    const walletFence = await collections.atomicUsers(db).updateOne({ _id: ctx.userId, energy: wallet.energy },
      { $inc: { logoutFundingRevision: 1 } }, { session });
    if (walletFence.matchedCount !== 1) throw denied('logout_wallet_changed');
    await touchSession(db, ctx, session, seen);
    await logoutAttempts(db).insertOne(document, { session });
    await afterWrites?.();
    return document;
  });
}

export async function openLogoutBatch(db: Db, user: unknown, rawToken: string, attempt: unknown,
  request: unknown, input: unknown, afterWrites?: () => Promise<void>) {
  const ctx = identity(user, rawToken, attempt), requestId = z.string().uuid().parse(request);
  const rows = z.array(remoteNoteRowSchema).min(1).max(LOGOUT_BOUNDS.rowsPerBatch).parse(input);
  const fingerprint = logoutBatchFingerprint(rows);
  const wireBytes = Buffer.byteLength(JSON.stringify({ rows, requestId, mode: 'instant', logoutAttemptId: ctx.attemptId }));
  return withTransaction(async session => {
    const seen = await liveSession(db, ctx, session, true), admitted = await activeAttempt(db, ctx, session);
    const batch = admitted.batches.find(b => b.requestId === requestId);
    if (!batch || batch.fingerprint !== fingerprint || wireBytes > batch.wireBytes ||
        rows.length !== batch.rowIds.length || rows.some((r, i) => r.id !== batch.rowIds[i])) throw denied('logout_batch_mismatch');
    const id = `${ctx.userId}:${requestId}`;
    const previous = await syncOperations(db).findOne({ _id: id }, { session }) as BoundOperation | null;
    if (previous) {
      if (previous.fingerprint !== fingerprint || previous.mode !== 'instant' ||
          previous.logoutAttemptId !== ctx.id || previous.logoutSessionHash !== ctx.sessionHash) throw denied('logout_batch_mismatch');
      return previous; // Retry is the same operation, even after a lost receipt.
    }
    if (await syncOperations(db).findOne({ userId: ctx.userId, status: 'pending' }, { session })) throw denied('logout_reconciliation_required');
    await touchSession(db, ctx, session, seen);
    let operation: SyncOperation;
    if (admitted.funding === 'paid') {
      operation = await debitSyncInSession(db, ctx.userId, requestId, rows, 'instant', fingerprint, new Date(), session);
    } else {
      operation = { _id: id, userId: ctx.userId, fingerprint, mode: 'instant', rowIds: rows.map(r => r.id),
        charged: 0, refunded: 0, createdAt: new Date(), previousStandardAt: null, status: 'pending', results: [] };
      await syncOperations(db).insertOne(operation, { session });
    }
    const bound = { ...operation, logoutAttemptId: ctx.id, logoutSessionHash: ctx.sessionHash };
    await syncOperations(db).updateOne({ _id: id, status: 'pending' },
      { $set: { logoutAttemptId: ctx.id, logoutSessionHash: ctx.sessionHash } }, { session });
    await afterWrites?.();
    return bound;
  });
}

/** Authorize/replay before quota or Drive-token preflight, without charging. */
export async function findLogoutBatch(db: Db, user: unknown, rawToken: string, attempt: unknown,
  request: unknown, input: unknown) {
  const ctx = identity(user, rawToken, attempt), requestId = z.string().uuid().parse(request);
  const rows = z.array(remoteNoteRowSchema).min(1).max(LOGOUT_BOUNDS.rowsPerBatch).parse(input);
  const fingerprint = logoutBatchFingerprint(rows);
  const wireBytes = Buffer.byteLength(JSON.stringify({ rows, requestId, mode: 'instant', logoutAttemptId: ctx.attemptId }));
  return withTransaction(async session => {
    await liveSession(db, ctx, session, true);
    const admitted = await activeAttempt(db, ctx, session), batch = admitted.batches.find(b => b.requestId === requestId);
    if (!batch || batch.fingerprint !== fingerprint || wireBytes > batch.wireBytes ||
        rows.length !== batch.rowIds.length || rows.some((r, i) => r.id !== batch.rowIds[i])) throw denied('logout_batch_mismatch');
    const previous = await syncOperations(db).findOne({ _id: `${ctx.userId}:${requestId}` }, { session }) as BoundOperation | null;
    if (previous && (previous.fingerprint !== fingerprint || previous.mode !== 'instant' ||
        previous.logoutAttemptId !== ctx.id || previous.logoutSessionHash !== ctx.sessionHash)) throw denied('logout_batch_mismatch');
    return previous;
  });
}

/** A failed frozen plan can be abandoned after every started batch is settled.
 * Keep all receipts/charges/refunds; a new explicit logout gets a new decision.
 */
export async function abortLogoutAttempt(db: Db, user: unknown, rawToken: string, attempt: unknown) {
  const ctx = identity(user, rawToken, attempt);
  return withTransaction(async session => {
    const seen = await liveSession(db, ctx, session, false);
    const previous = await logoutAttempts(db).findOne({ _id: ctx.id, userId: ctx.userId, sessionHash: ctx.sessionHash }, { session });
    if (!previous) throw denied('logout_attempt_missing');
    const admitted = logoutAttemptSchema.parse(previous);
    if (admitted.state === 'aborted') return admitted;
    if (admitted.state !== 'prepared' || seen.logoutAttemptId !== ctx.id) throw denied('logout_attempt_closed');
    if (await syncOperations(db).findOne({ userId: ctx.userId, status: 'pending' }, { session })) throw denied('logout_reconciliation_required');
    await touchSession(db, ctx, session, seen);
    await boundSessions(db).updateOne({ _id: ctx.sessionHash, userId: ctx.userId, logoutAttemptId: ctx.id },
      { $unset: { logoutAttemptId: '' } }, { session });
    const updatedAt = new Date();
    await logoutAttempts(db).updateOne({ _id: ctx.id, state: 'prepared' }, { $set: { state: 'aborted', updatedAt } }, { session });
    return { ...admitted, state: 'aborted' as const, updatedAt };
  });
}

export async function settleLogoutBatch(db: Db, user: unknown, rawToken: string, attempt: unknown, request: unknown) {
  const ctx = identity(user, rawToken, attempt), requestId = z.string().uuid().parse(request);
  return withTransaction(async session => {
    const seen = await liveSession(db, ctx, session, true), admitted = await activeAttempt(db, ctx, session);
    if (!admitted.batches.some(b => b.requestId === requestId)) throw denied('logout_batch_mismatch');
    const operation = await syncOperations(db).findOne({ _id: `${ctx.userId}:${requestId}` }, { session }) as BoundOperation | null;
    if (!operation || operation.logoutAttemptId !== ctx.id || operation.logoutSessionHash !== ctx.sessionHash) throw denied('logout_batch_mismatch');
    if (operation.status === 'complete') return operation;
    await touchSession(db, ctx, session, seen);
    return finishSyncInSession(db, operation, session);
  });
}

export async function completeLogoutAttempt(db: Db, user: unknown, rawToken: string, attempt: unknown,
  afterWrites?: () => Promise<void>) {
  const ctx = identity(user, rawToken, attempt);
  return withTransaction(async session => {
    const previous = await logoutAttempts(db).findOne({ _id: ctx.id, userId: ctx.userId, sessionHash: ctx.sessionHash }, { session });
    if (!previous) throw denied('logout_attempt_missing');
    const admitted = logoutAttemptSchema.parse(previous);
    // A bound historical token can retrieve only its completed result; future
    // HTTP routing must explicitly support this receipt replay without reauth.
    if (admitted.state === 'completed') return admitted;
    const seen = await liveSession(db, ctx, session, true);
    const operations = await syncOperations(db).find({ _id: { $in: admitted.batches.map(b => `${ctx.userId}:${b.requestId}`) } }, { session }).toArray();
    if (operations.some(operation => (operation as BoundOperation).logoutAttemptId !== ctx.id ||
        (operation as BoundOperation).logoutSessionHash !== ctx.sessionHash)) throw denied('logout_batch_mismatch');
    if (!logoutReceiptsComplete(admitted, ctx.sessionHash, operations)) throw denied('logout_sync_incomplete');
    await touchSession(db, ctx, session, seen);
    await boundSessions(db).updateOne({ _id: ctx.sessionHash, userId: ctx.userId, revoked: false, logoutAttemptId: ctx.id },
      { $set: { revoked: true }, $unset: { logoutAttemptId: '' } }, { session });
    const updatedAt = new Date();
    await logoutAttempts(db).updateOne({ _id: ctx.id, state: 'prepared' }, { $set: { state: 'completed', updatedAt } }, { session });
    await afterWrites?.();
    return { ...admitted, state: 'completed' as const, updatedAt };
  });
}
