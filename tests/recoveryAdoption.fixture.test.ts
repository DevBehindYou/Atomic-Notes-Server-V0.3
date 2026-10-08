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

test('partial commit and delayed old writer recover under a new lease without a second debit or generation', { timeout: 60000 }, async (t) => {
  let phase = 'setup', passed = false, writes = 0;
  t.after(() => writeFileSync('ci-recovery-adoption-proof.json', JSON.stringify({ version: 1,
    scope: 'disposable inactive partial commit and delayed writer adoption', phase, outcome: passed ? 'pass' : 'fail' })));
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
  const { acquireRecoveryLease, releaseRecoveryLease } = await import('../src/lib/recoveryGate.js');
  const { fingerprintOf, syncOperations } = await import('../src/lib/syncOperation.js');
  const { beginRecoverySync } = await import('../src/lib/recoveryAdmission.js');
  const { prepareRecoveryIntents, stageRecoveryIntent } = await import('../src/lib/recoveryIntent.js');
  const { commitRecoveryIntents } = await import('../src/lib/recoveryCommit.js');
  const { finishRecoverySync } = await import('../src/lib/recoverySettlement.js');
  const { adoptRecoveryOperation } = await import('../src/lib/recoveryAdoption.js');
  const { readNoteGenerationWith } = await import('../src/lib/driveGeneration.js');
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
  const make = (count: number) => {
    const requestId = randomUUID();
    const targets = Array.from({ length: count }, () => migrateAtomicFile({ version: 1, id: randomUUID(), kind: 'text',
      title: 'Public synthetic adoption', body: 'Public synthetic retained generation', items: [], pinned: false,
      encV: 0, payload: null, createdAt: now.toISOString(), updatedAt: now.toISOString() }));
    const rows = targets.map((file) => remoteNoteRowSchema.parse({ id: file.id, kind: 'text', title: file.title, body: file.body,
      items: [], pinned: false, deleted: false, enc_v: 0, payload: null, base_version: 0, created_at: file.createdAt }));
    const intents = rows.map((row) => noteWriteIntentSchema.parse({ _id: `${fixture.owner}:${requestId}:${row.id}`,
      format: 1, userId: fixture.owner, noteId: row.id, requestId, operationId: `${fixture.owner}:${requestId}`,
      fingerprint: fingerprintOf(rows, 'instant'), expectedVersion: 0, expectedFileId: null, expectedHash: null,
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
  const first = make(2);
  await beginRecoverySync(db, lease, first.requestId, first.rows, 'instant', first.intents);
  for (let i = 0; i < 2; i++) await stageRecoveryIntent(db, lease, first.intents[i]._id, sdk, 'synthetic-parent', first.targets[i]);
  await commitRecoveryIntents(db, lease, [first.intents[0]._id], sdk, 'synthetic-parent');
  const committed = await journal.findOne({ _id: first.intents[0]._id }); assert.equal(committed!.state, 'committed');
  const charged = await financial(); assert.equal(charged.wallet!.energy, 90); assert.equal(writes, 2);
  phase = 'prior_api_refusal';
  const oldLease = lease; await releaseRecoveryLease(db, lease); lease = await acquireRecoveryLease(db, fixture.owner);
  await assert.rejects(prepareRecoveryIntents(db, lease, first.intents.map((row) => ({ ...row, leaseToken: lease.token }))), /recovery_row_already_settled/);
  await assert.rejects(finishRecoverySync(db, lease, first.operationId), /recovery_settlement_lease_mismatch/);
  phase = 'adoption_rollback';
  const before = await snapshot();
  await assert.rejects(adoptRecoveryOperation(db, lease, first.operationId, async () => { throw new Error('synthetic_adoption_barrier'); }), /synthetic_adoption_barrier/);
  assert.deepEqual(await snapshot(), before);
  phase = 'partial_resume';
  const adopted = await adoptRecoveryOperation(db, lease, first.operationId);
  assert.deepEqual(adopted[0], committed); assert.equal(adopted[1].leaseToken, lease.token);
  assert.equal(adopted[1].stagedFileId, first.intents[1].stagedFileId);
  await assert.rejects(commitRecoveryIntents(db, oldLease, [first.intents[1]._id], sdk, 'synthetic-parent'), /recovery_fence_lost/);
  // Recover the content from the retained generation, not an in-memory client row.
  await stageRecoveryIntent(db, lease, adopted[1]._id, sdk, 'synthetic-parent', await readNoteGenerationWith(sdk, adopted[1].stagedFileId!, 'synthetic-parent'));
  await commitRecoveryIntents(db, lease, [adopted[1]._id], sdk, 'synthetic-parent');
  const complete = await finishRecoverySync(db, lease, first.operationId);
  assert.equal(complete.charged, 10); assert.equal(complete.refunded, 0);
  assert.deepEqual(complete.results.map((row) => row.version), [1, 2]);
  assert.deepEqual(await journal.findOne({ _id: first.intents[0]._id }), committed);
  assert.deepEqual(await financial(), charged); assert.equal(writes, 2);
  phase = 'delayed_old_writer';
  const second = make(1);
  await beginRecoverySync(db, lease, second.requestId, second.rows, 'instant', second.intents);
  blockedId = second.intents[0].stagedFileId!;
  const started = new Promise<void>((resolve) => { announce = resolve; });
  paused = new Promise<void>((resolve) => { unblock = resolve; });
  const delayedLease = lease;
  const delayed = stageRecoveryIntent(db, delayedLease, second.intents[0]._id, sdk, 'synthetic-parent', second.targets[0])
    .then(() => ({ ok: true, error: undefined }), (error: unknown) => ({ ok: false, error }));
  delayedCompletion = delayed;
  await started;
  // Deterministic clock jump tests token handoff; not an actual process crash or ten-minute wait.
  lease = await acquireRecoveryLease(db, fixture.owner, () => new Date(delayedLease.expiresAt.getTime() + 1));
  await adoptRecoveryOperation(db, lease, second.operationId);
  unblock!(); unblock = undefined;
  const obsolete = await delayed; assert.equal(obsolete.ok, false);
  assert.match(String(obsolete.error), /recovery_fence_lost/);
  assert.equal((await journal.findOne({ _id: second.intents[0]._id }))!.state, 'prepared');
  assert.equal(await collections.notes(db).countDocuments({ _id: second.rows[0].id }), 0);
  assert.equal(await releaseRecoveryLease(db, delayedLease), false);
  phase = 'retained_generation_retry';
  blockedId = undefined;
  await stageRecoveryIntent(db, lease, second.intents[0]._id, sdk, 'synthetic-parent', await readNoteGenerationWith(sdk, second.intents[0].stagedFileId!, 'synthetic-parent'));
  await commitRecoveryIntents(db, lease, [second.intents[0]._id], sdk, 'synthetic-parent');
  const finished = await finishRecoverySync(db, lease, second.operationId);
  assert.equal(finished.charged, 10); assert.equal(finished.refunded, 0); assert.equal(finished.results[0].seq, 3);
  assert.equal(writes, 3); assert.equal(files.size, 3);
  assert.equal((await collections.atomicUsers(db).findOne({ _id: fixture.owner }))!.energy, 80);
  phase = 'actual_pull_replay';
  await releaseRecoveryLease(db, lease); released = true;
  const auth = { authorization: `Bearer ${FIXTURE_TOKENS.a}` };
  const pull = await fetch(`${fixture.origin}/api/notes/pull?after=0`, { headers: auth }); assert.equal(pull.status, 200);
  const page = await pull.json() as { nextCursor: number; rows: { id: string; body: string }[] };
  assert.equal(page.nextCursor, 3); assert.equal(page.rows.length, 3);
  for (const file of [...first.targets, ...second.targets]) assert.equal(page.rows.find((row) => row.id === file.id)!.body, file.body);
  const final = await snapshot();
  for (const [request, receipt] of [[first, complete], [second, finished]] as const) {
    const response = await fetch(`${fixture.origin}/api/notes/push`, { method: 'POST', headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify({ requestId: request.requestId, mode: 'instant', rows: request.rows }) });
    assert.equal(response.status, 200);
    const body = await response.json() as { results: unknown[]; charged: number; refunded: number };
    assert.deepEqual(body.results, receipt.results); assert.equal(body.charged, 10); assert.equal(body.refunded, 0);
  }
  assert.deepEqual(await snapshot(), final); assert.equal(writes, 3);
  phase = 'complete'; passed = true;
});
