import { z } from 'zod';
import type { Db, ClientSession } from 'mongodb';
import type { drive_v3 } from 'googleapis';
import { collections, type NoteDoc } from '../db/collections.js';
import { parseRecoveryIntents, noteWriteIntentSchema, type NoteWriteIntent } from '../db/recoveryContract.js';
import { readNoteGenerationWith } from './driveGeneration.js';
import { noteContentHash } from './contentHash.js';
import { saveNoteMetadataBatchInSession, type NoteMetadataEntry } from './noteMetadata.js';
import { withRecoveryFence, type RecoveryLease } from './recoveryGate.js';
import type { SyncOperation } from './syncOperation.js';

/** Inactive candidate commit. No production route imports this module. */
type Operation = SyncOperation & { recoveryFormat: 1 };
const journal = (db: Db) => db.collection<NoteWriteIntent>('note_write_intents');

async function checkedRows(db: Db, lease: RecoveryLease, ids: string[], session: ClientSession) {
  const found = await journal(db).find({ _id: { $in: ids }, userId: lease.userId }, { session }).toArray();
  if (found.length !== ids.length) throw new Error('recovery_commit_intents_missing');
  const rows = parseRecoveryIntents(ids.map((id) => found.find((row) => row._id === id)));
  if (rows.some((row) => row.state !== 'verified' || !row.stagedFileId || row.leaseToken !== lease.token ||
      row.wipeEpoch !== lease.wipeEpoch)) throw new Error('recovery_commit_intent_invalid');
  const operation = await db.collection<Operation>('sync_operations').findOne({ _id: rows[0].operationId }, { session });
  if (!operation || operation.status !== 'pending' || operation.recoveryFormat !== 1 || operation.userId !== lease.userId ||
      operation.fingerprint !== rows[0].fingerprint) throw new Error('recovery_commit_operation_invalid');
  const selected = new Set(rows.map((row) => row.noteId));
  if (JSON.stringify(operation.rowIds.filter((id) => selected.has(id))) !== JSON.stringify(rows.map((row) => row.noteId)) ||
      operation.results.some((result) => selected.has(result.id))) throw new Error('recovery_commit_rows_invalid');
  return rows;
}

/** The optional barrier belongs to the injected test-only candidate path. */
export async function commitRecoveryIntents(db: Db, lease: RecoveryLease, input: unknown,
  drive: drive_v3.Drive, parentId: string,
  afterWrites?: (session: ClientSession) => Promise<void>): Promise<Map<string, NoteDoc>> {
  const ids = z.array(z.string().length(110)).min(1).max(50).parse(input);
  if (new Set(ids).size !== ids.length) throw new Error('recovery_commit_duplicate_intent');
  const observed = await withRecoveryFence(db, lease, (session) => checkedRows(db, lease, ids, session));
  // External reads happen outside Mongo's transaction; immutable app writes do
  // not mutate these files. External Drive edits remain a containment boundary.
  const contents = new Map<string, Awaited<ReturnType<typeof readNoteGenerationWith>>>();
  for (const row of observed) {
    const content = await readNoteGenerationWith(drive, row.stagedFileId!, parentId);
    if (content.id !== row.noteId || content.kind !== row.targetFlags.kind || content.encV !== row.targetFlags.encV ||
        content.pinned !== row.targetFlags.pinned || noteContentHash({ ...content, enc_v: content.encV }) !== row.targetHash) {
      throw new Error('recovery_commit_content_mismatch');
    }
    contents.set(row.noteId, content);
  }
  return withRecoveryFence(db, lease, async (session) => {
    const rows = await checkedRows(db, lease, ids, session);
    if (JSON.stringify(rows) !== JSON.stringify(observed)) throw new Error('recovery_commit_manifest_changed');
    const entries: NoteMetadataEntry[] = [];
    const now = new Date();
    for (const row of rows) {
      const existing = await collections.notes(db).findOne({ _id: row.noteId }, { session });
      if (row.expectedVersion === 0 ? !!existing : !existing || existing.userId !== lease.userId ||
          existing.localVersion !== row.expectedVersion || existing.driveFileId !== row.expectedFileId ||
          (existing.contentHash ?? null) !== row.expectedHash) throw new Error('recovery_commit_preimage_changed');
      const fields: Partial<NoteDoc> = { ...row.targetFlags, driveFileId: row.stagedFileId!, driveRevisionId: null,
        contentHash: row.targetHash, generationFormat: 1, syncStatus: 'synced', updatedAt: now, lastSyncedAt: now };
      if (existing) entries.push({ id: row.noteId, fields, existing });
      else entries.push({ id: row.noteId, fields, fresh: { _id: row.noteId, userId: lease.userId, folderId: null,
        kind: row.targetFlags.kind, pinned: row.targetFlags.pinned, deleted: row.targetFlags.deleted, encV: row.targetFlags.encV,
        driveFileId: row.stagedFileId!, driveRevisionId: null, localVersion: 1, contentHash: row.targetHash,
        syncStatus: 'synced', createdAt: new Date(contents.get(row.noteId)!.createdAt), updatedAt: now, lastSyncedAt: now } });
    }
    const committed = await saveNoteMetadataBatchInSession(db, lease.userId, entries, rows[0].operationId, session);
    if (committed.notFound.length || committed.saved.size !== rows.length) throw new Error('recovery_commit_note_missing');
    for (const row of rows) {
      const note = committed.saved.get(row.noteId)!;
      const next = noteWriteIntentSchema.parse({ ...row, state: 'committed', updatedAt: now,
        committedVersion: note.localVersion, committedSequence: note.syncSequence });
      const changed = await journal(db).replaceOne({ _id: row._id, state: 'verified', leaseToken: lease.token, wipeEpoch: lease.wipeEpoch }, next, { session });
      if (changed.matchedCount !== 1) throw new Error('recovery_commit_intent_changed');
    }
    if (afterWrites) await afterWrites(session);
    return committed.saved;
  });
}
