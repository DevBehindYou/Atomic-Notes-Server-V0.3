import { z } from 'zod';
import type { Db, ClientSession } from 'mongodb';
import { collections } from '../db/collections.js';
import { parseRecoveryIntents } from '../db/recoveryContract.js';
import { remoteNoteRowSchema } from '../types/noteWire.js';
import { noteContentHash } from './contentHash.js';
import { energyWallet, energyGrantDaily, dailyGrantDue } from './energy.js';
import { assertSyncWindow, debitSyncInSession, fingerprintOf, syncOperations, type SyncOperation } from './syncOperation.js';
import { prepareRecoveryIntentsInSession } from './recoveryIntent.js';
import { withRecoveryFence, type RecoveryLease } from './recoveryGate.js';

/** Inactive generation admission. Deleted/restore rows retain immutable content;
 * no production route imports this module or performs this protocol yet.
 */
type Operation = SyncOperation & { recoveryFormat: 1 };
export async function beginRecoverySync(db: Db, lease: RecoveryLease, request: unknown, input: unknown,
  selectedMode: unknown, manifests: unknown, afterWrites?: (session: ClientSession) => Promise<void>) {
  const requestId = z.string().uuid().parse(request);
  const rows = z.array(remoteNoteRowSchema).min(1).max(50).parse(input);
  const mode = z.enum(['standard', 'instant']).parse(selectedMode);
  const intents = parseRecoveryIntents(manifests);
  const id = `${lease.userId}:${requestId}`, fingerprint = fingerprintOf(rows, mode);
  if (rows.length !== intents.length || new Set(rows.map((row) => row.id)).size !== rows.length ||
      intents.some((intent, i) => intent.operationId !== id || intent.userId !== lease.userId ||
        intent.fingerprint !== fingerprint || intent.noteId !== rows[i].id || intent.expectedVersion !== rows[i].base_version ||
        intent.state !== 'prepared' || intent.leaseToken !== lease.token || intent.wipeEpoch !== lease.wipeEpoch ||
        !intent.stagedFileId || intent.targetFlags.deleted !== rows[i].deleted || intent.targetHash !== noteContentHash(rows[i]) ||
        intent.targetFlags.kind !== rows[i].kind || intent.targetFlags.pinned !== rows[i].pinned || intent.targetFlags.encV !== rows[i].enc_v)) {
    throw new Error('recovery_admission_manifest_invalid');
  }
  const prior = await withRecoveryFence(db, lease, async (session) => {
    const previous = await syncOperations(db).findOne({ _id: id }, { session });
    if (previous && previous.fingerprint !== fingerprint) throw Object.assign(new Error('sync_request_mismatch'), { status: 409 });
    if (previous && (previous as Operation).recoveryFormat !== 1) throw new Error('recovery_admission_legacy_operation');
    return previous;
  });
  // Terminal replay precedes wallet grants/cooldown. It can never stage or debit.
  if (prior?.status === 'complete') return { operation: prior, intents: [] };
  // Existing independent wallet initialization/daily grants are preflight only;
  // their policy is unchanged and they are not part of the paid-intent atomicity.
  const wallet = await energyWallet(db, lease.userId);
  if (dailyGrantDue(wallet)) await energyGrantDaily(db, lease.userId);
  return withRecoveryFence(db, lease, async (session) => {
    let operation = await syncOperations(db).findOne({ _id: id }, { session });
    if (operation && (operation.fingerprint !== fingerprint || (operation as Operation).recoveryFormat !== 1)) {
      throw new Error('recovery_admission_operation_changed');
    }
    if (operation?.status === 'complete') return { operation, intents: [] };
    if (operation?.results.length) throw new Error('recovery_admission_resume_required');
    // Reconciliation must precede admission; never call legacy abandoned settlement.
    if (await syncOperations(db).findOne({ userId: lease.userId, status: 'pending', _id: { $ne: id } }, { session })) {
      throw new Error('recovery_admission_reconciliation_required');
    }
    if (!operation) {
      const current = await collections.atomicUsers(db).findOne({ _id: lease.userId }, { session });
      if (!current) throw new Error('recovery_admission_wallet_missing');
      const now = new Date(); assertSyncWindow(mode, current, now);
      operation = await debitSyncInSession(db, lease.userId, requestId, rows, mode, fingerprint, now, session);
      const marked = await syncOperations(db).updateOne({ _id: id, status: 'pending' }, { $set: { recoveryFormat: 1 } }, { session });
      if (marked.matchedCount !== 1) throw new Error('recovery_admission_operation_changed');
      operation = { ...operation, recoveryFormat: 1 } as Operation;
    }
    const persisted = await prepareRecoveryIntentsInSession(db, lease, intents, session);
    if (afterWrites) await afterWrites(session);
    return { operation, intents: persisted };
  });
}
