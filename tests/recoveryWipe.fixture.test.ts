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

test('inactive wipe rolls back atomically, fences a delayed writer and preserves monotonic refill versions', { timeout: 60000 }, async (t) => {
  let phase = 'setup', passed = false, writes = 0;
  t.after(() => writeFileSync('ci-recovery-wipe-proof.json', JSON.stringify({ version: 1,
    scope: 'disposable inactive wipe and delayed upload interleaving', phase, outcome: passed ? 'pass' : 'fail' })));
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
  let cleanupLease: (() => Promise<unknown>) | undefined, unblock: (() => void) | undefined;
  let delayedCompletion: Promise<unknown> | undefined;
  t.after(async () => { unblock?.(); try { await delayedCompletion; await cleanupLease?.(); } finally { await fixture.close(); } });
  const { getDb } = await import('../src/db/mongo.js');
  const { collections } = await import('../src/db/collections.js');
  const { acquireRecoveryLease, releaseRecoveryLease, withRecoveryWipe, withRecoveryFence } = await import('../src/lib/recoveryGate.js');
  const { fingerprintOf, syncOperations } = await import('../src/lib/syncOperation.js');
  const { beginRecoverySync } = await import('../src/lib/recoveryAdmission.js');
  const { stageRecoveryIntent } = await import('../src/lib/recoveryIntent.js');
  const { commitRecoveryIntents } = await import('../src/lib/recoveryCommit.js');
  const { finishRecoverySync, abandonRecoverySync } = await import('../src/lib/recoverySettlement.js');
  const db = await getDb(); assertFixtureCleanup(db.databaseName, fixture.database);
  let lease = await acquireRecoveryLease(db, fixture.owner), released = false;
  cleanupLease = () => released ? Promise.resolve() : releaseRecoveryLease(db, lease);
  await collections.googleAccounts(db).updateOne({ userId: fixture.owner }, { $set: { driveRootFolderId: 'synthetic-parent' } });
  const journal = db.collection<NoteWriteIntent>('note_write_intents');
  const now = new Date();
  let blockedId: string | undefined, announce: (() => void) | undefined;
  let paused: Promise<void> | undefined;
  const sdk = { files: {
    async create(params: { requestBody: { id: string }; media: { body: AsyncIterable<unknown> } }) {
      if (files.has(params.requestBody.id)) throw { code: 409 };
      let raw = ''; for await (const part of params.media.body) raw += String(part);
      if (params.requestBody.id === blockedId) { announce?.(); await paused; }
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
  const content = (id = randomUUID(), body = 'Public synthetic retained local body') => migrateAtomicFile({ version: 1, id,
    kind: 'text', title: 'Public synthetic wipe', body, items: [], pinned: false, encV: 0, payload: null,
    createdAt: now.toISOString(), updatedAt: now.toISOString() });
  const make = async (targets: AtomicFileV1[]) => {
    const requestId = randomUUID();
    const preimages = await Promise.all(targets.map((file) => collections.notes(db).findOne({ _id: file.id })));
    const rows = targets.map((file, i) => remoteNoteRowSchema.parse({ id: file.id, kind: 'text', title: file.title, body: file.body,
      items: [], pinned: false, deleted: false, enc_v: 0, payload: null, base_version: preimages[i]?.localVersion ?? 0, created_at: file.createdAt }));
    const intents = rows.map((row, i) => noteWriteIntentSchema.parse({ _id: `${fixture.owner}:${requestId}:${row.id}`,
      format: 1, userId: fixture.owner, noteId: row.id, requestId, operationId: `${fixture.owner}:${requestId}`,
      fingerprint: fingerprintOf(rows, 'instant'), expectedVersion: row.base_version,
      expectedFileId: preimages[i]?.driveFileId ?? null, expectedHash: preimages[i]?.contentHash ?? null,
      stagedFileId: `synthetic-${randomUUID()}`, targetHash: noteContentHash(row),
      targetFlags: { kind: 'text', encV: 0, pinned: false, deleted: false }, wipeEpoch: lease.wipeEpoch,
      leaseToken: lease.token, state: 'prepared', createdAt: now, updatedAt: now,
      committedVersion: null, committedSequence: null, terminalReason: null }));
    return { requestId, targets, rows, intents, operationId: intents[0].operationId };
  };
  const financial = async () => ({ wallet: await collections.atomicUsers(db).findOne({ _id: fixture.owner }),
    ledger: await collections.energyLedger(db).find({ userId: fixture.owner }).sort({ _id: 1 }).toArray() });
  const snapshot = async () => ({ financial: await financial(),
    operations: await syncOperations(db).find({ userId: fixture.owner }).sort({ _id: 1 }).toArray(),
    intents: await journal.find({ userId: fixture.owner }).sort({ _id: 1 }).toArray(),
    notes: await collections.notes(db).find({ userId: fixture.owner }).sort({ _id: 1 }).toArray(),
    gate: await db.collection<{ _id: string }>('note_sync_state').findOne({ _id: fixture.owner }),
    counter: await db.collection<{ _id: string }>('sync_counters').findOne({ _id: fixture.owner }) });
  const counters = db.collection<{ _id: string; value: number }>('sync_counters');
  const other = content(); files.set('synthetic-other-owner', other);
  await collections.notes(db).insertOne({ _id: other.id, userId: fixture.other, folderId: null, kind: 'text', pinned: false,
    deleted: false, encV: 0, driveFileId: 'synthetic-other-owner', driveRevisionId: null, localVersion: 1, syncSequence: 1,
    contentHash: noteContentHash({ ...other, enc_v: 0 }), syncStatus: 'synced', createdAt: now, updatedAt: now, lastSyncedAt: now });
  await counters.insertOne({ _id: fixture.other, value: 1 });
  const otherBefore = await collections.notes(db).findOne({ _id: other.id });
  const local = content(); const initial = await make([local]);
  await beginRecoverySync(db, lease, initial.requestId, initial.rows, 'instant', initial.intents);
  await stageRecoveryIntent(db, lease, initial.intents[0]._id, sdk, 'synthetic-parent', initial.targets[0]);
  await commitRecoveryIntents(db, lease, [initial.intents[0]._id], sdk, 'synthetic-parent');
  await finishRecoverySync(db, lease, initial.operationId);
  assert.equal((await counters.findOne({ _id: fixture.owner }))!.value, 1);
  phase = 'paused_upload';
  const pending = await make([{ ...local, body: 'Public synthetic delayed pre-wipe edit' }]);
  await beginRecoverySync(db, lease, pending.requestId, pending.rows, 'instant', pending.intents);
  blockedId = pending.intents[0].stagedFileId!;
  const started = new Promise<void>((resolve) => { announce = resolve; });
  paused = new Promise<void>((resolve) => { unblock = resolve; });
  const obsoleteLease = lease;
  const delayed = stageRecoveryIntent(db, obsoleteLease, pending.intents[0]._id, sdk, 'synthetic-parent', pending.targets[0])
    .then(() => ({ ok: true, error: undefined }), (error: unknown) => ({ ok: false, error }));
  delayedCompletion = delayed;
  await started;
  lease = await acquireRecoveryLease(db, fixture.owner, () => new Date(obsoleteLease.expiresAt.getTime() + 1));
  const aborted = await abandonRecoverySync(db, lease, pending.operationId);
  assert.equal(aborted.refunded, 10); assert.equal((await financial()).wallet!.energy, 90);
  phase = 'wipe_rollback';
  const before = await snapshot(), filesBefore = structuredClone([...files]);
  await assert.rejects(withRecoveryWipe(db, lease, async (session) => {
    await collections.notes(db).deleteMany({ userId: fixture.owner }, { session });
    throw new Error('synthetic_wipe_barrier');
  }), /synthetic_wipe_barrier/);
  assert.deepEqual(await snapshot(), before); assert.deepEqual([...files], filesBefore);
  phase = 'wipe_commit';
  const preWipeLease = lease;
  lease = await withRecoveryWipe(db, lease, async (session) => {
    await collections.notes(db).deleteMany({ userId: fixture.owner }, { session });
  });
  assert.equal(lease.wipeEpoch, preWipeLease.wipeEpoch + 1);
  assert.equal(await collections.notes(db).countDocuments({ userId: fixture.owner }), 0);
  assert.equal((await counters.findOne({ _id: fixture.owner }))!.value, 1);
  assert.deepEqual(await collections.notes(db).findOne({ _id: other.id }), otherBefore);
  assert.deepEqual([...files], filesBefore);
  let staleCallback = false;
  await assert.rejects(withRecoveryFence(db, preWipeLease, async () => { staleCallback = true; }), /recovery_fence_lost/);
  assert.equal(staleCallback, false);
  phase = 'late_upload_refused';
  unblock!(); unblock = undefined;
  const oldResult = await delayed; assert.equal(oldResult.ok, false); assert.match(String(oldResult.error), /recovery_fence_lost/);
  assert.equal((await journal.findOne({ _id: pending.intents[0]._id }))!.state, 'abandoned');
  assert.equal(await collections.notes(db).countDocuments({ userId: fixture.owner }), 0);
  assert.equal(writes, 2);
  const auth = { authorization: `Bearer ${FIXTURE_TOKENS.a}`, 'content-type': 'application/json' };
  const empty = await fetch(`${fixture.origin}/api/notes/pull?after=0`, { headers: auth }); assert.equal(empty.status, 200);
  const emptyPage = await empty.json() as { rows: unknown[]; nextCursor: number };
  assert.deepEqual(emptyPage.rows, []); assert.equal(emptyPage.nextCursor, 1);
  phase = 'monotonic_refill';
  blockedId = undefined;
  const refill = await make([{ ...local, body: 'Public synthetic local edit after wipe' }]);
  assert.equal(refill.rows[0].base_version, 0);
  await beginRecoverySync(db, lease, refill.requestId, refill.rows, 'instant', refill.intents);
  await stageRecoveryIntent(db, lease, refill.intents[0]._id, sdk, 'synthetic-parent', refill.targets[0]);
  const saved = await commitRecoveryIntents(db, lease, [refill.intents[0]._id], sdk, 'synthetic-parent');
  assert.equal(saved.get(local.id)!.localVersion, 2); assert.equal(saved.get(local.id)!.syncSequence, 2);
  const completed = await finishRecoverySync(db, lease, refill.operationId);
  assert.equal(completed.charged, 10); assert.equal(completed.refunded, 0);
  assert.equal((await financial()).wallet!.energy, 80); assert.equal(writes, 3); assert.equal(files.size, 4);
  await releaseRecoveryLease(db, lease); released = true;
  phase = 'stale_client_conflict';
  const beforeStale = await financial();
  const stale = await fetch(`${fixture.origin}/api/notes/push`, { method: 'POST', headers: auth,
    body: JSON.stringify({ requestId: randomUUID(), mode: 'instant', rows: [{ ...initial.rows[0], base_version: 1, body: 'Public synthetic stale offline edit' }] }) });
  assert.equal(stale.status, 502);
  const staleBody = await stale.json() as { results: { error: string; version: number }[]; charged: number; refunded: number };
  assert.equal(staleBody.results[0].error, 'note_conflict'); assert.equal(staleBody.results[0].version, 2);
  assert.equal(staleBody.charged, 10); assert.equal(staleBody.refunded, 10);
  const afterStale = await financial(); assert.deepEqual(afterStale.wallet, beforeStale.wallet);
  assert.equal(afterStale.ledger.length, beforeStale.ledger.length + 2); assert.equal(writes, 3);
  phase = 'actual_pull_replay';
  const pull = await fetch(`${fixture.origin}/api/notes/pull?after=1`, { headers: auth }); assert.equal(pull.status, 200);
  const page = await pull.json() as { rows: { id: string; body: string; version: number }[]; nextCursor: number };
  assert.equal(page.nextCursor, 2); assert.equal(page.rows.length, 1); assert.equal(page.rows[0].id, local.id);
  assert.equal(page.rows[0].body, refill.targets[0].body); assert.equal(page.rows[0].version, 2);
  assert.deepEqual(await collections.notes(db).findOne({ _id: other.id }), otherBefore);
  const final = await snapshot(), finalFiles = structuredClone([...files]);
  for (const [request, receipt, status] of [[pending, aborted, 502], [refill, completed, 200]] as const) {
    const response = await fetch(`${fixture.origin}/api/notes/push`, { method: 'POST', headers: auth,
      body: JSON.stringify({ requestId: request.requestId, mode: 'instant', rows: request.rows }) });
    assert.equal(response.status, status);
    const body = await response.json() as { results: unknown[]; charged: number; refunded: number };
    assert.deepEqual(body.results, receipt.results); assert.equal(body.charged, receipt.charged); assert.equal(body.refunded, receipt.refunded);
  }
  assert.deepEqual(await snapshot(), final); assert.deepEqual([...files], finalFiles); assert.equal(writes, 3);
  phase = 'complete'; passed = true;
});
