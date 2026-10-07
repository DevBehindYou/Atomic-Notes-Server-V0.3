import type { Db, ClientSession } from 'mongodb';
import type { drive_v3 } from 'googleapis';
import { noteWriteIntentSchema, parseRecoveryIntents, type NoteWriteIntent } from '../db/recoveryContract.js';
import { collections } from '../db/collections.js';
import { migrateAtomicFile } from '../types/atomicFile.js';
import type { SyncOperation } from './syncOperation.js';
import { noteContentHash } from './contentHash.js';
import { createNoteGenerationWith } from './driveGeneration.js';
import { withRecoveryFence, type RecoveryLease } from './recoveryGate.js';

/** Inactive journal preparation/staging only. No production caller imports it. */
type RecoveryOperation = SyncOperation & { recoveryFormat: 1 };
const intents = (db: Db) => db.collection<NoteWriteIntent>('note_write_intents');

async function pendingOperation(db: Db, row: NoteWriteIntent, session: ClientSession) {
  const operation = await db.collection<RecoveryOperation>('sync_operations').findOne({ _id: row.operationId }, { session });
  if (!operation || operation.userId !== row.userId || operation.recoveryFormat !== 1 || operation.status !== 'pending' ||
      operation.fingerprint !== row.fingerprint || !operation.rowIds.includes(row.noteId)) throw new Error('recovery_operation_invalid');
  if (operation.results.some((result) => result.id === row.noteId)) throw new Error('recovery_row_already_settled');
  return operation;
}

async function preimage(db: Db, row: NoteWriteIntent, session: ClientSession) {
  const note = await collections.notes(db).findOne({ _id: row.noteId }, { session });
  if (row.expectedVersion === 0) {
    if (note) throw new Error('recovery_preimage_changed');
  } else if (!note || note.userId !== row.userId || note.localVersion !== row.expectedVersion ||
      note.driveFileId !== row.expectedFileId || (note.contentHash ?? null) !== row.expectedHash) {
    throw new Error('recovery_preimage_changed');
  }
}

function manifest(row: NoteWriteIntent) {
  const { leaseToken: _lease, updatedAt: _updated, state: _state,
    committedVersion: _version, committedSequence: _sequence, terminalReason: _reason, ...identity } = row;
  return JSON.stringify(identity);
}

/** Caller must already have a pending recovery-format operation. This does not
 * couple debit + intent preparation yet; it is not an activated sync path.
 */
export async function prepareRecoveryIntents(db: Db, lease: RecoveryLease, input: unknown): Promise<NoteWriteIntent[]> {
  return withRecoveryFence(db, lease, (session) => prepareRecoveryIntentsInSession(db, lease, input, session));
}

/** Same preparation checks in the admission caller's fenced transaction. */
export async function prepareRecoveryIntentsInSession(db: Db, lease: RecoveryLease, input: unknown,
  session: ClientSession): Promise<NoteWriteIntent[]> {
  const rows = parseRecoveryIntents(input);
  if (rows.some((row) => row.userId !== lease.userId || row.wipeEpoch !== lease.wipeEpoch ||
      row.leaseToken !== lease.token || row.state !== 'prepared')) throw new Error('recovery_prepare_identity_invalid');
  const operation = await pendingOperation(db, rows[0], session);
  if (JSON.stringify(operation.rowIds) !== JSON.stringify(rows.map((row) => row.noteId))) throw new Error('recovery_operation_rows_mismatch');
  const result: NoteWriteIntent[] = [];
  for (const row of rows) {
    if (operation.results.some((stored) => stored.id === row.noteId)) throw new Error('recovery_row_already_settled');
    await preimage(db, row, session);
    const raw = await intents(db).findOne({ _id: row._id }, { session });
    if (!raw) { await intents(db).insertOne(row, { session }); result.push(row); continue; }
    const current = noteWriteIntentSchema.parse(raw);
    if (!['prepared', 'verified'].includes(current.state) || manifest(current) !== manifest(row)) {
      throw new Error('recovery_intent_mismatch');
    }
    // A new lease may adopt only the identical persisted generation manifest.
    const adopted = noteWriteIntentSchema.parse({ ...current, leaseToken: lease.token, updatedAt: row.updatedAt });
    const changed = await intents(db).replaceOne({ _id: row._id, state: current.state, leaseToken: current.leaseToken }, adopted, { session });
    if (changed.matchedCount !== 1) throw new Error('recovery_intent_changed');
    result.push(adopted);
  }
  return result;
}

/** Persisted ID is mandatory before any external create. An obsolete lease can
 * leave an uncommitted generation, but cannot verify it or change the old pointer.
 */
export async function stageRecoveryIntent(db: Db, lease: RecoveryLease, intentId: string,
  drive: drive_v3.Drive, parentId: string, input: unknown): Promise<NoteWriteIntent> {
  const row = await withRecoveryFence(db, lease, async (session) => {
    const raw = await intents(db).findOne({ _id: intentId, userId: lease.userId }, { session });
    if (!raw) throw new Error('recovery_intent_missing');
    const current = noteWriteIntentSchema.parse(raw);
    if (!['prepared', 'verified'].includes(current.state) || current.leaseToken !== lease.token ||
        current.wipeEpoch !== lease.wipeEpoch || !current.stagedFileId) throw new Error('recovery_intent_not_stageable');
    await pendingOperation(db, current, session); await preimage(db, current, session);
    return current;
  });
  const content = migrateAtomicFile(input);
  if (content.id !== row.noteId || content.kind !== row.targetFlags.kind || content.pinned !== row.targetFlags.pinned ||
      content.encV !== row.targetFlags.encV || noteContentHash({ ...content, enc_v: content.encV }) !== row.targetHash) {
    throw new Error('recovery_staged_content_mismatch');
  }
  await createNoteGenerationWith(drive, row.stagedFileId!, parentId, content);
  return withRecoveryFence(db, lease, async (session) => {
    const raw = await intents(db).findOne({ _id: row._id, userId: lease.userId }, { session });
    if (!raw) throw new Error('recovery_intent_missing');
    const current = noteWriteIntentSchema.parse(raw);
    if (!['prepared', 'verified'].includes(current.state) || current.leaseToken !== lease.token ||
        current.wipeEpoch !== lease.wipeEpoch || manifest(current) !== manifest(row)) throw new Error('recovery_intent_mismatch');
    await pendingOperation(db, current, session); await preimage(db, current, session);
    const verified = noteWriteIntentSchema.parse({ ...current, state: 'verified', updatedAt: new Date() });
    const changed = await intents(db).replaceOne({ _id: row._id, state: current.state, leaseToken: lease.token }, verified, { session });
    if (changed.matchedCount !== 1) throw new Error('recovery_intent_changed');
    return verified;
  });
}
