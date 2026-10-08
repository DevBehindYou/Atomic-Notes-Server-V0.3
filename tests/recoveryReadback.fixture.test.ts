import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import type { drive_v3 } from 'googleapis';
import type { DriveAdapter } from '../src/routes/notes.js';
import { noteWriteIntentSchema, type NoteWriteIntent } from '../src/db/recoveryContract.js';
import { noteContentHash } from '../src/lib/contentHash.js';
import { migrateAtomicFile, type AtomicFileV1 } from '../src/types/atomicFile.js';
import { remoteNoteRowSchema } from '../src/types/noteWire.js';
import { startClientFixture, FIXTURE_TOKENS } from './clientFixture.js';
import { assertFixtureCleanup } from './clientFixtureSafety.js';

test('inactive commit refuses changed staged generations, retries transient reads and abandons a missing generation without losing the old version', { timeout: 60000 }, async (t) => {
  let phase = 'setup', passed = false, writes = 0;
  t.after(() => writeFileSync('ci-recovery-readback-proof.json', JSON.stringify({ version: 1,
    scope: 'disposable inactive staged generation readback refusal', phase, outcome: passed ? 'pass' : 'fail' })));
  const files = new Map<string, AtomicFileV1>();
  const notesDrive: DriveAdapter = {
    async createNoteFile() { throw new Error('unexpected_mutable_create'); },
    async updateNoteFile() { throw new Error('unexpected_mutable_update'); },
    async deleteNoteFile() { throw new Error('unexpected_mutable_delete'); },
    async getNoteFileContent(_a, _r, id) {
      if (!files.has(id)) throw { code: 404 };
      return structuredClone(files.get(id)!) as unknown as Record<string, unknown>;
    },
    async ensureAppFolders() { return { notesId: 'synthetic-parent' }; },
  };
  const fixture = await startClientFixture(process.env.MONGODB_URI, process.env.MONGODB_DB_NAME, notesDrive);
  let cleanupLease: (() => Promise<unknown>) | undefined;
  t.after(async () => { try { await cleanupLease?.(); } finally { await fixture.close(); } });
  const { getDb } = await import('../src/db/mongo.js');
  const { collections } = await import('../src/db/collections.js');
  const { acquireRecoveryLease, releaseRecoveryLease } = await import('../src/lib/recoveryGate.js');
  const { fingerprintOf, syncOperations } = await import('../src/lib/syncOperation.js');
  const { beginRecoverySync } = await import('../src/lib/recoveryAdmission.js');
  const { stageRecoveryIntent } = await import('../src/lib/recoveryIntent.js');
  const { commitRecoveryIntents } = await import('../src/lib/recoveryCommit.js');
  const { finishRecoverySync, abandonRecoverySync } = await import('../src/lib/recoverySettlement.js');
  const db = await getDb(); assertFixtureCleanup(db.databaseName, fixture.database);
  const lease = await acquireRecoveryLease(db, fixture.owner);
  cleanupLease = () => releaseRecoveryLease(db, lease);
  await collections.googleAccounts(db).updateOne({ userId: fixture.owner }, { $set: { driveRootFolderId: 'synthetic-parent' } });
  const journal = db.collection<NoteWriteIntent>('note_write_intents');
  const counters = db.collection<{ _id: string; value: number }>('sync_counters');
  const now = new Date();
  type Fault = 'body' | 'note_id' | 'file_id' | 'parent' | 'mime' | 'trashed' | 'missing' | 'unavailable';
  let fault: Fault | undefined, faultId: string | undefined;
  const sdk = { files: {
    async create(params: { requestBody: { id: string }; media: { body: AsyncIterable<unknown> } }) {
      if (files.has(params.requestBody.id)) throw { code: 409 };
      let raw = ''; for await (const part of params.media.body) raw += String(part);
      files.set(params.requestBody.id, migrateAtomicFile(JSON.parse(raw))); writes++;
      return { data: { id: params.requestBody.id } };
    },
    async get(params: { fileId: string; alt?: string }) {
      if (!files.has(params.fileId) || (params.fileId === faultId && fault === 'missing')) throw { code: 404 };
      if (params.fileId === faultId && fault === 'unavailable') throw { code: 503 };
      const active = params.fileId === faultId ? fault : undefined;
      const content = structuredClone(files.get(params.fileId)!);
      if (params.alt === 'media') {
        if (active === 'body') content.body = 'Public synthetic changed staged body';
        if (active === 'note_id') content.id = randomUUID();
        return { data: content };
      }
      return { data: { id: active === 'file_id' ? 'synthetic-wrong-id' : params.fileId,
        parents: [active === 'parent' ? 'synthetic-wrong-parent' : 'synthetic-parent'],
        mimeType: active === 'mime' ? 'text/plain' : 'application/json', trashed: active === 'trashed' } };
    },
    async update() { throw new Error('must_not_overwrite'); }, async delete() { throw new Error('must_not_delete'); },
  } } as unknown as drive_v3.Drive;
  const content = (id = randomUUID(), body = 'Public synthetic last committed body') => migrateAtomicFile({ version: 1, id,
    kind: 'text', title: 'Public synthetic readback', body, items: [], pinned: false, encV: 0, payload: null,
    createdAt: now.toISOString(), updatedAt: now.toISOString() });
  const make = async (file: AtomicFileV1) => {
    const requestId = randomUUID(), preimage = await collections.notes(db).findOne({ _id: file.id });
    const rows = [remoteNoteRowSchema.parse({ id: file.id, kind: 'text', title: file.title, body: file.body,
      items: [], pinned: false, deleted: false, enc_v: 0, payload: null, base_version: preimage?.localVersion ?? 0, created_at: file.createdAt })];
    const intents = [noteWriteIntentSchema.parse({ _id: `${fixture.owner}:${requestId}:${file.id}`,
      format: 1, userId: fixture.owner, noteId: file.id, requestId, operationId: `${fixture.owner}:${requestId}`,
      fingerprint: fingerprintOf(rows, 'instant'), expectedVersion: rows[0].base_version,
      expectedFileId: preimage?.driveFileId ?? null, expectedHash: preimage?.contentHash ?? null,
      stagedFileId: `synthetic-${randomUUID()}`, targetHash: noteContentHash(rows[0]),
      targetFlags: { kind: 'text', encV: 0, pinned: false, deleted: false }, wipeEpoch: lease.wipeEpoch,
      leaseToken: lease.token, state: 'prepared', createdAt: now, updatedAt: now,
      committedVersion: null, committedSequence: null, terminalReason: null })];
    await beginRecoverySync(db, lease, requestId, rows, 'instant', intents);
    await stageRecoveryIntent(db, lease, intents[0]._id, sdk, 'synthetic-parent', file);
    return { requestId, rows, intents, file, operationId: intents[0].operationId };
  };
  const snapshot = async () => ({
    notes: await collections.notes(db).find({ userId: fixture.owner }).sort({ _id: 1 }).toArray(),
    counter: await counters.findOne({ _id: fixture.owner }),
    operations: await syncOperations(db).find({ userId: fixture.owner }).sort({ _id: 1 }).toArray(),
    intents: await journal.find({ userId: fixture.owner }).sort({ _id: 1 }).toArray(),
    wallet: await collections.atomicUsers(db).findOne({ _id: fixture.owner }),
    ledger: await collections.energyLedger(db).find({ userId: fixture.owner }).sort({ _id: 1 }).toArray(),
  });
  const auth = { authorization: `Bearer ${FIXTURE_TOKENS.a}`, 'content-type': 'application/json' };
  const checkPull = async (expected: AtomicFileV1, version: number) => {
    const response = await fetch(`${fixture.origin}/api/notes/pull?after=0`, { headers: auth });
    assert.equal(response.status, 200);
    const page = await response.json() as { rows: { id: string; body: string; version: number }[]; nextCursor: number };
    assert.equal(page.rows.length, 1); assert.equal(page.rows[0].id, expected.id);
    assert.equal(page.rows[0].body, expected.body); assert.equal(page.rows[0].version, version);
    assert.equal(page.nextCursor, version);
  };
  const old = content(), initial = await make(old);
  await commitRecoveryIntents(db, lease, [initial.intents[0]._id], sdk, 'synthetic-parent');
  await finishRecoverySync(db, lease, initial.operationId);
  const next = await make({ ...old, body: 'Public synthetic verified newer body' });
  const before = await snapshot(); faultId = next.intents[0].stagedFileId!;
  phase = 'readback_refusals';
  for (const candidate of ['body', 'note_id', 'file_id', 'parent', 'mime', 'trashed', 'missing', 'unavailable'] as const) {
    fault = candidate;
    await assert.rejects(commitRecoveryIntents(db, lease, [next.intents[0]._id], sdk, 'synthetic-parent'), (error: unknown) => {
      if (candidate === 'missing' || candidate === 'unavailable') return typeof error === 'object' && error !== null &&
        'code' in error && error.code === (candidate === 'missing' ? 404 : 503);
      return error instanceof Error && error.message ===
        (candidate === 'body' || candidate === 'note_id' ? 'recovery_commit_content_mismatch' : 'generation_identity_mismatch');
    });
    assert.deepEqual(await snapshot(), before);
    assert.deepEqual(files.get(initial.intents[0].stagedFileId!), old);
    assert.equal(writes, 2); await checkPull(old, 1);
  }
  phase = 'read_retry'; fault = undefined;
  const saved = await commitRecoveryIntents(db, lease, [next.intents[0]._id], sdk, 'synthetic-parent');
  assert.equal(saved.get(old.id)!.localVersion, 2); assert.equal(saved.get(old.id)!.syncSequence, 2);
  const completed = await finishRecoverySync(db, lease, next.operationId);
  assert.equal(completed.charged, 10); assert.equal(completed.refunded, 0);
  assert.equal((await snapshot()).wallet!.energy, 80); assert.equal(writes, 2);
  await checkPull(next.file, 2);
  phase = 'missing_generation';
  const missing = await make({ ...old, body: 'Public synthetic unavailable third body' });
  // Explicit fake external removal. Candidate code never deletes a generation,
  // and this test makes no claim about reusing deleted IDs on real Drive.
  files.delete(missing.intents[0].stagedFileId!);
  const beforeMissing = await snapshot();
  await assert.rejects(commitRecoveryIntents(db, lease, [missing.intents[0]._id], sdk, 'synthetic-parent'),
    (error: unknown) => typeof error === 'object' && error !== null && 'code' in error && error.code === 404);
  assert.deepEqual(await snapshot(), beforeMissing); await checkPull(next.file, 2);
  phase = 'explicit_abandonment';
  const aborted = await abandonRecoverySync(db, lease, missing.operationId);
  assert.equal(aborted.charged, 10); assert.equal(aborted.refunded, 10);
  assert.equal((await snapshot()).wallet!.energy, 80);
  assert.equal((await journal.findOne({ _id: missing.intents[0]._id }))!.state, 'abandoned');
  assert.equal((await counters.findOne({ _id: fixture.owner }))!.value, 2);
  assert.deepEqual(files.get(initial.intents[0].stagedFileId!), old);
  assert.deepEqual(files.get(next.intents[0].stagedFileId!), next.file); assert.equal(writes, 3);
  await releaseRecoveryLease(db, lease); cleanupLease = undefined;
  phase = 'actual_pull_replay';
  await checkPull(next.file, 2);
  const final = await snapshot(), finalFiles = structuredClone([...files]);
  for (const [request, receipt, status] of [[next, completed, 200], [missing, aborted, 502]] as const) {
    const response = await fetch(`${fixture.origin}/api/notes/push`, { method: 'POST', headers: auth,
      body: JSON.stringify({ requestId: request.requestId, mode: 'instant', rows: request.rows }) });
    assert.equal(response.status, status);
    const body = await response.json() as { results: unknown[]; charged: number; refunded: number };
    assert.deepEqual(body.results, receipt.results); assert.equal(body.charged, receipt.charged); assert.equal(body.refunded, receipt.refunded);
  }
  assert.deepEqual(await snapshot(), final); assert.deepEqual([...files], finalFiles);
  assert.equal(writes, 3); assert.equal(files.size, 2);
  phase = 'complete'; passed = true;
});
