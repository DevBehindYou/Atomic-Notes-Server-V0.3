import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import type { drive_v3 } from 'googleapis';
import type { DriveAdapter } from '../src/routes/notes.js';
import { migrateAtomicFile, type AtomicFileV1 } from '../src/types/atomicFile.js';
import { remoteNoteRowSchema } from '../src/types/noteWire.js';
import { noteWriteIntentSchema, recoveryIndexSpecs, type NoteWriteIntent } from '../src/db/recoveryContract.js';
import { noteContentHash } from '../src/lib/contentHash.js';
import { startClientFixture, FIXTURE_TOKENS } from './clientFixture.js';
import { assertFixtureCleanup } from './clientFixtureSafety.js';

test('same metadata failure breaks mutable writes while candidate commit preserves old content and atomically retries', { timeout: 60000 }, async (t) => {
  let phase = 'setup', passed = false, immutableWrites = 0;
  t.after(() => writeFileSync('ci-recovery-commit-proof.json', JSON.stringify({ version: 1,
    scope: 'disposable inactive atomic metadata result and intent commit', phase, outcome: passed ? 'pass' : 'fail' })));
  const files = new Map<string, AtomicFileV1>();
  const mutable: DriveAdapter = {
    async createNoteFile(_a, _r, _p, _n, content) {
      const id = randomUUID(); files.set(id, migrateAtomicFile(content)); return { id };
    },
    async updateNoteFile(_a, _r, id, content) { files.set(id, migrateAtomicFile(content)); return { id }; },
    async deleteNoteFile(_a, _r, id) { files.delete(id); },
    async getNoteFileContent(_a, _r, id) {
      if (!files.has(id)) throw Object.assign(new Error('synthetic_missing'), { code: 404 });
      return structuredClone(files.get(id)!) as unknown as Record<string, unknown>;
    },
    async ensureAppFolders() { return { notesId: 'synthetic-parent' }; },
  };
  const fixture = await startClientFixture(process.env.MONGODB_URI, process.env.MONGODB_DB_NAME, mutable);
  let cleanupLease: (() => Promise<unknown>) | undefined;
  t.after(async () => { try { await cleanupLease?.(); } finally { await fixture.close(); } });
  const { getDb } = await import('../src/db/mongo.js');
  const { collections } = await import('../src/db/collections.js');
  const { openSync, finishSync, syncOperations } = await import('../src/lib/syncOperation.js');
  const { acquireRecoveryLease, releaseRecoveryLease } = await import('../src/lib/recoveryGate.js');
  const { prepareRecoveryIntents, stageRecoveryIntent } = await import('../src/lib/recoveryIntent.js');
  const { commitRecoveryIntents } = await import('../src/lib/recoveryCommit.js');
  const db = await getDb(); assertFixtureCleanup(db.databaseName, fixture.database);
  await collections.googleAccounts(db).updateMany({ userId: { $in: [fixture.owner, fixture.other] } },
    { $set: { driveRootFolderId: 'synthetic-parent' } });
  const journal = db.collection<NoteWriteIntent>('note_write_intents');
  const counters = db.collection<{ _id: string; value: number }>('sync_counters');
  for (const spec of recoveryIndexSpecs) await journal.createIndex({ ...spec.key }, { name: spec.name,
    ...('unique' in spec ? { unique: spec.unique } : {}),
    ...('partialFilterExpression' in spec ? { partialFilterExpression: spec.partialFilterExpression } : {}) });
  const now = new Date();
  const content = (id: string, body: string) => migrateAtomicFile({ version: 1, id, kind: 'text', title: 'Public synthetic commit title',
    body, items: [], pinned: false, encV: 0, payload: null, createdAt: now.toISOString(), updatedAt: now.toISOString() });
  const wire = (file: AtomicFileV1, base_version: number) => remoteNoteRowSchema.parse({ id: file.id, kind: file.kind,
    title: file.title, body: file.body, items: file.items, pinned: file.pinned, deleted: false,
    enc_v: file.encV, payload: file.payload, base_version, created_at: file.createdAt });
  const seed = async (userId: string, fileId: string, file: AtomicFileV1) => {
    files.set(fileId, file);
    await collections.notes(db).insertOne({ _id: file.id, userId, folderId: null, kind: 'text', pinned: false,
      deleted: false, encV: 0, driveFileId: fileId, driveRevisionId: null, localVersion: 1, syncSequence: 1,
      contentHash: noteContentHash({ ...file, enc_v: 0 }), syncStatus: 'synced', createdAt: now, updatedAt: now, lastSyncedAt: now });
    await counters.insertOne({ _id: userId, value: 1 });
  };
  const call = (token: string, path: string, body?: object) => fetch(`${fixture.origin}${path}`, {
    method: body ? 'POST' : 'GET', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: body ? JSON.stringify(body) : undefined,
  });
  phase = 'mutable_baseline';
  const baseline = content(randomUUID(), 'Public synthetic mutable old body');
  await seed(fixture.other, 'synthetic-mutable-old', baseline);
  await db.command({ collMod: 'notes', validator: { _id: { $ne: baseline.id } }, validationLevel: 'strict', validationAction: 'error' });
  const changedBaseline = { ...baseline, body: 'Public synthetic mutable uncommitted body' };
  assert.equal((await call(FIXTURE_TOKENS.other, '/api/notes/push', { requestId: randomUUID(), mode: 'instant', rows: [wire(changedBaseline, 1)] })).status, 502);
  assert.equal(files.get('synthetic-mutable-old')!.body, changedBaseline.body);
  assert.equal((await call(FIXTURE_TOKENS.other, '/api/notes/pull?after=0')).status, 409);
  await db.command({ collMod: 'notes', validator: {}, validationLevel: 'strict', validationAction: 'error' });
  phase = 'candidate_staged';
  const old = content(randomUUID(), 'Public synthetic immutable old body');
  await seed(fixture.owner, 'synthetic-immutable-old', old);
  const targets = [{ ...old, body: 'Public synthetic immutable newer body' }, content(randomUUID(), 'Public synthetic fresh body')];
  const rows = targets.map((file, i) => wire(file, i === 0 ? 1 : 0));
  const lease = await acquireRecoveryLease(db, fixture.owner);
  cleanupLease = () => releaseRecoveryLease(db, lease);
  const requestId = randomUUID(), operation = await openSync(db, fixture.owner, requestId, rows, 'instant');
  await syncOperations(db).updateOne({ _id: operation._id }, { $set: { recoveryFormat: 1 } });
  const manifests = targets.map((file, i) => noteWriteIntentSchema.parse({ _id: `${fixture.owner}:${requestId}:${file.id}`,
    format: 1, userId: fixture.owner, requestId, noteId: file.id, operationId: operation._id, fingerprint: operation.fingerprint,
    expectedVersion: i === 0 ? 1 : 0, expectedFileId: i === 0 ? 'synthetic-immutable-old' : null,
    expectedHash: i === 0 ? noteContentHash({ ...old, enc_v: 0 }) : null, stagedFileId: `synthetic-staged-${i}`,
    targetHash: noteContentHash({ ...file, enc_v: 0 }), targetFlags: { kind: 'text', encV: 0, pinned: false, deleted: false },
    wipeEpoch: lease.wipeEpoch, leaseToken: lease.token, state: 'prepared', createdAt: now, updatedAt: now,
    committedVersion: null, committedSequence: null, terminalReason: null }));
  const sdk = { files: {
    async create(params: { requestBody: { id: string }; media: { body: AsyncIterable<unknown> } }) {
      if (files.has(params.requestBody.id)) throw { code: 409 };
      let raw = ''; for await (const part of params.media.body) raw += String(part);
      files.set(params.requestBody.id, migrateAtomicFile(JSON.parse(raw))); immutableWrites++;
      return { data: { id: params.requestBody.id } };
    },
    async get(params: { fileId: string; alt?: string }) {
      if (!files.has(params.fileId)) throw { code: 404 };
      return { data: params.alt === 'media' ? structuredClone(files.get(params.fileId)) : {
        id: params.fileId, parents: ['synthetic-parent'], mimeType: 'application/json', trashed: false } };
    },
    async update() { throw new Error('immutable_must_not_update'); }, async delete() { throw new Error('immutable_must_not_delete'); },
  } } as unknown as drive_v3.Drive;
  await prepareRecoveryIntents(db, lease, manifests);
  for (let i = 0; i < manifests.length; i++) await stageRecoveryIntent(db, lease, manifests[i]._id, sdk, 'synthetic-parent', targets[i]);
  const snapshot = async () => ({
    notes: await collections.notes(db).find({ userId: fixture.owner }).sort({ _id: 1 }).toArray(),
    counter: await counters.findOne({ _id: fixture.owner }), operation: await syncOperations(db).findOne({ _id: operation._id }),
    journal: await journal.find({ operationId: operation._id }).sort({ _id: 1 }).toArray(),
    wallet: await collections.atomicUsers(db).findOne({ _id: fixture.owner }),
  });
  const before = await snapshot(); assert.equal(immutableWrites, 2);
  phase = 'metadata_rejection';
  await db.command({ collMod: 'notes', validator: { _id: { $ne: old.id } }, validationLevel: 'strict', validationAction: 'error' });
  await assert.rejects(commitRecoveryIntents(db, lease, manifests.map((row) => row._id), sdk, 'synthetic-parent'),
    (error: unknown) => typeof error === 'object' && error !== null && 'code' in error && error.code === 121);
  assert.deepEqual(await snapshot(), before); assert.deepEqual(files.get('synthetic-immutable-old'), old);
  await db.command({ collMod: 'notes', validator: {}, validationLevel: 'strict', validationAction: 'error' });
  phase = 'atomic_rollback';
  await assert.rejects(commitRecoveryIntents(db, lease, manifests.map((row) => row._id), sdk, 'synthetic-parent', async () => {
    throw new Error('synthetic_after_all_writes');
  }), /synthetic_after_all_writes/);
  assert.deepEqual(await snapshot(), before); assert.deepEqual(files.get('synthetic-immutable-old'), old);
  const oldPull = await call(FIXTURE_TOKENS.a, '/api/notes/pull?after=0'); assert.equal(oldPull.status, 200);
  const oldPage = await oldPull.json() as { rows: { body: string; version: number }[] };
  assert.equal(oldPage.rows[0].body, old.body); assert.equal(oldPage.rows[0].version, 1);
  phase = 'atomic_retry';
  const saved = await commitRecoveryIntents(db, lease, manifests.map((row) => row._id), sdk, 'synthetic-parent');
  assert.equal(saved.size, 2); assert.equal(saved.get(old.id)!.localVersion, 2); assert.equal(saved.get(targets[1].id)!.localVersion, 3);
  assert.deepEqual([...saved.values()].map((note) => note.syncSequence), [2, 3]);
  for (const manifest of manifests) {
    const intent = (await journal.findOne({ _id: manifest._id }))!;
    assert.equal(intent.state, 'committed'); assert.equal(intent.committedVersion, saved.get(intent.noteId)!.localVersion);
    assert.equal(intent.committedSequence, saved.get(intent.noteId)!.syncSequence);
    assert.equal(saved.get(intent.noteId)!.generationFormat, 1);
  }
  const success = (await syncOperations(db).findOne({ _id: operation._id }))!;
  assert.equal(success.results.length, 2); assert.equal(success.results.every((result) => result.ok), true);
  const finished = await finishSync(db, operation); assert.equal(finished.refunded, 0); assert.equal(finished.charged, 10);
  phase = 'actual_pull_replay';
  const pull = await call(FIXTURE_TOKENS.a, '/api/notes/pull?after=0'); assert.equal(pull.status, 200);
  const page = await pull.json() as { nextCursor: number; rows: { id: string; body: string; version: number }[] };
  assert.equal(page.nextCursor, 3); assert.equal(page.rows.length, 2);
  for (const file of targets) assert.equal(page.rows.find((row) => row.id === file.id)!.body, file.body);
  await releaseRecoveryLease(db, lease); cleanupLease = undefined;
  const wallet = await collections.atomicUsers(db).findOne({ _id: fixture.owner });
  const ledger = await collections.energyLedger(db).countDocuments({ userId: fixture.owner });
  const replay = await call(FIXTURE_TOKENS.a, '/api/notes/push', { requestId, mode: 'instant', rows });
  assert.equal(replay.status, 200); const receipt = await replay.json() as { results: unknown[]; charged: number; refunded: number };
  assert.deepEqual(receipt.results, finished.results); assert.equal(receipt.charged, 10); assert.equal(receipt.refunded, 0);
  assert.deepEqual(await collections.atomicUsers(db).findOne({ _id: fixture.owner }), wallet);
  assert.equal(await collections.energyLedger(db).countDocuments({ userId: fixture.owner }), ledger);
  assert.equal(immutableWrites, 2); assert.deepEqual(files.get('synthetic-immutable-old'), old);
  assert.equal((await counters.findOne({ _id: fixture.owner }))!.value, 3);
  phase = 'complete'; passed = true;
});
