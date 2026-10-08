import { z } from 'zod';
import type { Db, ClientSession } from 'mongodb';
import { noteWriteIntentSchema, type NoteWriteIntent } from '../db/recoveryContract.js';
import { assertRecoveryPreimageInSession } from './recoveryIntent.js';
import { withRecoveryFence, type RecoveryLease } from './recoveryGate.js';
import type { SyncOperation } from './syncOperation.js';

/** Inactive same-epoch live-row recovery. Never recreates an operation or file. */
export async function adoptRecoveryOperation(db: Db, lease: RecoveryLease, input: unknown,
  afterWrites?: (session: ClientSession) => Promise<void>): Promise<NoteWriteIntent[]> {
  const operationId = z.string().length(73).parse(input);
  return withRecoveryFence(db, lease, async (session) => {
    const operation = await db.collection<SyncOperation & { recoveryFormat: 1 }>('sync_operations')
      .findOne({ _id: operationId, userId: lease.userId }, { session });
    if (!operation || operation.status !== 'pending' || operation.recoveryFormat !== 1 ||
        operation.rowIds.length < 1 || operation.rowIds.length > 50 || new Set(operation.rowIds).size !== operation.rowIds.length ||
        new Set(operation.results.map((result) => result.id)).size !== operation.results.length ||
        operation.results.some((result) => !operation.rowIds.includes(result.id))) throw new Error('recovery_adoption_operation_invalid');
    const journal = db.collection<NoteWriteIntent>('note_write_intents');
    const found = (await journal.find({ operationId, userId: lease.userId }, { session }).limit(51).toArray())
      .map((row) => noteWriteIntentSchema.parse(row));
    if (found.length !== operation.rowIds.length || new Set(found.map((row) => row.noteId)).size !== found.length) {
      throw new Error('recovery_adoption_manifest_invalid');
    }
    const rows: NoteWriteIntent[] = [];
    for (const id of operation.rowIds) {
      const row = found.find((candidate) => candidate.noteId === id);
      if (!row || row.fingerprint !== operation.fingerprint || row.wipeEpoch !== lease.wipeEpoch) {
        throw new Error('recovery_adoption_manifest_invalid');
      }
      const result = operation.results.find((candidate) => candidate.id === id);
      if (row.state === 'committed') {
        if (!result?.ok || result.version !== row.committedVersion || result.seq !== row.committedSequence) {
          throw new Error('recovery_adoption_commit_mismatch');
        }
        rows.push(row); continue;
      }
      if (result?.ok) throw new Error('recovery_adoption_commit_mismatch');
      if (row.state === 'abandoned' || row.state === 'superseded') { rows.push(row); continue; }
      if (result || row.targetFlags.deleted || !row.stagedFileId) throw new Error('recovery_adoption_unfinished_invalid');
      await assertRecoveryPreimageInSession(db, row, session);
      const adopted = noteWriteIntentSchema.parse({ ...row, leaseToken: lease.token, updatedAt: new Date() });
      const changed = await journal.replaceOne({ _id: row._id, state: row.state, leaseToken: row.leaseToken,
        wipeEpoch: lease.wipeEpoch }, adopted, { session });
      if (changed.matchedCount !== 1) throw new Error('recovery_adoption_intent_changed');
      rows.push(adopted);
    }
    if (afterWrites) await afterWrites(session);
    return rows;
  });
}
