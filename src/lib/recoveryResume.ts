import { z } from 'zod';
import type { Db } from 'mongodb';
import type { drive_v3 } from 'googleapis';
import { migrateAtomicFile, type AtomicFileV1 } from '../types/atomicFile.js';
import { readNoteGenerationWith } from './driveGeneration.js';
import { withRecoveryFence, type RecoveryLease } from './recoveryGate.js';
import { adoptRecoveryOperation } from './recoveryAdoption.js';
import { stageRecoveryIntent } from './recoveryIntent.js';
import { commitRecoveryIntents } from './recoveryCommit.js';
import { finishRecoverySync } from './recoverySettlement.js';
import type { SyncOperation } from './syncOperation.js';
import { mapConcurrent } from './concurrency.js';

export type RecoveryResumeResult =
  | { status: 'needs_client_content'; noteIds: string[] }
  | { status: 'complete'; operation: SyncOperation };

/** Inactive composition of existing recovery safeguards. No production imports.
 * Caller authenticates the request/fingerprint and holds the current lease.
 * Never debits, allocates replacement IDs, deletes files or guesses a refund.
 * Unknown external errors leave the existing paid operation pending.
 */
export async function resumeRecoveryOperation(db: Db, lease: RecoveryLease,
  input: unknown, drive: drive_v3.Drive, parentId: string,
  clientContent: unknown = []): Promise<RecoveryResumeResult> {
  const operationId = z.string().length(73).parse(input);
  const supplied = z.array(z.unknown()).max(50).parse(clientContent).map(migrateAtomicFile);
  const content = new Map<string, AtomicFileV1>();
  for (const file of supplied) {
    if (content.has(file.id)) throw new Error('recovery_resume_duplicate_content');
    content.set(file.id, file);
  }
  const operation = await withRecoveryFence(db, lease, async (session) => {
    const stored = await db.collection<SyncOperation & { recoveryFormat: 1 }>('sync_operations')
      .findOne({ _id: operationId, userId: lease.userId }, { session });
    if (!stored || stored.recoveryFormat !== 1 ||
        supplied.some((file) => !stored.rowIds.includes(file.id))) {
      throw new Error('recovery_resume_operation_invalid');
    }
    return stored;
  });
  if (operation.status === 'complete') {
    return { status: 'complete', operation: await finishRecoverySync(db, lease, operationId) };
  }
  const rows = await adoptRecoveryOperation(db, lease, operationId);
  const ready = rows.filter((row) => row.state === 'prepared' || row.state === 'verified');
  const staging = rows.filter((row) => row.state === 'prepared');
  const needed: string[] = [];
  // Resolve every unfinished generation before staging. A verified generation
  // may disappear too; only an observed 404 permits same-ID restaging. Present
  // verified content stays create-free and is checked again by final commit.
  for (const row of ready) {
    if (row.state === 'prepared' && content.has(row.noteId)) continue;
    try {
      const saved = await readNoteGenerationWith(drive, row.stagedFileId!, parentId);
      if (row.state === 'prepared') content.set(row.noteId, saved);
    } catch (error) {
      const e = error as { code?: unknown; status?: unknown; response?: { status?: unknown } } | null;
      if (![e?.code, e?.status, e?.response?.status].some((value) => value === 404 || value === '404')) throw error;
      if (!content.has(row.noteId)) needed.push(row.noteId);
      else if (row.state === 'verified') staging.push(row);
    }
  }
  if (needed.length) return { status: 'needs_client_content', noteIds: needed };
  // Each intent owns separate fenced transactions; the shared metadata commit
  // below stays sequential. Drain all started stages before any error escapes,
  // so a failed request never leaves orphan asynchronous staging work.
  await mapConcurrent(staging, 8, (row) =>
    stageRecoveryIntent(db, lease, row._id, drive, parentId, content.get(row.noteId)));
  if (ready.length) await commitRecoveryIntents(db, lease, ready.map((row) => row._id), drive, parentId);
  return { status: 'complete', operation: await finishRecoverySync(db, lease, operationId) };
}
