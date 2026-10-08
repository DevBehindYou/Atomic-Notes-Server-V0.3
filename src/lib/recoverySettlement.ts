import { z } from 'zod';
import type { Db, ClientSession } from 'mongodb';
import { noteWriteIntentSchema, type NoteWriteIntent } from '../db/recoveryContract.js';
import { finishSyncInSession, syncOperations, type SyncOperation } from './syncOperation.js';
import { withRecoveryFence, type RecoveryLease } from './recoveryGate.js';

/** Inactive terminal settlement. No production route imports this module. */
type Operation = SyncOperation & { recoveryFormat: 1 };
const journal = (db: Db) => db.collection<NoteWriteIntent>('note_write_intents');

export async function finishRecoverySync(db: Db, lease: RecoveryLease, input: unknown,
  afterWrites?: (session: ClientSession) => Promise<void>): Promise<SyncOperation> {
  return settleRecoverySync(db, lease, input, false, afterWrites);
}

/** Explicitly abandon unfinished work under the current same-epoch fence.
 * Caller chooses to stop recovery; this does not classify errors or delete files.
 * Stored committed successes and the existing refund policy remain authoritative.
 */
export async function abandonRecoverySync(db: Db, lease: RecoveryLease, input: unknown,
  afterWrites?: (session: ClientSession) => Promise<void>): Promise<SyncOperation> {
  return settleRecoverySync(db, lease, input, true, afterWrites);
}

async function settleRecoverySync(db: Db, lease: RecoveryLease, input: unknown, abandonUnfinished: boolean,
  afterWrites?: (session: ClientSession) => Promise<void>): Promise<SyncOperation> {
  const operationId = z.string().length(73).parse(input);
  return withRecoveryFence(db, lease, async (session) => {
    const operation = await db.collection<Operation>('sync_operations').findOne({ _id: operationId, userId: lease.userId }, { session });
    if (!operation || operation.recoveryFormat !== 1 || operation.rowIds.length < 1 || operation.rowIds.length > 50 ||
        new Set(operation.rowIds).size !== operation.rowIds.length || operation.results.some((r) => !operation.rowIds.includes(r.id))) {
      throw new Error('recovery_settlement_operation_invalid');
    }
    const rows = (await journal(db).find({ operationId, userId: lease.userId }, { session }).limit(51).toArray()).map((row) => noteWriteIntentSchema.parse(row));
    if (rows.length > operation.rowIds.length || new Set(rows.map((row) => row.noteId)).size !== rows.length) {
      throw new Error('recovery_settlement_manifest_invalid');
    }
    // A non-unchanged success must have an atomically committed journal row.
    // Failure/conflict rows and existing unchanged-content successes need no create intent.
    for (const result of operation.results) {
      if (result.ok && !result.unchanged && !rows.some((row) => row.noteId === result.id)) {
        throw new Error('recovery_settlement_commit_mismatch');
      }
    }
    for (const row of rows) {
      if (!operation.rowIds.includes(row.noteId) || row.fingerprint !== operation.fingerprint || row.wipeEpoch !== lease.wipeEpoch) {
        throw new Error('recovery_settlement_manifest_invalid');
      }
      const successes = operation.results.filter((result) => result.id === row.noteId && result.ok);
      if (row.state === 'committed') {
        if (successes.length !== 1 || successes[0].version !== row.committedVersion || successes[0].seq !== row.committedSequence) {
          throw new Error('recovery_settlement_commit_mismatch');
        }
      } else if (successes.length || (operation.status === 'complete' && ['prepared', 'verified'].includes(row.state))) {
        throw new Error('recovery_settlement_commit_mismatch');
      }
      if (!abandonUnfinished && ['prepared', 'verified'].includes(row.state) && row.leaseToken !== lease.token) throw new Error('recovery_settlement_lease_mismatch');
    }
    const settled = await finishSyncInSession(db, operation, session);
    for (const row of rows) {
      if (!['prepared', 'verified'].includes(row.state)) continue;
      const next = noteWriteIntentSchema.parse({ ...row, leaseToken: lease.token, state: 'abandoned', terminalReason: 'write_interrupted', updatedAt: new Date() });
      const changed = await journal(db).replaceOne({ _id: row._id, state: row.state, leaseToken: row.leaseToken, wipeEpoch: lease.wipeEpoch }, next, { session });
      if (changed.matchedCount !== 1) throw new Error('recovery_settlement_intent_changed');
    }
    if (afterWrites) await afterWrites(session);
    return settled;
  });
}
