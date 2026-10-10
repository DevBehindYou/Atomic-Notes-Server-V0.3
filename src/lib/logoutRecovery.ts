import { createHash } from 'node:crypto';
import type { Db } from 'mongodb';
import { z } from 'zod';
import { collections } from '../db/collections.js';
import { withTransaction } from '../db/mongo.js';
import { ENERGY } from './energyPolicy.js';
import { logoutAttempts } from './logoutAttempt.js';
import { LOGOUT_BOUNDS, logoutAttemptSchema, logoutBatchSchema, logoutReceiptsComplete } from './logoutContract.js';
import { syncOperations, type SyncOperation } from './syncOperation.js';

const denied = (code: string) => Object.assign(new Error(code), { status: 409 });
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const whole = (value: number) => Number.isSafeInteger(value) && value >= 0;
type BoundOperation = SyncOperation & { logoutAttemptId?: string; logoutSessionHash?: string };

/** Inactive read-only preflight; no route calls this helper. A fresh authenticated
 * owner can inspect settled metadata after the previous session expired/revoked.
 * This snapshot NEVER authorizes local erasure, adoption, refund or revocation.
 * A future mutating handoff must recheck every guard under the notes lock and a
 * transactional session fence. No Drive/token refresh or wallet initializer.
 */
export async function inspectLogoutRecovery(db: Db, user: unknown, currentToken: string,
  attempt: unknown, previousBinding: unknown, input: unknown) {
  const userId = z.string().uuid().parse(user), attemptId = z.string().uuid().parse(attempt);
  const previousHash = digest.parse(previousBinding);
  const batches = z.array(logoutBatchSchema).min(1).max(LOGOUT_BOUNDS.batches).parse(input);
  if (!currentToken) throw denied('logout_recovery_current_session_invalid');
  const currentHash = createHash('sha256').update(currentToken).digest('hex');
  if (currentHash === previousHash) throw denied('logout_recovery_same_session');
  const id = `${userId}:${attemptId}`;
  return withTransaction(async session => {
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
    if (saved.state === 'completed' && !logoutReceiptsComplete(saved, previousHash, operations)) {
      throw denied('logout_recovery_receipt_invalid');
    }
    return { attemptId, state: saved.state, batches: summaries };
  });
}
