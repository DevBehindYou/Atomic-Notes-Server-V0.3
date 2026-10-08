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

test('explicit abandonment after a changed preimage preserves current and committed work and settles once', { timeout: 60000 }, async (t) => {
  let phase = 'setup', passed = false, writes = 0;
  t.after(() => writeFileSync('ci-recovery-abandonment-proof.json', JSON.stringify({ version: 1,
    scope: 'disposable inactive obsolete operation abandonment', phase, outcome: passed ? 'pass' : 'fail' })));
  const files = new Map<string, AtomicFileV1>();
  const notesDrive: DriveAdapter = {
    async createNoteFile() { throw new Error('unexpected_mutable_write'); },
    async updateNoteFile() { throw new Error('unexpected_mutable_write'); },
    async deleteNoteFile() { throw new Error('unexpected_delete'); },
    async getNoteFileContent(_a, _r, id) {
      if (!files.has(id)) throw { code: 404 };
      return structuredClone(files.get(id)!) as unknown as Record<string, unknown>;
    },
    async ensureAppFolders() { return { notesId: 'synthetic-parent' }; },
  };
  const fixture = await startClientFixture(process.env.MONGODB_URI, process.env.MONGODB_DB_NAME, notesDrive);
  let cleanup: (() => Promise<unknown>) | undefined;
  t.after(async () => { try { await cleanup?.(); } finally { await fixture.close(); } });
  const { getDb } = await import('../src/db/mongo.js');
  const { collections } = await import('../src/db/collections.js');
  const { fingerprintOf, syncOperations } = await import('../src/lib/syncOperation.js');
  const { acquireRecoveryLease, releaseRecoveryLease } = await import('../src/lib/recoveryGate.js');
  const { beginRecoverySync } = await import('../src/lib/recoveryAdmission.js');
  const { stageRecoveryIntent } = await import('../src/lib/recoveryIntent.js');
  const { commitRecoveryIntents } = await import('../src/lib/recoveryCommit.js');
  const { finishRecoverySync, abandonRecoverySync } = await import('../src/lib/recoverySettlement.js');
  const { adoptRecoveryOperation } = await import('../src/lib/recoveryAdoption.js');
  const db = await getDb(); assertFixtureCleanup(db.databaseName, fixture.database);
  await collections.googleAccounts(db).updateOne({ userId: fixture.owner }, { $set: { driveRootFolderId: 'synthetic-parent' } });
  let lease = await acquireRecoveryLease(db, fixture.owner); cleanup = () => releaseRecoveryLease(db, lease);
  const journal = db.collection<NoteWriteIntent>('note_write_intents');
  const counters = db.collection<{ _id: string; value: number }>('sync_counters');
  const now = new Date();
  const content = (id = randomUUID(), body = 'Public synthetic pending body') => migrateAtomicFile({ version: 1, id,
    kind: 'text', title: 'Public synthetic obsolete operation', body, items: [], pinned: false, encV: 0,
    payload: null, createdAt: now.toISOString(), updatedAt: now.toISOString() });
  // Explicit generated metadata setup/change, not a simulated valid concurrent new-writer transaction.
  const setCurrent = async (file: AtomicFileV1, fileId: string, version: number) => {
    files.set(fileId, file);
    await collections.notes(db).replaceOne({ _id: file.id }, { userId: fixture.owner, folderId: null,
      kind: 'text', pinned: false, deleted: false, encV: 0, driveFileId: fileId, driveRevisionId: null,
      localVersion: version, syncSequence: version, contentHash: noteContentHash({ ...file, enc_v: 0 }),
      syncStatus: 'synced', createdAt: now, updatedAt: now, lastSyncedAt: now }, { upsert: true });
    await counters.updateOne({ _id: fixture.owner }, { $set: { value: version } }, { upsert: true });
  };
  const sdk = { files: {
    async create(params: { requestBody: { id: string }; media: { body: AsyncIterable<unknown> } }) {
      if (files.has(params.requestBody.id)) throw { code: 409 };
      let raw = ''; for await (const part of params.media.body) raw += String(part);
      files.set(params.requestBody.id, migrateAtomicFile(JSON.parse(raw))); writes++; return { data: { id: params.requestBody.id } };
    },
    async get(params: { fileId: string; alt?: string }) {
      if (!files.has(params.fileId)) throw { code: 404 };
      return { data: params.alt === 'media' ? structuredClone(files.get(params.fileId)) : {
        id: params.fileId, parents: ['synthetic-parent'], mimeType: 'application/json', trashed: false } };
    },
    async update() { throw new Error('must_not_overwrite'); }, async delete() { throw new Error('must_not_delete'); },
  } } as unknown as drive_v3.Drive;
  const make = async (targets: AtomicFileV1[]) => {
    const requestId = randomUUID();
    const preimages = await Promise.all(targets.map((file) => collections.notes(db).findOne({ _id: file.id })));
    const rows = targets.map((file, i) => remoteNoteRowSchema.parse({ id: file.id, kind: 'text', title: file.title, body: file.body,
      items: [], pinned: false, deleted: false, enc_v: 0, payload: null, base_version: preimages[i]?.localVersion ?? 0, created_at: file.createdAt }));
    const intents = rows.map((row, i) => noteWriteIntentSchema.parse({ _id: `${fixture.owner}:${requestId}:${row.id}`, format: 1,
      userId: fixture.owner, noteId: row.id, requestId, operationId: `${fixture.owner}:${requestId}`, fingerprint: fingerprintOf(rows, 'instant'),
      expectedVersion: row.base_version, expectedFileId: preimages[i]?.driveFileId ?? null, expectedHash: preimages[i]?.contentHash ?? null,
      stagedFileId: `synthetic-${randomUUID()}`, targetHash: noteContentHash(row), targetFlags: { kind: 'text', encV: 0, pinned: false, deleted: false },
      wipeEpoch: lease.wipeEpoch, leaseToken: lease.token, state: 'prepared', createdAt: now, updatedAt: now,
      committedVersion: null, committedSequence: null, terminalReason: null }));
    await beginRecoverySync(db, lease, requestId, rows, 'instant', intents);
    for (let i = 0; i < targets.length; i++) await stageRecoveryIntent(db, lease, intents[i]._id, sdk, 'synthetic-parent', targets[i]);
    return { requestId, rows, intents, targets, operationId: intents[0].operationId };
  };
  const snapshot = async () => ({ wallet: await collections.atomicUsers(db).findOne({ _id: fixture.owner }),
    ledger: await collections.energyLedger(db).find({ userId: fixture.owner }).sort({ _id: 1 }).toArray(),
    operations: await syncOperations(db).find({ userId: fixture.owner }).sort({ _id: 1 }).toArray(),
    journal: await journal.find({ userId: fixture.owner }).sort({ _id: 1 }).toArray(),
    notes: await collections.notes(db).find({ userId: fixture.owner }).sort({ _id: 1 }).toArray(), counter: await counters.findOne({ _id: fixture.owner }),
    gate: await db.collection<{ _id: string }>('note_sync_state').findOne({ _id: fixture.owner }) });
  const original = content(); await setCurrent(original, 'synthetic-original', 1);
  const first = await make([{ ...original, body: 'Public synthetic uncommitted edit' }]);
  const remote = { ...original, body: 'Public synthetic newer committed body' }; await setCurrent(remote, 'synthetic-newer', 2);
  const oldLease = lease; await releaseRecoveryLease(db, lease); lease = await acquireRecoveryLease(db, fixture.owner);
  phase = 'prior_api_refusals';
  await assert.rejects(adoptRecoveryOperation(db, lease, first.operationId), /recovery_preimage_changed/);
  await assert.rejects(finishRecoverySync(db, lease, first.operationId), /recovery_settlement_lease_mismatch/);
  phase = 'atomic_abandon_rollback';
  const before = await snapshot(), retained = structuredClone([...files]);
  await assert.rejects(abandonRecoverySync(db, lease, first.operationId, async () => { throw new Error('synthetic_abandon_barrier'); }), /synthetic_abandon_barrier/);
  assert.deepEqual(await snapshot(), before); assert.deepEqual([...files], retained);
  phase = 'full_failure_refund';
  const failed = await abandonRecoverySync(db, lease, first.operationId);
  assert.equal(failed.charged, 10); assert.equal(failed.refunded, 10); assert.equal(failed.results[0].ok, false);
  assert.equal((await collections.atomicUsers(db).findOne({ _id: fixture.owner }))!.energy, 100);
  assert.equal((await journal.findOne({ _id: first.intents[0]._id }))!.state, 'abandoned');
  assert.equal((await journal.findOne({ _id: first.intents[0]._id }))!.leaseToken, lease.token);
  assert.deepEqual(await collections.notes(db).findOne({ _id: original.id }), before.notes[0]);
  assert.equal((await counters.findOne({ _id: fixture.owner }))!.value, 2);
  const settled = await snapshot(); assert.deepEqual(await abandonRecoverySync(db, lease, first.operationId), failed);
  // A fence touch advances the gate, but the financial/receipt/content state is immutable.
  const repeated = await snapshot(); assert.deepEqual({ ...repeated, gate: null }, { ...settled, gate: null });
  await assert.rejects(commitRecoveryIntents(db, oldLease, [first.intents[0]._id], sdk, 'synthetic-parent'), /recovery_fence_lost/);
  await assert.rejects(stageRecoveryIntent(db, lease, first.intents[0]._id, sdk, 'synthetic-parent', first.targets[0]), /recovery_intent_not_stageable/);
  phase = 'partial_success_preserved';
  const partial = await make([content(), content()]);
  await commitRecoveryIntents(db, lease, [partial.intents[0]._id], sdk, 'synthetic-parent');
  const committed = await journal.findOne({ _id: partial.intents[0]._id }); assert.equal(committed!.committedVersion, 3);
  const otherRemote = { ...partial.targets[1], body: 'Public synthetic competing fresh note' };
  await setCurrent(otherRemote, 'synthetic-competing-fresh', 4);
  await releaseRecoveryLease(db, lease); lease = await acquireRecoveryLease(db, fixture.owner);
  await assert.rejects(adoptRecoveryOperation(db, lease, partial.operationId), /recovery_preimage_changed/);
  const partly = await abandonRecoverySync(db, lease, partial.operationId);
  assert.equal(partly.charged, 10); assert.equal(partly.refunded, 0);
  assert.deepEqual(partly.results.map((row) => row.ok), [true, false]);
  assert.deepEqual(await journal.findOne({ _id: partial.intents[0]._id }), committed);
  assert.equal((await journal.findOne({ _id: partial.intents[1]._id }))!.state, 'abandoned');
  assert.equal((await collections.notes(db).findOne({ _id: partial.rows[1].id }))!.driveFileId, 'synthetic-competing-fresh');
  assert.equal((await collections.atomicUsers(db).findOne({ _id: fixture.owner }))!.energy, 90);
  assert.equal(writes, 3); assert.equal(files.size, 6);
  phase = 'actual_pull_replay';
  await releaseRecoveryLease(db, lease); cleanup = undefined;
  const headers = { authorization: `Bearer ${FIXTURE_TOKENS.a}`, 'content-type': 'application/json' };
  const pull = await fetch(`${fixture.origin}/api/notes/pull?after=0`, { headers }); assert.equal(pull.status, 200);
  const page = await pull.json() as { nextCursor: number; rows: { id: string; body: string }[] };
  assert.equal(page.nextCursor, 4); assert.equal(page.rows.length, 3);
  for (const file of [remote, partial.targets[0], otherRemote]) assert.equal(page.rows.find((row) => row.id === file.id)!.body, file.body);
  const final = await snapshot(); const finalFiles = structuredClone([...files]);
  for (const [request, receipt] of [[first, failed], [partial, partly]] as const) {
    const response = await fetch(`${fixture.origin}/api/notes/push`, { method: 'POST', headers,
      body: JSON.stringify({ requestId: request.requestId, mode: 'instant', rows: request.rows }) });
    assert.equal(response.status, 502); const body = await response.json() as { results: unknown[]; charged: number; refunded: number };
    assert.deepEqual(body.results, receipt.results); assert.equal(body.charged, receipt.charged); assert.equal(body.refunded, receipt.refunded);
  }
  assert.deepEqual(await snapshot(), final); assert.deepEqual([...files], finalFiles); assert.equal(writes, 3);
  phase = 'complete'; passed = true;
});
