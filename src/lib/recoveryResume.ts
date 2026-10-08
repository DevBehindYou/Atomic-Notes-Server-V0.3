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
  const prepared = rows.filter((row) => row.state === 'prepared');
  const needed: string[] = [];
  // Resolve content first: a missing unuploaded generation is not failure or
  // evidence that the client no longer has its text. Keep the paid receipt.
  for (const row of prepared) {
    if (content.has(row.noteId)) continue;
    try {
      content.set(row.noteId, await readNoteGenerationWith(drive, row.stagedFileId!, parentId));
    } catch (error) {
      const e = error as { code?: unknown; status?: unknown; response?: { status?: unknown } } | null;
      if (![e?.code, e?.status, e?.response?.status].some((value) => value === 404 || value === '404')) throw error;
      needed.push(row.noteId);
    }
  }
  if (needed.length) return { status: 'needs_client_content', noteIds: needed };
  for (const row of prepared) {
    await stageRecoveryIntent(db, lease, row._id, drive, parentId, content.get(row.noteId));
  }
  const ready = rows.filter((row) => row.state === 'prepared' || row.state === 'verified');
  if (ready.length) await commitRecoveryIntents(db, lease, ready.map((row) => row._id), drive, parentId);
  return { status: 'complete', operation: await finishRecoverySync(db, lease, operationId) };
}
