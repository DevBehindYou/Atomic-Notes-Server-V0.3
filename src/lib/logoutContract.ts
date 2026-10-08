import { createHash } from 'node:crypto';
import { z } from 'zod';
import { ENERGY } from './energyPolicy.js';
import type { SyncOperation } from './syncOperation.js';
import { remoteNoteRowSchema } from '../types/noteWire.js';

/** Matches current App batching. Too much work must refuse logout, never drop it. */
export const LOGOUT_BOUNDS = { batches: 5, rowsPerBatch: 50, bytesPerBatch: 2_500_000 } as const;
const safePositive = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
export const logoutBatchSchema = z.object({
  requestId: z.string().uuid(), fingerprint: digest,
  rowIds: z.array(z.string().uuid()).min(1).max(LOGOUT_BOUNDS.rowsPerBatch),
  wireBytes: safePositive.max(LOGOUT_BOUNDS.bytesPerBatch),
}).strict().superRefine((batch, ctx) => {
  if (new Set(batch.rowIds).size !== batch.rowIds.length) ctx.addIssue({ code: 'custom', message: 'duplicate_logout_note' });
});
export const logoutAttemptSchema = z.object({
  _id: z.string(), format: z.literal(1), userId: z.string().uuid(), attemptId: z.string().uuid(),
  sessionHash: digest, funding: z.enum(['paid', 'emergency']),
  batches: z.array(logoutBatchSchema).min(1).max(LOGOUT_BOUNDS.batches),
  state: z.enum(['prepared', 'completed', 'aborted']), createdAt: z.date(), updatedAt: z.date(),
}).strict().superRefine((attempt, ctx) => {
  if (attempt._id !== `${attempt.userId}:${attempt.attemptId}`) ctx.addIssue({ code: 'custom', message: 'logout_identity_mismatch' });
  if (attempt.updatedAt < attempt.createdAt) ctx.addIssue({ code: 'custom', message: 'logout_time_order' });
  if (new Set(attempt.batches.map(b => b.requestId)).size !== attempt.batches.length) {
    ctx.addIssue({ code: 'custom', message: 'duplicate_logout_request' });
  }
  const ids = attempt.batches.flatMap(b => b.rowIds);
  if (new Set(ids).size !== ids.length) ctx.addIssue({ code: 'custom', message: 'duplicate_logout_note' });
});
export type LogoutAttempt = z.infer<typeof logoutAttemptSchema>;

/** Pure policy only. The future caller must supply a fresh Server wallet after
 * daily grant, under the same transaction/lock as durable attempt admission.
 */
export function selectLogoutFunding(energy: number, batchCount: number): LogoutAttempt['funding'] {
  if (!Number.isSafeInteger(energy) || energy < 0 || !Number.isInteger(batchCount) ||
      batchCount < 1 || batchCount > LOGOUT_BOUNDS.batches) throw new Error('invalid_logout_budget');
  return energy >= ENERGY.syncInstantCost * batchCount ? 'paid' : 'emergency';
}

/** Wire-specific fixed ordering; no generic user-defined objects/prototypes.
 * Normalization through the existing schema includes its base_version default.
 * The fingerprint includes base versions, ciphertext and array order, but none
 * of those contents are persisted in the attempt manifest.
 */
export function logoutBatchFingerprint(input: unknown[]): string {
  const rows = z.array(remoteNoteRowSchema).min(1).max(LOGOUT_BOUNDS.rowsPerBatch).parse(input);
  if (new Set(rows.map(r => r.id)).size !== rows.length) throw new Error('duplicate_logout_note');
  const normalized = rows.map(r => ({
    id: r.id, kind: r.kind, title: r.title, body: r.body,
    items: r.items.map(i => ({ text: i.text, done: i.done })), pinned: r.pinned, deleted: r.deleted,
    created_at: r.created_at, ...(r.updated_at === undefined ? {} : { updated_at: r.updated_at }),
    enc_v: r.enc_v, payload: r.payload, base_version: r.base_version,
  }));
  return createHash('sha256').update(JSON.stringify({ rows: normalized, mode: 'instant' })).digest('hex');
}

/** Read-only eligibility check. It cannot revoke a session or clear a cache.
 * Completion must later atomically close the attempt and revoke ONLY its bound
 * session, and the App must still recheck current local work before clearing.
 */
export function logoutReceiptsComplete(input: unknown, sessionHash: string, operations: SyncOperation[]): boolean {
  const attempt = logoutAttemptSchema.parse(input);
  if (attempt.state !== 'prepared' || attempt.sessionHash !== sessionHash ||
      operations.length !== attempt.batches.length ||
      new Set(operations.map(o => o._id)).size !== operations.length) return false;
  return attempt.batches.every(batch => {
    const operation = operations.find(o => o._id === `${attempt.userId}:${batch.requestId}`);
    if (!operation || operation.userId !== attempt.userId || operation.status !== 'complete' ||
        operation.mode !== 'instant' || operation.fingerprint !== batch.fingerprint ||
        operation.rowIds.length !== batch.rowIds.length ||
        operation.rowIds.some((id, i) => id !== batch.rowIds[i]) ||
        operation.results.length !== batch.rowIds.length ||
        new Set(operation.results.map(r => r.id)).size !== batch.rowIds.length ||
        operation.results.some(r => !r.ok || !batch.rowIds.includes(r.id) ||
          !Number.isSafeInteger(r.version) || r.version! < 1)) return false;
    return operation.refunded === 0 && operation.charged ===
      (attempt.funding === 'emergency' ? 0 : ENERGY.syncInstantCost);
  });
}
