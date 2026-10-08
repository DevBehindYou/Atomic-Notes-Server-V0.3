import assert from 'node:assert/strict';
import { z } from 'zod';
import type { drive_v3 } from 'googleapis';
import { fixtureDatabase, assertFixtureCleanup } from './clientFixtureSafety.js';
import { noteWriteIntentSchema } from '../src/db/recoveryContract.js';
import { migrateAtomicFile } from '../src/types/atomicFile.js';
import { remoteNoteRowSchema } from '../src/types/noteWire.js';
import { noteContentHash } from '../src/lib/contentHash.js';

// Test-only worker: no dotenv, inherited credential inventory or raw diagnostics.
const inputSchema = z.object({ phase: z.enum(['prepared', 'verified', 'committed', 'settled', 'replayed',
  'uncertain', 'waiting', 'resumed', 'resumed_replay']),
  database: z.string(), owner: z.string().uuid(), requestId: z.string().uuid(),
  noteIds: z.array(z.string().uuid()).length(2), createdAt: z.string().datetime(), driveOrigin: z.string() }).strict();

async function run(input: unknown) {
  const args = inputSchema.parse(input);
  fixtureDatabase(process.env.MONGODB_URI);
  assertFixtureCleanup(process.env.MONGODB_DB_NAME!, args.database);
  const origin = new URL(args.driveOrigin);
  assert.equal(origin.protocol, 'http:'); assert.equal(origin.hostname, '127.0.0.1');
  assert.ok(origin.port); assert.equal(origin.username, ''); assert.equal(origin.password, '');
  assert.equal(origin.pathname, '/'); assert.equal(origin.search, ''); assert.equal(origin.hash, '');
  const { getDb, closeDb } = await import('../src/db/mongo.js');
  const { acquireRecoveryLease, releaseRecoveryLease } = await import('../src/lib/recoveryGate.js');
  const { beginRecoverySync } = await import('../src/lib/recoveryAdmission.js');
  const { adoptRecoveryOperation } = await import('../src/lib/recoveryAdoption.js');
  const { stageRecoveryIntent } = await import('../src/lib/recoveryIntent.js');
  const { commitRecoveryIntents } = await import('../src/lib/recoveryCommit.js');
  const { finishRecoverySync } = await import('../src/lib/recoverySettlement.js');
  const { resumeRecoveryOperation } = await import('../src/lib/recoveryResume.js');
  const { fingerprintOf } = await import('../src/lib/syncOperation.js');
  const db = await getDb(); assertFixtureCleanup(db.databaseName, args.database);
  const prior = await db.collection<{ _id: string; leaseExpiresAt: Date | null }>('note_sync_state').findOne({ _id: args.owner });
  const lease = await acquireRecoveryLease(db, args.owner,
    () => prior?.leaseExpiresAt ? new Date(prior.leaseExpiresAt.getTime() + 1) : new Date());
  const contents = args.noteIds.map((id, i) => migrateAtomicFile({ version: 1, id, kind: 'text',
    title: 'Public synthetic restart', body: `Public synthetic restart body ${i}`, items: [], pinned: false,
    encV: 0, payload: null, createdAt: args.createdAt, updatedAt: args.createdAt }));
  const rows = contents.map((file) => remoteNoteRowSchema.parse({ id: file.id, kind: file.kind, title: file.title,
    body: file.body, items: [], pinned: false, deleted: false, enc_v: 0, payload: null,
    base_version: 0, created_at: file.createdAt }));
  const intents = rows.map((row, i) => noteWriteIntentSchema.parse({ _id: `${args.owner}:${args.requestId}:${row.id}`,
    format: 1, userId: args.owner, noteId: row.id, requestId: args.requestId, operationId: `${args.owner}:${args.requestId}`,
    fingerprint: fingerprintOf(rows, 'instant'), expectedVersion: 0, expectedFileId: null, expectedHash: null,
    stagedFileId: `synthetic-restart-${args.requestId}-${i}`, targetHash: noteContentHash(row),
    targetFlags: { kind: 'text', encV: 0, pinned: false, deleted: false }, wipeEpoch: lease.wipeEpoch,
    leaseToken: lease.token, state: 'prepared', createdAt: new Date(args.createdAt), updatedAt: new Date(),
    committedVersion: null, committedSequence: null, terminalReason: null }));
  const sdk = { files: {
    async create(params: { requestBody: { id: string }; media: { body: AsyncIterable<unknown> } }) {
      let raw = ''; for await (const part of params.media.body) raw += String(part);
      const response = await fetch(`${args.driveOrigin}/files/${encodeURIComponent(params.requestBody.id)}`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: raw });
      if (!response.ok) throw { code: response.status };
      return { data: await response.json() };
    },
    async get(params: { fileId: string; alt?: string }) {
      const response = await fetch(`${args.driveOrigin}/files/${encodeURIComponent(params.fileId)}${params.alt === 'media' ? '?media=1' : ''}`);
      if (!response.ok) throw { code: response.status };
      return { data: await response.json() };
    },
    async update() { throw new Error('must_not_overwrite'); }, async delete() { throw new Error('must_not_delete'); },
  } } as unknown as drive_v3.Drive;
  if (args.phase === 'uncertain') {
    await beginRecoverySync(db, lease, args.requestId, rows, 'instant', intents);
    // Parent persists this create but holds its response, then kills the worker.
    await stageRecoveryIntent(db, lease, intents[0]._id, sdk, 'synthetic-parent', contents[0]);
    throw new Error('synthetic_uncertain_response_must_stay_held');
  }
  if (args.phase === 'waiting' || args.phase === 'resumed' || args.phase === 'resumed_replay') {
    const outcome = await resumeRecoveryOperation(db, lease, intents[0].operationId, sdk,
      'synthetic-parent', args.phase === 'resumed' ? [contents[1]] : []);
    if (args.phase === 'waiting') {
      assert.deepEqual(outcome, { status: 'needs_client_content', noteIds: [args.noteIds[1]] });
    } else {
      assert.equal(outcome.status, 'complete');
      if (outcome.status !== 'complete') throw new Error('synthetic_expected_receipt');
      assert.equal(outcome.operation.charged, 10); assert.equal(outcome.operation.refunded, 0);
      assert.equal(outcome.operation.results.length, 2);
    }
    await releaseRecoveryLease(db, lease); await closeDb();
    process.send?.({ phase: args.phase }); process.disconnect?.(); return;
  }
  if (args.phase === 'prepared' || args.phase === 'verified' || args.phase === 'replayed') {
    const started = await beginRecoverySync(db, lease, args.requestId, rows, 'instant', intents);
    if (args.phase === 'verified') for (let i = 0; i < intents.length; i++) {
      await stageRecoveryIntent(db, lease, intents[i]._id, sdk, 'synthetic-parent', contents[i]);
    }
    if (args.phase === 'replayed') {
      assert.equal(started.operation.status, 'complete'); assert.deepEqual(started.intents, []);
      const receipt = await finishRecoverySync(db, lease, intents[0].operationId);
      assert.equal(receipt.charged, 10); assert.equal(receipt.refunded, 0); assert.equal(receipt.results.length, 2);
      await releaseRecoveryLease(db, lease); await closeDb();
      process.send?.({ phase: args.phase }); process.disconnect?.(); return;
    }
  } else {
    const adopted = await adoptRecoveryOperation(db, lease, intents[0].operationId);
    if (args.phase === 'committed') {
      assert.equal(adopted.every((row) => row.state === 'verified'), true);
      await commitRecoveryIntents(db, lease, adopted.map((row) => row._id), sdk, 'synthetic-parent');
    } else {
      assert.equal(adopted.every((row) => row.state === 'committed'), true);
      const receipt = await finishRecoverySync(db, lease, intents[0].operationId);
      assert.equal(receipt.charged, 10); assert.equal(receipt.refunded, 0);
    }
  }
  process.send?.({ phase: args.phase });
  // Parent kills this process; Mongo, its journal and fake Drive live elsewhere.
  await new Promise<void>(() => {});
}

process.once('message', (input: unknown) => {
  void run(input).catch(async () => {
    process.send?.({ phase: 'failed' });
    try { const { closeDb } = await import('../src/db/mongo.js'); await closeDb(); } catch { /* fixed failure only */ }
    process.exitCode = 1; process.disconnect?.();
  });
});
