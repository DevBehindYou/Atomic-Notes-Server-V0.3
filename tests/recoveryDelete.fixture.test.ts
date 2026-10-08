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

test('inactive delete and restore retain content across rollback and lease handoff and refuse stale deletion', { timeout: 60000 }, async (t) => {
  let phase = 'setup', passed = false, writes = 0;
  t.after(() => writeFileSync('ci-recovery-delete-proof.json', JSON.stringify({ version: 1,
    scope: 'disposable inactive immutable delete and restore', phase, outcome: passed ? 'pass' : 'fail' })));
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
  const { adoptRecoveryOperation } = await import('../src/lib/recoveryAdoption.js');
  const { beginRecoverySync } = await import('../src/lib/recoveryAdmission.js');
  const { stageRecoveryIntent } = await import('../src/lib/recoveryIntent.js');
  const { commitRecoveryIntents } = await import('../src/lib/recoveryCommit.js');
  const { finishRecoverySync } = await import('../src/lib/recoverySettlement.js');
  const db = await getDb(); assertFixtureCleanup(db.databaseName, fixture.database);
  let lease = await acquireRecoveryLease(db, fixture.owner);
  cleanupLease = () => releaseRecoveryLease(db, lease);
  await collections.googleAccounts(db).updateOne({ userId: fixture.owner }, { $set: { driveRootFolderId: 'synthetic-parent' } });
  const journal = db.collection<NoteWriteIntent>('note_write_intents');
  const counters = db.collection<{ _id: string; value: number }>('sync_counters');
  const now = new Date();
  const sdk = { files: {
    async create(params: { requestBody: { id: string }; media: { body: AsyncIterable<unknown> } }) {
      if (files.has(params.requestBody.id)) throw { code: 409 };
      let raw = ''; for await (const part of params.media.body) raw += String(part);
      files.set(params.requestBody.id, migrateAtomicFile(JSON.parse(raw))); writes++;
      return { data: { id: params.requestBody.id } };
    },
    async get(params: { fileId: string; alt?: string }) {
      if (!files.has(params.fileId)) throw { code: 404 };
      return { data: params.alt === 'media' ? structuredClone(files.get(params.fileId)) : {
        id: params.fileId, parents: ['synthetic-parent'], mimeType: 'application/json', trashed: false } };
    },
    async update() { throw new Error('must_not_overwrite'); }, async delete() { throw new Error('must_not_delete'); },
  } } as unknown as drive_v3.Drive;
  const content = (i: number) => migrateAtomicFile({ version: 1, id: randomUUID(),
    kind: i % 3 === 1 ? 'todo' : 'text', title: i % 3 === 2 ? '' : `Public synthetic batch ${i}`,
    body: i % 3 === 0 ? `Public synthetic batch body ${i}` : '',
    items: i % 3 === 1 ? [{ text: `Public synthetic checklist ${i}`, done: i % 2 === 0 }] : [],
    pinned: i % 2 === 0, encV: i % 3 === 2 ? 1 : 0,
    // Opaque schema-valid public test payload, not native encryption proof.
    payload: i % 3 === 2 ? `public-synthetic-envelope-${i}` : null,
    createdAt: now.toISOString(), updatedAt: now.toISOString() });
  const make = async (targets: AtomicFileV1[], deleted = false) => {
    const requestId = randomUUID();
    const preimages = await Promise.all(targets.map((file) => collections.notes(db).findOne({ _id: file.id })));
    const rows = targets.map((file, i) => remoteNoteRowSchema.parse({ id: file.id, kind: file.kind, title: file.title,
      body: file.body, items: file.items, pinned: file.pinned, deleted, enc_v: file.encV, payload: file.payload,
      base_version: preimages[i]?.localVersion ?? 0, created_at: file.createdAt }));
    const intents = rows.map((row, i) => noteWriteIntentSchema.parse({ _id: `${fixture.owner}:${requestId}:${row.id}`,
      format: 1, userId: fixture.owner, noteId: row.id, requestId, operationId: `${fixture.owner}:${requestId}`,
      fingerprint: fingerprintOf(rows, 'instant'), expectedVersion: row.base_version,
      expectedFileId: preimages[i]?.driveFileId ?? null, expectedHash: preimages[i]?.contentHash ?? null,
      stagedFileId: `synthetic-${randomUUID()}`, targetHash: noteContentHash(row),
      targetFlags: { kind: row.kind, encV: row.enc_v, pinned: row.pinned, deleted: row.deleted }, wipeEpoch: lease.wipeEpoch,
      leaseToken: lease.token, state: 'prepared', createdAt: now, updatedAt: now,
      committedVersion: null, committedSequence: null, terminalReason: null }));
    return { requestId, targets, rows, intents, operationId: intents[0].operationId };
  };
  const admitAndStage = async (request: Awaited<ReturnType<typeof make>>) => {
    await beginRecoverySync(db, lease, request.requestId, request.rows, 'instant', request.intents);
    for (let i = 0; i < request.intents.length; i++) {
      await stageRecoveryIntent(db, lease, request.intents[i]._id, sdk, 'synthetic-parent', request.targets[i]);
    }
  };
  const snapshot = async () => ({
    notes: await collections.notes(db).find({ userId: fixture.owner }).sort({ _id: 1 }).toArray(),
    counter: await counters.findOne({ _id: fixture.owner }),
    operations: await syncOperations(db).find({ userId: fixture.owner }).sort({ _id: 1 }).toArray(),
    intents: await journal.find({ userId: fixture.owner }).sort({ _id: 1 }).toArray(),
    wallet: await collections.atomicUsers(db).findOne({ _id: fixture.owner }),
    ledger: await collections.energyLedger(db).find({ userId: fixture.owner }).sort({ _id: 1 }).toArray(),
  });
  const originals = [content(0), content(2)];
  const initial = await make(originals); await admitAndStage(initial);
  await commitRecoveryIntents(db, lease, initial.intents.map((row) => row._id), sdk, 'synthetic-parent');
  await finishRecoverySync(db, lease, initial.operationId);
  // Offline edits may coexist with deletion. Preserve the requested latest
  // plaintext/cipher envelope, not a guessed copy of the preimage.
  const deletedContent = originals.map((file) => ({ ...file,
    body: file.encV === 0 ? `${file.body} edited before deletion` : '',
    payload: file.encV === 1 ? `${file.payload}-edited-before-deletion` : null }));
  const deleting = await make(deletedContent, true);
  phase = 'flag_mismatch_refusal';
  const beforeInvalid = await snapshot();
  await assert.rejects(beginRecoverySync(db, lease, deleting.requestId, deleting.rows, 'instant',
    deleting.intents.map((row) => ({ ...row, targetFlags: { ...row.targetFlags, deleted: false } }))),
    /recovery_admission_manifest_invalid/);
  assert.deepEqual(await snapshot(), beforeInvalid); assert.equal(writes, 2);
  await admitAndStage(deleting);
  phase = 'delete_rollback';
  const beforeDelete = await snapshot(), filesBefore = structuredClone([...files]);
  await assert.rejects(commitRecoveryIntents(db, lease, deleting.intents.map((row) => row._id), sdk, 'synthetic-parent', async () => {
    throw new Error('synthetic_delete_commit_barrier');
  }), /synthetic_delete_commit_barrier/);
  assert.deepEqual(await snapshot(), beforeDelete); assert.deepEqual([...files], filesBefore);
  assert.equal(beforeDelete.notes.every((note) => !note.deleted), true);
  phase = 'delete_lease_handoff';
  const priorLease = lease;
  lease = await acquireRecoveryLease(db, fixture.owner, () => new Date(priorLease.expiresAt.getTime() + 1));
  const adopted = await adoptRecoveryOperation(db, lease, deleting.operationId);
  assert.equal(adopted.length, 2); assert.equal(adopted.every((row) => row.targetFlags.deleted && row.state === 'verified' && row.leaseToken === lease.token), true);
  assert.deepEqual(adopted.map((row) => row.stagedFileId), deleting.intents.map((row) => row.stagedFileId));
  await assert.rejects(commitRecoveryIntents(db, priorLease, deleting.intents.map((row) => row._id), sdk, 'synthetic-parent'), /recovery_fence_lost/);
  for (let i = 0; i < adopted.length; i++) await stageRecoveryIntent(db, lease, adopted[i]._id, sdk, 'synthetic-parent', deletedContent[i]);
  assert.equal(writes, 4);
  const tombstones = await commitRecoveryIntents(db, lease, adopted.map((row) => row._id), sdk, 'synthetic-parent');
  const deletedReceipt = await finishRecoverySync(db, lease, deleting.operationId);
  assert.equal(deletedReceipt.charged, 10); assert.equal(deletedReceipt.refunded, 0);
  for (let i = 0; i < originals.length; i++) {
    const note = tombstones.get(originals[i].id)!;
    assert.equal(note.deleted, true); assert.equal(note.localVersion, i + 2); assert.equal(note.syncSequence, i + 3);
    assert.deepEqual(files.get(initial.intents[i].stagedFileId!), originals[i]);
  }
  const auth = { authorization: `Bearer ${FIXTURE_TOKENS.a}`, 'content-type': 'application/json' };
  const checkPull = async (expected: AtomicFileV1[], deleted: boolean, firstVersion: number, cursor: number) => {
    const response = await fetch(`${fixture.origin}/api/notes/pull?after=0`, { headers: auth }); assert.equal(response.status, 200);
    const page = await response.json() as { rows: { id: string; body: string; payload: string | null; deleted: boolean; enc_v: number; version: number }[]; nextCursor: number };
    assert.equal(page.rows.length, 2); assert.equal(page.nextCursor, cursor);
    for (let i = 0; i < expected.length; i++) {
      const row = page.rows.find((item) => item.id === expected[i].id)!; assert.ok(row);
      assert.equal(row.deleted, deleted); assert.equal(row.body, expected[i].body); assert.equal(row.payload, expected[i].payload);
      assert.equal(row.enc_v, expected[i].encV); assert.equal(row.version, firstVersion + i);
    }
  };
  phase = 'tombstone_pull'; await checkPull(deletedContent, true, 2, 4);
  const restoring = await make(deletedContent, false); await admitAndStage(restoring);
  phase = 'restore_rollback';
  const beforeRestore = await snapshot(), restoreFiles = structuredClone([...files]);
  await assert.rejects(commitRecoveryIntents(db, lease, restoring.intents.map((row) => row._id), sdk, 'synthetic-parent', async () => {
    throw new Error('synthetic_restore_commit_barrier');
  }), /synthetic_restore_commit_barrier/);
  assert.deepEqual(await snapshot(), beforeRestore); assert.deepEqual([...files], restoreFiles);
  await checkPull(deletedContent, true, 2, 4);
  phase = 'restore_commit';
  const restored = await commitRecoveryIntents(db, lease, restoring.intents.map((row) => row._id), sdk, 'synthetic-parent');
  const restoredReceipt = await finishRecoverySync(db, lease, restoring.operationId);
  assert.equal(restoredReceipt.charged, 10); assert.equal(restoredReceipt.refunded, 0);
  for (let i = 0; i < originals.length; i++) {
    assert.equal(restored.get(originals[i].id)!.deleted, false);
    assert.equal(restored.get(originals[i].id)!.localVersion, i + 3); assert.equal(restored.get(originals[i].id)!.syncSequence, i + 5);
    assert.deepEqual(files.get(deleting.intents[i].stagedFileId!), deletedContent[i]);
  }
  await releaseRecoveryLease(db, lease); cleanupLease = undefined;
  phase = 'stale_delete_refusal';
  const beforeStale = await snapshot();
  const response = await fetch(`${fixture.origin}/api/notes/push`, { method: 'POST', headers: auth,
    body: JSON.stringify({ requestId: randomUUID(), mode: 'instant', rows: deleting.rows }) });
  assert.equal(response.status, 502);
  const stale = await response.json() as { results: { id: string; error: string; version: number }[]; charged: number; refunded: number };
  assert.equal(stale.results.length, 2); assert.equal(stale.charged, 10); assert.equal(stale.refunded, 10);
  for (let i = 0; i < originals.length; i++) {
    const result = stale.results.find((row) => row.id === originals[i].id)!;
    assert.equal(result.error, 'note_conflict'); assert.equal(result.version, i + 3);
  }
  const afterStale = await snapshot(); assert.deepEqual(afterStale.notes, beforeStale.notes);
  assert.deepEqual(afterStale.wallet, beforeStale.wallet); assert.equal(afterStale.ledger.length, beforeStale.ledger.length + 2);
  assert.equal(afterStale.counter!.value, 6); assert.equal(writes, 6); assert.equal(files.size, 6);
  phase = 'actual_pull_replay'; await checkPull(deletedContent, false, 3, 6);
  const final = await snapshot(), finalFiles = structuredClone([...files]);
  for (const [request, receipt] of [[deleting, deletedReceipt], [restoring, restoredReceipt]] as const) {
    const replay = await fetch(`${fixture.origin}/api/notes/push`, { method: 'POST', headers: auth,
      body: JSON.stringify({ requestId: request.requestId, mode: 'instant', rows: request.rows }) });
    assert.equal(replay.status, 200);
    const body = await replay.json() as { results: unknown[]; charged: number; refunded: number };
    assert.deepEqual(body.results, receipt.results); assert.equal(body.charged, 10); assert.equal(body.refunded, 0);
  }
  assert.deepEqual(await snapshot(), final); assert.deepEqual([...files], finalFiles);
  assert.equal(final.wallet!.energy, 70); assert.equal(writes, 6);
  phase = 'complete'; passed = true;
});
