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
import { assertRecoveryCoverage, classifiedResultSchema } from './recoveryCoverage.js';
import { resumeRecoveryOperation, type RecoveryResumeResult } from './recoveryResume.js';

const envelopeSchema = z.object({ requestId: z.string().uuid(), rows: z.array(remoteNoteRowSchema).min(1).max(50),
  mode: z.enum(['standard', 'instant']).default('standard'), logoutAttemptId: z.string().uuid().optional() });
const refuse = (code: string) => Object.assign(new Error(code), { status: 409 });

/** Inactive initial-classification caller. Trusted caller authenticates owner,
 * supplies its held lease/SDK/folder and retains the raw HTTP body limiter.
 * No production imports, logout funding, schema or policy changes. Later
 * preimage drift stays refused/pending; it is never silently rebased/conflicted.
 */
export async function runClassifiedRecoveryPush(db: Db, authenticatedOwner: string, lease: RecoveryLease,
  input: unknown, drive: drive_v3.Drive, parentId: string): Promise<RecoveryResumeResult> {
  if (z.string().uuid().parse(authenticatedOwner) !== lease.userId) throw refuse('recovery_owner_mismatch');
  // Serialized-object bound only; trusted HTTP caller checks raw bytes separately.
  if (Buffer.byteLength(JSON.stringify(input) ?? '') > 4 * 1024 * 1024) throw Object.assign(new Error('request_too_large'), { status: 413 });
  const { requestId, rows, mode, logoutAttemptId } = envelopeSchema.parse(input);
  if (logoutAttemptId) throw refuse('recovery_logout_unsupported');
  if (new Set(rows.map(row => row.id)).size !== rows.length) throw refuse('duplicate_note_ids');
  const fingerprint = fingerprintOf(rows, mode), operationId = `${authenticatedOwner}:${requestId}`;
  const prior = await withRecoveryFence(db, lease, async session => {
    const operation = await syncOperations(db).findOne({ _id: operationId }, { session });
    if (operation && (operation.userId !== authenticatedOwner || operation.fingerprint !== fingerprint)) throw refuse('sync_request_mismatch');
    if (operation && (operation as typeof operation & { recoveryFormat?: number }).recoveryFormat !== 1) throw refuse('recovery_operation_unsupported');
    return operation;
  });
  if (prior?.status === 'complete') return { status: 'complete', operation: prior };

  const classify = async (session: ClientSession) => {
    const found = await collections.notes(db).find({ _id: { $in: rows.map(row => row.id) } }, { session }).toArray();
    if (found.some(note => note.userId !== authenticatedOwner)) throw refuse('note_id_conflict');
    const preimages = rows.map(row => found.find(note => note._id === row.id) ?? null);
    if (rows.some((row, i) => !preimages[i] && (row.deleted || row.base_version !== 0))) throw refuse('recovery_missing_note_unsupported');
    // Preserve production optimistic capacity ordering over ALL original rows:
    // stale restores count as adds; only exact-base active deletes free room.
    const adds = rows.filter((row, i) => !row.deleted && (!preimages[i] || preimages[i]!.deleted)).length;
    const frees = rows.filter((row, i) => row.deleted && preimages[i] && !preimages[i]!.deleted &&
      row.base_version === preimages[i]!.localVersion).length;
    if (adds) {
      const wallet = await collections.atomicUsers(db).findOne({ _id: authenticatedOwner }, { session });
      const active = await collections.notes(db).countDocuments({ userId: authenticatedOwner, deleted: false }, { session });
      if (active + adds - frees > (wallet?.noteLimit ?? NOTE_LIMIT.free)) throw refuse('note_limit_reached');
    }
    const results = rows.flatMap((row, i) => {
      const existing = preimages[i];
      // Version precedes hash equality, including identical stale payloads.
      if (existing && row.base_version !== existing.localVersion) return [classifiedResultSchema.parse({
        id: row.id, ok: false, error: 'note_conflict', version: existing.localVersion })];
      if (existing && existing.contentHash === noteContentHash(row) && existing.deleted === row.deleted) return [classifiedResultSchema.parse({
        id: row.id, ok: true, unchanged: true, version: existing.localVersion, updated_at: existing.updatedAt.toISOString() })];
      return [];
    });
    return { preimages, results };
  };
  let intents: NoteWriteIntent[];
  if (prior) {
    // Frozen classifications and saved manifests precede allocation/pricing.
    intents = await withRecoveryFence(db, lease, async session => {
      const stored = (await db.collection<NoteWriteIntent>('note_write_intents')
        .find({ operationId, userId: authenticatedOwner }, { session }).limit(51).toArray()).map(row => noteWriteIntentSchema.parse(row));
      assertRecoveryCoverage(prior, stored);
      const ordered = rows.flatMap(row => {
        const intent = stored.find(candidate => candidate.noteId === row.id);
        if (!intent) return [];
        if (intent.expectedVersion !== row.base_version || intent.wipeEpoch !== lease.wipeEpoch || !intent.stagedFileId ||
            intent.targetHash !== noteContentHash(row) || intent.targetFlags.kind !== row.kind || intent.targetFlags.encV !== row.enc_v ||
            intent.targetFlags.pinned !== row.pinned || intent.targetFlags.deleted !== row.deleted) throw refuse('recovery_manifest_invalid');
        return [intent];
      });
      return ordered;
    });
  } else {
    const frozen = await withRecoveryFence(db, lease, classify);
    const writes = rows.filter(row => !frozen.results.some(result => result.id === row.id));
    const ids = writes.length ? await generateNoteFileIdsWith(drive, writes.length) : [], now = new Date();
    intents = writes.map((row, i) => {
      const existing = frozen.preimages[rows.findIndex(candidate => candidate.id === row.id)];
      return noteWriteIntentSchema.parse({ _id: `${operationId}:${row.id}`, format: 1, userId: authenticatedOwner,
        noteId: row.id, requestId, operationId, fingerprint, expectedVersion: row.base_version,
        expectedFileId: existing?.driveFileId ?? null, expectedHash: existing?.contentHash ?? null,
        stagedFileId: ids[i], targetHash: noteContentHash(row), targetFlags: { kind: row.kind, encV: row.enc_v,
          pinned: row.pinned, deleted: row.deleted }, wipeEpoch: lease.wipeEpoch, leaseToken: lease.token,
        state: 'prepared', createdAt: now, updatedAt: now, committedVersion: null, committedSequence: null, terminalReason: null });
    });
    const admitted = await beginRecoverySync(db, lease, requestId, rows, mode, intents, async session => {
      const current = await classify(session);
      if (JSON.stringify(current) !== JSON.stringify(frozen)) throw new Error('recovery_classification_changed');
    }, frozen.results);
    if (admitted.operation.status === 'complete') return { status: 'complete', operation: admitted.operation };
    intents = admitted.intents;
  }
  const content = intents.map(intent => {
    const row = rows.find(candidate => candidate.id === intent.noteId)!;
    return migrateAtomicFile({ version: 1, id: row.id, kind: row.kind, title: row.title, body: row.body,
      items: row.items, pinned: row.pinned, encV: row.enc_v, payload: row.payload,
      createdAt: new Date(row.created_at).toISOString(), updatedAt: intent.createdAt.toISOString() });
  });
  // One coupled group: no addition commits using an unverified deletion credit.
  return resumeRecoveryOperation(db, lease, operationId, drive, parentId, content);
}
