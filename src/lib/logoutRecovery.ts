import { createHash } from 'node:crypto';
import type { ClientSession, Db } from 'mongodb';
import { z } from 'zod';
import { collections, type SessionDoc } from '../db/collections.js';
import { withTransaction } from '../db/mongo.js';
import { ENERGY } from './energyPolicy.js';
import { logoutAttempts } from './logoutAttempt.js';
import { LOGOUT_BOUNDS, logoutAttemptSchema, logoutBatchSchema, logoutReceiptsComplete } from './logoutContract.js';
import { syncOperations, type SyncOperation, type SyncResult } from './syncOperation.js';

const denied = (code: string) => Object.assign(new Error(code), { status: 409 });
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const whole = (value: number) => Number.isSafeInteger(value) && value >= 0;
type BoundOperation = SyncOperation & { logoutAttemptId?: string; logoutSessionHash?: string };
type RecoverySession = SessionDoc & { logoutAttemptId?: string; logoutAttemptRevision?: number };

/** Rollout-gated read-only preflight. A fresh authenticated
 * owner can inspect settled metadata after the previous session expired/revoked.
 * This snapshot NEVER authorizes local erasure, adoption, refund or revocation.
 * A future mutating handoff must recheck every guard under the notes lock and a
 * transactional session fence. No Drive/token refresh or wallet initializer.
 */
export async function inspectLogoutRecovery(db: Db, user: unknown, currentToken: string,
  attempt: unknown, previousBinding: unknown, input: unknown) {
  const snapshot = await readLogoutRecoverySnapshot(db, user, currentToken, attempt, previousBinding, input);
  return recoveryReceiptResponse(snapshot);
}

function recoveryReceiptResponse(snapshot: Awaited<ReturnType<typeof readLogoutRecoverySnapshot>>) {
  return { attemptId: snapshot.attemptId, state: snapshot.state, batches: snapshot.summaries };
}

/** Immutable acknowledgements only, under the identical read-only guards.
 * No terminal handoff/session fence or local-erasure authority is provided.
 * Project a whitelist: never return operation internals, token/hash or note text.
 */
export async function readLogoutRecoveryReceipts(db: Db, user: unknown, currentToken: string,
  attempt: unknown, previousBinding: unknown, input: unknown) {
  const snapshot = await readLogoutRecoverySnapshot(db, user, currentToken, attempt, previousBinding, input);
  if (snapshot.receipts.some(batch => batch.results.some(result =>
    (result.version !== undefined && (!Number.isSafeInteger(result.version) || result.version < 1)) ||
    (result.seq !== undefined && (!Number.isSafeInteger(result.seq) || result.seq < 1)) ||
    (result.unchanged !== undefined && typeof result.unchanged !== 'boolean') || (result.ok
      ? typeof result.updated_at !== 'string' || result.updated_at.length > 40
      : typeof result.error !== 'string' || !/^[a-z][a-z0-9_]{0,79}$/.test(result.error))))) {
    throw denied('logout_recovery_receipt_invalid');
  }
  const response = { attemptId: snapshot.attemptId, state: snapshot.state, batches: snapshot.receipts };
  if (Buffer.byteLength(JSON.stringify(response), 'utf8') > 128 * 1024) {
    throw denied('logout_recovery_receipt_invalid');
  }
  return response;
}

async function readLogoutRecoverySnapshot(db: Db, user: unknown, currentToken: string,
  attempt: unknown, previousBinding: unknown, input: unknown) {
  return withTransaction(session => readLogoutRecoveryInSession(db, user, currentToken,
    attempt, previousBinding, input, session));
}

async function readLogoutRecoveryInSession(db: Db, user: unknown, currentToken: string,
  attempt: unknown, previousBinding: unknown, input: unknown, session: ClientSession) {
  const userId = z.string().uuid().parse(user), attemptId = z.string().uuid().parse(attempt);
  const previousHash = digest.parse(previousBinding);
  const batches = z.array(logoutBatchSchema).min(1).max(LOGOUT_BOUNDS.batches).parse(input);
  if (!currentToken) throw denied('logout_recovery_current_session_invalid');
  const currentHash = createHash('sha256').update(currentToken).digest('hex');
  if (currentHash === previousHash) throw denied('logout_recovery_same_session');
  const id = `${userId}:${attemptId}`;
    const now = new Date();
    const current = await collections.sessions(db).findOne({ _id: currentHash, userId,
      revoked: false, expiresAt: { $gt: now } }, { session });
    if (!current) throw denied('logout_recovery_current_session_invalid');
    if ((current as typeof current & { logoutAttemptId?: unknown }).logoutAttemptId !== undefined) {
      throw denied('logout_recovery_current_attempt_active');
    }
    const previous = await logoutAttempts(db).findOne({ _id: id, userId, sessionHash: previousHash }, { session });
    if (!previous) throw denied('logout_recovery_attempt_missing');
    const saved = logoutAttemptSchema.parse(previous);
    if (JSON.stringify(saved.batches) !== JSON.stringify(batches)) throw denied('logout_recovery_manifest_mismatch');
    const oldSession = await collections.sessions(db).findOne({ _id: previousHash }, { session });
    if (oldSession && oldSession.userId !== userId) throw denied('logout_recovery_session_mismatch');
    if (oldSession && (typeof oldSession.revoked !== 'boolean' || !(oldSession.expiresAt instanceof Date) ||
        !Number.isFinite(oldSession.expiresAt.getTime()))) throw denied('logout_recovery_session_invalid');
    if (oldSession && !oldSession.revoked && oldSession.expiresAt > now) {
      throw denied('logout_recovery_previous_session_active');
    }
    // Missing records are not assumed never sent: a legacy TTL/deletion could
    // have removed a committed receipt. Uncertain writes cannot be auto-settled.
    if (await syncOperations(db).findOne({ userId, status: 'pending' }, { session })) {
      throw denied('logout_recovery_reconciliation_required');
    }
    const operations = await syncOperations(db).find({ userId,
      _id: { $in: batches.map(batch => `${userId}:${batch.requestId}`) } }, { session }).toArray();
    if (operations.length !== batches.length) throw denied('logout_recovery_receipt_missing');
    const summaries = batches.map(batch => {
      const operation = operations.find(row => row._id === `${userId}:${batch.requestId}`) as BoundOperation;
      const cost = saved.funding === 'emergency' ? 0 : ENERGY.syncInstantCost;
      if (operation.status !== 'complete' || operation.mode !== 'instant' ||
          operation.logoutAttemptId !== id || operation.logoutSessionHash !== previousHash ||
          operation.fingerprint !== batch.fingerprint ||
          !Array.isArray(operation.rowIds) || operation.rowIds.length !== batch.rowIds.length ||
          operation.rowIds.some((noteId, index) => noteId !== batch.rowIds[index]) ||
          !whole(operation.charged) || operation.charged !== cost ||
          !whole(operation.refunded) || operation.refunded > operation.charged ||
          !Array.isArray(operation.results) || operation.results.length !== batch.rowIds.length ||
          operation.results.some(result => !result || typeof result !== 'object' || typeof result.id !== 'string') ||
          new Set(operation.results.map(result => result.id)).size !== batch.rowIds.length ||
          operation.results.some(result => !batch.rowIds.includes(result.id) ||
            typeof result.ok !== 'boolean' || (result.ok
              ? !Number.isSafeInteger(result.version) || result.version! < 1 ||
                typeof result.updated_at !== 'string' || !Number.isFinite(Date.parse(result.updated_at))
              : typeof result.error !== 'string' || result.error.length === 0)) ||
          (operation.results.every(result => result.ok) && operation.refunded !== 0)) {
        throw denied('logout_recovery_receipt_invalid');
      }
      return { requestId: batch.requestId, charged: operation.charged, refunded: operation.refunded,
        accepted: operation.results.filter(result => result.ok).length,
        failed: operation.results.filter(result => !result.ok).length };
    });
    // The shared predicate evaluates eligibility BEFORE completion. Recheck its
    // receipt rules on a local copy without changing the retained terminal state.
    if (saved.state === 'completed' && !logoutReceiptsComplete({ ...saved, state: 'prepared' }, previousHash, operations)) {
      throw denied('logout_recovery_receipt_invalid');
    }
    const receipts = batches.map(batch => {
      const operation = operations.find(row => row._id === `${userId}:${batch.requestId}`)!;
      return { requestId: batch.requestId, charged: operation.charged, refunded: operation.refunded,
        results: operation.results.map<SyncResult>(result => ({ id: result.id, ok: result.ok,
          ...(result.version === undefined ? {} : { version: result.version }),
          ...(result.seq === undefined ? {} : { seq: result.seq }),
          ...(result.unchanged === undefined ? {} : { unchanged: result.unchanged }),
          ...(result.ok ? { updated_at: result.updated_at! } : { error: result.error! }) })) };
    });
    return { attemptId, state: saved.state, summaries, receipts, current: current as RecoverySession,
      currentHash, saved };
}

/** Caller must hold the notes lock. This narrow recovery closes only a fully
 * settled previous plan. It never adopts/replays a batch or revokes either
 * session. The current-session increment is an actual transactional auth fence.
 * Missing/pending receipts remain blocked, including on terminal replay.
 */
export async function commitLogoutRecovery(db: Db, user: unknown, currentToken: string,
  attempt: unknown, previousBinding: unknown, input: unknown,
  hooks: { beforeWrites?: () => Promise<void>; afterWrites?: () => Promise<void> } = {}) {
  return withTransaction(async session => {
    const snapshot = await readLogoutRecoveryInSession(db, user, currentToken, attempt,
      previousBinding, input, session);
    // Validate the exact outbound whitelist before any state transition.
    const response = recoveryReceiptResponse(snapshot);
    const revision = snapshot.current.logoutAttemptRevision ?? 0;
    if (!Number.isSafeInteger(revision) || revision < 0 || revision >= Number.MAX_SAFE_INTEGER) {
      throw denied('logout_revision_exhausted');
    }
    await hooks.beforeWrites?.();
    const fenced = await collections.sessions(db).updateOne({ _id: snapshot.currentHash,
      userId: snapshot.saved.userId, revoked: false, expiresAt: { $gt: new Date() },
      logoutAttemptId: { $exists: false },
      ...(snapshot.current.logoutAttemptRevision === undefined
        ? { logoutAttemptRevision: { $exists: false } } : { logoutAttemptRevision: revision }) },
    { $inc: { logoutAttemptRevision: 1 } }, { session });
    if (fenced.matchedCount !== 1) throw denied('logout_session_changed');
    const terminal = snapshot.state === 'prepared'
      ? snapshot.summaries.every(batch => batch.failed === 0) ? 'completed' as const : 'aborted' as const
      : snapshot.state;
    if (snapshot.state === 'prepared') {
      const closed = await logoutAttempts(db).updateOne({ _id: snapshot.saved._id,
        userId: snapshot.saved.userId, sessionHash: snapshot.saved.sessionHash,
        state: 'prepared', updatedAt: snapshot.saved.updatedAt },
      { $set: { state: terminal, updatedAt: new Date() } }, { session });
      if (closed.matchedCount !== 1) throw denied('logout_recovery_attempt_changed');
    }
    await hooks.afterWrites?.();
    return { ...response, state: terminal };
  });
}
