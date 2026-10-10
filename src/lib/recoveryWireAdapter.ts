import { z } from 'zod';
import type { Db, ClientSession } from 'mongodb';
import type { drive_v3 } from 'googleapis';
import { collections } from '../db/collections.js';
import { noteWriteIntentSchema, type NoteWriteIntent } from '../db/recoveryContract.js';
import { remoteNoteRowSchema } from '../types/noteWire.js';
import { migrateAtomicFile } from '../types/atomicFile.js';
import { NOTE_LIMIT } from './energy.js';
import { noteContentHash } from './contentHash.js';
import { fingerprintOf, syncOperations } from './syncOperation.js';
import { generateNoteFileIdsWith } from './driveGeneration.js';
import { withRecoveryFence, type RecoveryLease } from './recoveryGate.js';
import { beginRecoverySync } from './recoveryAdmission.js';
import { resumeRecoveryOperation, type RecoveryResumeResult } from './recoveryResume.js';

const envelopeSchema = z.object({ requestId: z.string().uuid(),
  rows: z.array(remoteNoteRowSchema).min(1).max(50),
  mode: z.enum(['standard', 'instant']).default('standard'), logoutAttemptId: z.string().uuid().optional() });
const refuse = (code: string) => Object.assign(new Error(code), { status: 409 });

/** Inactive caller adapter: only fresh, live plaintext/opaque encrypted rows.
 * Authenticated owner, held lease and owner-scoped SDK/folder are supplied by a
 * trusted caller, which must separately enforce the existing raw HTTP body
 * limit before JSON parsing. This is not an HTTP route or authentication.
 * No production import, activation, new schema or economy policy is introduced.
 */
export async function runFreshRecoveryPush(db: Db, authenticatedOwner: string, lease: RecoveryLease,
  input: unknown, drive: drive_v3.Drive, parentId: string): Promise<RecoveryResumeResult> {
  if (z.string().uuid().parse(authenticatedOwner) !== lease.userId) throw refuse('recovery_owner_mismatch');
  // Bound serialized input before schema strips unknown keys; raw HTTP bytes
  // (including whitespace) require the trusted caller's existing body limiter.
  if (Buffer.byteLength(JSON.stringify(input) ?? '') > 4 * 1024 * 1024) throw Object.assign(new Error('request_too_large'), { status: 413 });
  const { requestId, rows, mode, logoutAttemptId } = envelopeSchema.parse(input);
  if (logoutAttemptId || rows.some(row => row.deleted || row.base_version !== 0)) throw refuse('recovery_fresh_only');
  if (new Set(rows.map(row => row.id)).size !== rows.length) throw refuse('duplicate_note_ids');
  // Fingerprint normalized ORIGINAL envelope, before any timestamp projection.
  const fingerprint = fingerprintOf(rows, mode), operationId = `${authenticatedOwner}:${requestId}`;
  const prior = await withRecoveryFence(db, lease, async session => {
    const operation = await syncOperations(db).findOne({ _id: operationId }, { session });
    if (operation && (operation.userId !== authenticatedOwner || operation.fingerprint !== fingerprint)) throw refuse('sync_request_mismatch');
    if (operation && (operation as typeof operation & { recoveryFormat?: number }).recoveryFormat !== 1) throw refuse('recovery_operation_unsupported');
    return operation;
  });
  // Terminal receipt is independent of current wallet/capacity/Drive availability.
  if (prior?.status === 'complete') return { status: 'complete', operation: prior };

  const checkFreshCapacity = async (session?: ClientSession) => {
    const found = await collections.notes(db).find({ _id: { $in: rows.map(row => row.id) } }, { session }).toArray();
    if (found.length) throw refuse(found.some(note => note.userId !== authenticatedOwner) ? 'note_id_conflict' : 'recovery_fresh_only');
    const wallet = await collections.atomicUsers(db).findOne({ _id: authenticatedOwner }, { session });
    const active = await collections.notes(db).countDocuments({ userId: authenticatedOwner, deleted: false }, { session });
    if (active + rows.length > (wallet?.noteLimit ?? NOTE_LIMIT.free)) throw refuse('note_limit_reached');
  };
  let intents: NoteWriteIntent[];
  if (prior) {
    // Pending admission already owns its IDs/debit. Never allocate or reprice it.
    intents = await withRecoveryFence(db, lease, async session => {
      const stored = await db.collection<NoteWriteIntent>('note_write_intents')
        .find({ operationId, userId: authenticatedOwner }, { session }).limit(51).toArray();
      if (stored.length !== rows.length) throw refuse('recovery_manifest_invalid');
      return rows.map(row => {
        const intent = noteWriteIntentSchema.parse(stored.find(candidate => candidate.noteId === row.id));
        if (intent.fingerprint !== fingerprint || intent.expectedVersion !== 0 || intent.expectedFileId !== null ||
            intent.expectedHash !== null || intent.targetFlags.deleted || intent.targetHash !== noteContentHash(row) ||
            intent.targetFlags.kind !== row.kind || intent.targetFlags.encV !== row.enc_v || intent.targetFlags.pinned !== row.pinned ||
            intent.wipeEpoch !== lease.wipeEpoch || !intent.stagedFileId) throw refuse('recovery_manifest_invalid');
        return intent;
      });
    });
  } else {
    await withRecoveryFence(db, lease, session => checkFreshCapacity(session));
    const ids = await generateNoteFileIdsWith(drive, rows.length), now = new Date();
    intents = rows.map((row, i) => noteWriteIntentSchema.parse({
      _id: `${operationId}:${row.id}`, format: 1, userId: authenticatedOwner, noteId: row.id, requestId,
      operationId, fingerprint, expectedVersion: 0, expectedFileId: null, expectedHash: null,
      stagedFileId: ids[i], targetHash: noteContentHash(row), targetFlags: { kind: row.kind, encV: row.enc_v,
        pinned: row.pinned, deleted: false }, wipeEpoch: lease.wipeEpoch, leaseToken: lease.token,
      state: 'prepared', createdAt: now, updatedAt: now, committedVersion: null, committedSequence: null, terminalReason: null,
    }));
    // Callback is inside the SAME debit+manifest transaction. A capacity change
    // during generateIds aborts admission completely; unused IDs are harmless.
    const admitted = await beginRecoverySync(db, lease, requestId, rows, mode, intents, session => checkFreshCapacity(session));
    if (admitted.operation.status === 'complete') return { status: 'complete', operation: admitted.operation };
    intents = admitted.intents;
  }
  const content = rows.map((row, i) => migrateAtomicFile({ version: 1, id: row.id, kind: row.kind,
    title: row.title, body: row.body, items: row.items, pinned: row.pinned, encV: row.enc_v, payload: row.payload,
    createdAt: new Date(row.created_at).toISOString(), updatedAt: intents[i].createdAt.toISOString() }));
  return resumeRecoveryOperation(db, lease, operationId, drive, parentId, content);
}
