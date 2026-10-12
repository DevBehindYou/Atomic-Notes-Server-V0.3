import { z } from 'zod';
import type { Db, ClientSession } from 'mongodb';
import type { drive_v3 } from 'googleapis';
import { collections } from '../db/collections.js';
import { noteWriteIntentSchema, type NoteWriteIntent } from '../db/recoveryContract.js';
import { assertRecoveryCoverage } from './recoveryCoverage.js';
import { assertRecoveryPreimageInSession } from './recoveryIntent.js';
import { commitRecoveryIntents } from './recoveryCommit.js';
import { withRecoveryFence, type RecoveryLease } from './recoveryGate.js';
import { finishSyncInSession, syncOperations, type SyncOperation } from './syncOperation.js';

const intentId = z.string().length(110);
const decisionSchema = z.object({ operationId: z.string().length(73),
  successfulIntentIds: z.array(intentId).max(50), failedIntentIds: z.array(intentId).max(50) }).strict();

/** Inactive trusted-caller terminal composition. The caller explicitly decides
 * failures; this helper never classifies SDK/local/auth errors or activates a
 * route. A complete journal partition preserves frozen classified receipts.
 */
export async function settleRecoverySubset(db: Db, lease: RecoveryLease, input: unknown,
  drive: drive_v3.Drive, parentId: string,
  afterWrites?: (session: ClientSession) => Promise<void>): Promise<SyncOperation> {
  const decision = decisionSchema.parse(input);
  const success = new Set(decision.successfulIntentIds), failure = new Set(decision.failedIntentIds);
  if (success.size !== decision.successfulIntentIds.length || failure.size !== decision.failedIntentIds.length ||
      success.size + failure.size > 50 || [...success].some(id => failure.has(id))) {
    throw new Error('recovery_subset_partition_invalid');
  }
  const journal = db.collection<NoteWriteIntent>('note_write_intents');
  const load = async (session: ClientSession) => {
    const operation = await syncOperations(db).findOne({ _id: decision.operationId, userId: lease.userId }, { session });
    if (!operation || (operation as SyncOperation & { recoveryFormat?: number }).recoveryFormat !== 1) {
      throw new Error('recovery_subset_operation_invalid');
    }
    const found = (await journal.find({ operationId: operation._id, userId: lease.userId }, { session })
      .limit(51).toArray()).map(row => noteWriteIntentSchema.parse(row));
    assertRecoveryCoverage(operation, found, operation.status === 'complete');
    if (found.length !== success.size + failure.size ||
        found.some(row => !success.has(row._id) && !failure.has(row._id))) {
      throw new Error('recovery_subset_partition_invalid');
    }
    const rows = operation.rowIds.flatMap(id => found.filter(row => row.noteId === id));
    for (const row of rows) {
      if (row.wipeEpoch !== lease.wipeEpoch || row.fingerprint !== operation.fingerprint) {
        throw new Error('recovery_subset_manifest_invalid');
      }
      if (operation.status === 'complete') {
        if (success.has(row._id) ? row.state !== 'committed' : !['abandoned', 'superseded'].includes(row.state)) {
          throw new Error('recovery_subset_outcome_mismatch');
        }
      } else {
        if (success.has(row._id) ? !['verified', 'committed'].includes(row.state) : !['prepared', 'verified'].includes(row.state)) {
          throw new Error('recovery_subset_intent_not_ready');
        }
        if (row.state !== 'committed') {
          if (row.leaseToken !== lease.token) throw new Error('recovery_subset_lease_mismatch');
          await assertRecoveryPreimageInSession(db, row, session);
        }
      }
    }
    const preimages = [];
    for (const row of rows) preimages.push(await collections.notes(db).findOne({ _id: row.noteId }, { session }));
    if (operation.status === 'pending') {
      const failedActiveDelete = rows.some((row, i) => failure.has(row._id) && row.targetFlags.deleted && preimages[i]?.deleted === false);
      // Admission reservations must not be rechecked against today's wallet.
      // Deletion-funded additions are deferred. A previously committed live
      // row may have been a restore; its old deleted flag is not journaled.
      const successfulAddition = rows.some((row, i) => success.has(row._id) && !row.targetFlags.deleted &&
        (row.state === 'committed' || !preimages[i] || preimages[i]!.deleted));
      if (failedActiveDelete && successfulAddition) throw new Error('recovery_subset_dependency_unsupported');
    }
    return { operation, rows, preimages };
  };
  const frozen = await withRecoveryFence(db, lease, load);
  if (frozen.operation.status === 'complete') return frozen.operation;
  const newSuccess = frozen.rows.filter(row => success.has(row._id) && row.state === 'verified');
  const checkFrozen = async (session: ClientSession) => {
    if (JSON.stringify(await load(session)) !== JSON.stringify(frozen)) throw new Error('recovery_subset_snapshot_changed');
  };
  const close = async (session: ClientSession) => {
    const now = new Date(), failures = frozen.rows.filter(row => failure.has(row._id));
    for (const row of failures) {
      const raw = await journal.findOne({ _id: row._id, userId: lease.userId }, { session });
      if (!raw || JSON.stringify(noteWriteIntentSchema.parse(raw)) !== JSON.stringify(row)) {
        throw new Error('recovery_subset_manifest_changed');
      }
      const terminal = noteWriteIntentSchema.parse({ ...row, state: 'abandoned', terminalReason: 'write_interrupted', updatedAt: now });
      const changed = await journal.replaceOne({ _id: row._id, state: row.state, leaseToken: lease.token,
        wipeEpoch: lease.wipeEpoch }, terminal, { session });
      if (changed.matchedCount !== 1) throw new Error('recovery_subset_intent_changed');
    }
    if (failures.length) {
      const changed = await syncOperations(db).updateOne({ _id: frozen.operation._id, status: 'pending',
        fingerprint: frozen.operation.fingerprint }, { $push: { results: { $each: failures.map(row => ({
          id: row.noteId, ok: false as const, error: 'note_write_failed' })) } } }, { session });
      if (changed.matchedCount !== 1) throw new Error('recovery_subset_operation_changed');
    }
    const settled = await finishSyncInSession(db, frozen.operation, session);
    const finalRows = (await journal.find({ operationId: settled._id, userId: lease.userId }, { session })
      .limit(51).toArray()).map(row => noteWriteIntentSchema.parse(row));
    assertRecoveryCoverage(settled, finalRows, true);
    if (afterWrites) await afterWrites(session);
    return settled;
  };
  if (!newSuccess.length) return withRecoveryFence(db, lease, async session => { await checkFrozen(session); return close(session); });
  let settled: SyncOperation | undefined;
  await commitRecoveryIntents(db, lease, newSuccess.map(row => row._id), drive, parentId,
    async session => { settled = await close(session); }, checkFrozen);
  if (!settled) throw new Error('recovery_subset_settlement_missing');
  return settled;
}
