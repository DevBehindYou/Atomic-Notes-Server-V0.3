import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import type { drive_v3 } from 'googleapis';
import { noteWriteIntentSchema, recoveryIndexSpecs, type NoteWriteIntent } from '../src/db/recoveryContract.js';
import { noteContentHash } from '../src/lib/contentHash.js';
import { migrateAtomicFile, type AtomicFileV1 } from '../src/types/atomicFile.js';
import { remoteNoteRowSchema } from '../src/types/noteWire.js';
import { startClientFixture, FIXTURE_TOKENS } from './clientFixture.js';
import { assertFixtureCleanup } from './clientFixtureSafety.js';

test('persisted generation survives failed verification and retained-ID retry without changing the old pointer', { timeout: 60000 }, async (t) => {
  let phase = 'setup', passed = false;
  t.after(() => writeFileSync('ci-recovery-intent-proof.json', JSON.stringify({ version: 1,
    scope: 'disposable inactive intent persistence and generation staging', phase, outcome: passed ? 'pass' : 'fail' })));
  const fixture = await startClientFixture(process.env.MONGODB_URI, process.env.MONGODB_DB_NAME);
  let cleanupLease: (() => Promise<unknown>) | undefined;
  t.after(async () => { try { await cleanupLease?.(); } finally { await fixture.close(); } });
  const { getDb } = await import('../src/db/mongo.js');
  const { collections } = await import('../src/db/collections.js');
  const { acquireRecoveryLease, releaseRecoveryLease } = await import('../src/lib/recoveryGate.js');
  const { prepareRecoveryIntents, stageRecoveryIntent } = await import('../src/lib/recoveryIntent.js');
  const { openSync, finishSync, syncOperations } = await import('../src/lib/syncOperation.js');
  const db = await getDb(); assertFixtureCleanup(db.databaseName, fixture.database);
  for (const spec of recoveryIndexSpecs) await db.collection(spec.collection).createIndex({ ...spec.key }, { name: spec.name,
    ...('unique' in spec ? { unique: spec.unique } : {}),
    ...('partialFilterExpression' in spec ? { partialFilterExpression: spec.partialFilterExpression } : {}) });
  const journal = db.collection<NoteWriteIntent>('note_write_intents');
  const id = randomUUID(), requestId = randomUUID(), now = new Date();
  const oldContent = migrateAtomicFile({ version: 1, id, kind: 'text', title: 'Public synthetic old title',
    body: 'Public synthetic old body', items: [], pinned: false, encV: 0, payload: null,
    createdAt: now.toISOString(), updatedAt: now.toISOString() });
  const target = { ...oldContent, title: 'Public synthetic new title', body: 'Public synthetic staged body' };
  const oldHash = noteContentHash({ ...oldContent, enc_v: 0 });
  // Explicit fixture pre-image, not a claim that the production route wrote it.
  await collections.notes(db).insertOne({ _id: id, userId: fixture.owner, folderId: null, kind: 'text',
    pinned: false, deleted: false, encV: 0, driveFileId: 'synthetic-old-generation', driveRevisionId: null,
    localVersion: 1, syncSequence: 1, contentHash: oldHash, syncStatus: 'synced', createdAt: now, updatedAt: now, lastSyncedAt: now });
  const original = await collections.notes(db).findOne({ _id: id });
  const row = remoteNoteRowSchema.parse({ id, kind: 'text', title: target.title, body: target.body, items: [], pinned: false,
    deleted: false, enc_v: 0, payload: null, base_version: 1, created_at: now.toISOString() });
  const lease = await acquireRecoveryLease(db, fixture.owner);
  cleanupLease = () => releaseRecoveryLease(db, lease);
  phase = 'pending_operation';
  const operation = await openSync(db, fixture.owner, requestId, [row], 'instant');
  assert.equal((await collections.atomicUsers(db).findOne({ _id: fixture.owner }))!.energy, 90);
  const manifest = noteWriteIntentSchema.parse({ _id: `${fixture.owner}:${requestId}:${id}`, format: 1,
    userId: fixture.owner, noteId: id, requestId, operationId: operation._id, fingerprint: operation.fingerprint,
    expectedVersion: 1, expectedFileId: original!.driveFileId, expectedHash: oldHash, stagedFileId: 'synthetic-new-generation',
    targetHash: noteContentHash({ ...target, enc_v: 0 }), targetFlags: { kind: 'text', encV: 0, pinned: false, deleted: false },
    wipeEpoch: lease.wipeEpoch, leaseToken: lease.token, state: 'prepared', createdAt: now, updatedAt: now,
    committedVersion: null, committedSequence: null, terminalReason: null });
  await assert.rejects(prepareRecoveryIntents(db, lease, [manifest]), /recovery_operation_invalid/);
  assert.equal(await journal.countDocuments({}), 0);
  // Marker is synthetic and applied only to this generated operation. Debit and
  // registration remain separate here; their future coupling is not proven.
  await syncOperations(db).updateOne({ _id: operation._id }, { $set: { recoveryFormat: 1 } });
  phase = 'persist_manifest';
  assert.deepEqual(await prepareRecoveryIntents(db, lease, [manifest]), [manifest]);
  assert.deepEqual(await prepareRecoveryIntents(db, lease, [manifest]), [manifest]);
  assert.equal(await journal.countDocuments({}), 1);
  await assert.rejects(prepareRecoveryIntents(db, lease, [{ ...manifest, stagedFileId: 'synthetic-replacement' }]), /recovery_intent_mismatch/);
  assert.deepEqual(await journal.findOne({ _id: manifest._id }), manifest);
  const files = new Map<string, AtomicFileV1>([['synthetic-old-generation', oldContent]]);
  let creates = 0, writes = 0, armValidator = true;
  const drive = { files: {
    async create(params: { requestBody: { id: string; parents: string[] }; media: { body: AsyncIterable<unknown> } }) {
      creates++;
      // Observe actual durable registration before any external side effect.
      assert.equal((await journal.findOne({ _id: manifest._id }))!.stagedFileId, params.requestBody.id);
      if (files.has(params.requestBody.id)) throw { code: 409 };
      let text = ''; for await (const part of params.media.body) text += String(part);
      files.set(params.requestBody.id, migrateAtomicFile(JSON.parse(text))); writes++;
      if (armValidator) {
        armValidator = false;
        await db.command({ collMod: 'note_write_intents', validator: { state: 'prepared' }, validationLevel: 'strict', validationAction: 'error' });
      }
      return { data: { id: params.requestBody.id } };
    },
    async get(params: { fileId: string; alt?: string }) {
      assert.equal(files.has(params.fileId), true);
      return { data: params.alt === 'media' ? files.get(params.fileId) : { id: params.fileId,
        parents: ['synthetic-parent'], mimeType: 'application/json', trashed: false } };
    },
    async update() { throw new Error('must_not_overwrite'); }, async delete() { throw new Error('must_not_delete'); },
  } } as unknown as drive_v3.Drive;
  phase = 'content_mismatch';
  await assert.rejects(stageRecoveryIntent(db, lease, manifest._id, drive, 'synthetic-parent', { ...target, body: 'synthetic wrong body' }), /recovery_staged_content_mismatch/);
  assert.equal(creates, 0);
  phase = 'failed_verify';
  await assert.rejects(stageRecoveryIntent(db, lease, manifest._id, drive, 'synthetic-parent', target),
    (error: unknown) => (error as { code?: number }).code === 121);
  assert.equal((await journal.findOne({ _id: manifest._id }))!.state, 'prepared');
  assert.equal(files.size, 2); assert.equal(writes, 1); assert.deepEqual(files.get('synthetic-old-generation'), oldContent);
  assert.deepEqual(await collections.notes(db).findOne({ _id: id }), original);
  assert.equal((await collections.atomicUsers(db).findOne({ _id: fixture.owner }))!.energy, 90);
  phase = 'retained_id_retry';
  await db.command({ collMod: 'note_write_intents', validator: {}, validationLevel: 'strict', validationAction: 'error' });
  const verified = await stageRecoveryIntent(db, lease, manifest._id, drive, 'synthetic-parent', target);
  assert.equal(verified.state, 'verified'); assert.equal(verified.stagedFileId, manifest.stagedFileId);
  assert.equal(writes, 1); assert.equal(creates, 2); assert.equal(files.size, 2);
  assert.deepEqual(await collections.notes(db).findOne({ _id: id }), original);
  assert.equal(verified.committedVersion, null); assert.equal(verified.committedSequence, null);
  assert.equal(JSON.stringify(await journal.findOne({ _id: manifest._id })).includes(target.body), false);
  phase = 'closed_receipt';
  const finished = await finishSync(db, operation);
  assert.equal(finished.status, 'complete'); assert.equal(finished.charged, 10); assert.equal(finished.refunded, 10);
  assert.equal(finished.results[0].ok, false);
  await assert.rejects(stageRecoveryIntent(db, lease, manifest._id, drive, 'synthetic-parent', target), /recovery_operation_invalid/);
  assert.equal(creates, 2); assert.deepEqual(await collections.notes(db).findOne({ _id: id }), original);
  const beforeReplay = await collections.atomicUsers(db).findOne({ _id: fixture.owner });
  const ledger = await collections.energyLedger(db).countDocuments({ userId: fixture.owner });
  await releaseRecoveryLease(db, lease); cleanupLease = undefined;
  const replay = await fetch(`${fixture.origin}/api/notes/push`, { method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${FIXTURE_TOKENS.a}` },
    body: JSON.stringify({ requestId, mode: 'instant', rows: [row] }) });
  assert.equal(replay.status, 502);
  const receipt = await replay.json() as { charged: number; refunded: number; results: unknown[] };
  assert.equal(receipt.charged, 10); assert.equal(receipt.refunded, 10); assert.deepEqual(receipt.results, finished.results);
  assert.deepEqual(await collections.atomicUsers(db).findOne({ _id: fixture.owner }), beforeReplay);
  assert.equal(await collections.energyLedger(db).countDocuments({ userId: fixture.owner }), ledger);
  assert.equal(creates, 2);
  phase = 'complete'; passed = true;
});
