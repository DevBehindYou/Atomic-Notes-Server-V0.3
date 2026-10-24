import { legacyDateTimeSchema } from './legacyDateTime.js';
import { z } from 'zod';
import type { NoteWriteIntent } from '../db/recoveryContract.js';
import type { SyncOperation } from './syncOperation.js';

const version = z.number().refine(Number.isInteger).positive().max(Number.MAX_SAFE_INTEGER);
export const classifiedResultSchema = z.union([
  z.object({ id: z.guid(), ok: z.literal(false), error: z.literal('note_conflict'), version }).strict(),
  z.object({ id: z.guid(), ok: z.literal(true), unchanged: z.literal(true), version,
    updated_at: legacyDateTimeSchema() }).strict(),
]);

/** A result-only row must be an immutable admission classification, never an
 * unexplained missing generation. Only terminal settlement enables compatibility
 * for its existing completed abandoned-intent/failure pairs.
 */
export function assertRecoveryCoverage(operation: SyncOperation, intents: NoteWriteIntent[], allowTerminalFailures = false) {
  const ids = operation.rowIds;
  if (ids.length < 1 || ids.length > 50 || new Set(ids).size !== ids.length ||
      (operation.status === 'complete' && operation.results.length !== ids.length) ||
      new Set(intents.map(row => row.noteId)).size !== intents.length ||
      new Set(operation.results.map(row => row.id)).size !== operation.results.length ||
      intents.some(row => !ids.includes(row.noteId) || row.operationId !== operation._id || row.userId !== operation.userId ||
        row.fingerprint !== operation.fingerprint) || operation.results.some(row => !ids.includes(row.id))) {
    throw new Error('recovery_coverage_invalid');
  }
  // Journal order may be arbitrary in Mongo; callers process request order.
  for (const id of ids) {
    const intent = intents.find(row => row.noteId === id), result = operation.results.find(row => row.id === id);
    if (!intent) {
      if (!classifiedResultSchema.safeParse(result).success) throw new Error('recovery_coverage_missing');
    } else if (intent.state === 'committed') {
      if (!result?.ok || result.unchanged || result.version !== intent.committedVersion || result.seq !== intent.committedSequence) {
        throw new Error('recovery_coverage_commit_mismatch');
      }
    } else if (result && !(allowTerminalFailures && operation.status === 'complete' &&
        ['abandoned', 'superseded'].includes(intent.state) && !result.ok)) throw new Error('recovery_coverage_overlap');
  }
}
