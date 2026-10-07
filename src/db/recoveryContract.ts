import { z } from 'zod';

/** Inactive contract: no production route/index initializer imports this module. */
const safeInteger = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const positiveInteger = safeInteger.refine((value) => value > 0);
const uuid = z.string().uuid();
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const fileId = z.string().min(1).max(256);
const terminalReason = z.enum(['operation_closed', 'version_changed', 'owner_changed', 'wipe_changed',
  'content_unavailable', 'content_mismatch', 'identity_mismatch', 'write_interrupted']);

export const noteWriteIntentSchema = z.object({
  _id: z.string().length(110), format: z.literal(1), userId: uuid, noteId: uuid, requestId: uuid,
  operationId: z.string().length(73), fingerprint: hash, expectedVersion: safeInteger,
  expectedFileId: fileId.nullable(), expectedHash: hash.nullable(), stagedFileId: fileId.nullable(), targetHash: hash,
  targetFlags: z.object({ kind: z.enum(['text', 'todo']), encV: z.union([z.literal(0), z.literal(1)]),
    pinned: z.boolean(), deleted: z.boolean() }).strict(),
  wipeEpoch: safeInteger, leaseToken: uuid,
  state: z.enum(['prepared', 'verified', 'committed', 'abandoned', 'superseded']),
  createdAt: z.date(), updatedAt: z.date(),
  committedVersion: positiveInteger.nullable(), committedSequence: positiveInteger.nullable(),
  terminalReason: terminalReason.nullable(),
}).strict().superRefine((intent, ctx) => {
  const refuse = (message: string) => ctx.addIssue({ code: 'custom', message });
  if (intent._id !== `${intent.userId}:${intent.requestId}:${intent.noteId}` ||
      intent.operationId !== `${intent.userId}:${intent.requestId}`) refuse('recovery_identity_mismatch');
  if (intent.expectedVersion === 0 && (intent.expectedFileId !== null || intent.expectedHash !== null)) {
    refuse('recovery_fresh_preimage_invalid');
  }
  if (intent.stagedFileId !== null && intent.stagedFileId === intent.expectedFileId) refuse('recovery_generation_reused');
  if (intent.updatedAt < intent.createdAt) refuse('recovery_time_order_invalid');
  const committed = intent.state === 'committed';
  if (committed !== (intent.committedVersion !== null && intent.committedSequence !== null) ||
      (!committed && (intent.committedVersion !== null || intent.committedSequence !== null))) {
    refuse('recovery_commit_fields_invalid');
  }
  const terminalFailure = intent.state === 'abandoned' || intent.state === 'superseded';
  if (terminalFailure !== (intent.terminalReason !== null)) refuse('recovery_terminal_reason_invalid');
  if ((intent.state === 'verified' || committed) && intent.stagedFileId === null && intent.expectedFileId === null) {
    refuse('recovery_verified_content_identity_missing');
  }
});
export type NoteWriteIntent = z.infer<typeof noteWriteIntentSchema>;

export const recoveryGateSchema = z.object({
  _id: uuid, format: z.literal(1), wipeEpoch: safeInteger, gateRevision: safeInteger,
  leaseToken: uuid.nullable(), leaseExpiresAt: z.date().nullable(), updatedAt: z.date(),
}).strict().superRefine((gate, ctx) => {
  if ((gate.leaseToken === null) !== (gate.leaseExpiresAt === null)) {
    ctx.addIssue({ code: 'custom', message: 'recovery_lease_fields_invalid' });
  }
});
export type RecoveryGate = z.infer<typeof recoveryGateSchema>;

/** Validate one bounded operation; callers must still prove ownership in Mongo. */
export function parseRecoveryIntents(input: unknown): NoteWriteIntent[] {
  const intents = z.array(noteWriteIntentSchema).min(1).max(50).parse(input);
  const first = intents[0];
  const noteIds = new Set<string>(), stagedIds = new Set<string>();
  const preimages = new Set(intents.map((row) => row.expectedFileId).filter((id) => id !== null));
  for (const row of intents) {
    if (row.userId !== first.userId || row.operationId !== first.operationId || row.fingerprint !== first.fingerprint ||
        row.wipeEpoch !== first.wipeEpoch || row.leaseToken !== first.leaseToken) throw new Error('recovery_batch_identity_mismatch');
    if (noteIds.has(row.noteId)) throw new Error('recovery_batch_duplicate_note');
    noteIds.add(row.noteId);
    if (row.stagedFileId !== null) {
      if (stagedIds.has(row.stagedFileId) || preimages.has(row.stagedFileId)) throw new Error('recovery_batch_generation_reused');
      stagedIds.add(row.stagedFileId);
    }
  }
  return intents;
}

export function nextRecoveryRevision(value: unknown): number {
  const revision = safeInteger.parse(value);
  if (revision === Number.MAX_SAFE_INTEGER) throw new Error('recovery_revision_exhausted');
  return revision + 1;
}

/** Declarations only: never creates indexes. No TTL or automatic pruning. */
export const recoveryIndexSpecs = [
  { collection: 'note_write_intents', name: 'intent_owner_operation', key: { userId: 1, operationId: 1 } },
  { collection: 'note_write_intents', name: 'intent_owner_state', key: { userId: 1, state: 1, createdAt: 1, _id: 1 } },
  { collection: 'note_write_intents', name: 'intent_owner_staged_file', key: { userId: 1, stagedFileId: 1 },
    unique: true, partialFilterExpression: { stagedFileId: { $type: 'string' } } },
] as const;
