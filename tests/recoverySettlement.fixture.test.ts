import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import type { drive_v3 } from 'googleapis';
import { noteWriteIntentSchema, type NoteWriteIntent } from '../src/db/recoveryContract.js';
import { noteContentHash } from '../src/lib/contentHash.js';
import { migrateAtomicFile, type AtomicFileV1 } from '../src/types/atomicFile.js';
import { remoteNoteRowSchema } from '../src/types/noteWire.js';
import { startClientFixture, FIXTURE_TOKENS, FIXTURE_ADMIN_KEY } from './clientFixture.js';
import { assertFixtureCleanup } from './clientFixtureSafety.js';

test('inactive recovery settlement rolls back refund and journal together, caps refunds and preserves committed success', { timeout: 60000 }, async (t) => {
  let phase = 'setup', passed = false;
  t.after(() => writeFileSync('ci-recovery-settlement-proof.json', JSON.stringify({ version: 1,
    scope: 'disposable inactive recovery terminal settlement and refund', phase, outcome: passed ? 'pass' : 'fail' })));
  const fixture = await startClientFixture(process.env.MONGODB_URI, process.env.MONGODB_DB_NAME);
  let release: (() => Promise<unknown>) | undefined;
  t.after(async () => { try { await release?.(); } finally { await fixture.close(); } });
  const { getDb } = await import('../src/db/mongo.js');
  const { collections } = await import('../src/db/collections.js');
  const { acquireRecoveryLease, releaseRecoveryLease } = await import('../src/lib/recoveryGate.js');
  const { openSync, syncOperations } = await import('../src/lib/syncOperation.js');
  const { prepareRecoveryIntents, stageRecoveryIntent } = await import('../src/lib/recoveryIntent.js');
  const { commitRecoveryIntents } = await import('../src/lib/recoveryCommit.js');
  const { finishRecoverySync } = await import('../src/lib/recoverySettlement.js');
  const db = await getDb(); assertFixtureCleanup(db.databaseName, fixture.database);
  const journal = db.collection<NoteWriteIntent>('note_write_intents');
  const now = new Date();
  const files = new Map<string, AtomicFileV1>(); let writes = 0;
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
  const call = (body: object) => fetch(`${fixture.origin}/api/notes/push`, { method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${FIXTURE_TOKENS.a}` }, body: JSON.stringify(body) });
  const snapshot = async () => ({ wallet: await collections.atomicUsers(db).findOne({ _id: fixture.owner }),
    ledger: await collections.energyLedger(db).find({ userId: fixture.owner }).sort({ _id: 1 }).toArray(),
    operations: await syncOperations(db).find({ userId: fixture.owner }).sort({ _id: 1 }).toArray(),
    journal: await journal.find({ userId: fixture.owner }).sort({ _id: 1 }).toArray(),
    notes: await collections.notes(db).find({ userId: fixture.owner }).sort({ _id: 1 }).toArray(),
    counter: await db.collection<{ _id: string; value: number }>('sync_counters').findOne({ _id: fixture.owner }) });
  const lease = await acquireRecoveryLease(db, fixture.owner);
  release = () => releaseRecoveryLease(db, lease);
  const prepare = async (count: number, mode: 'standard' | 'instant') => {
    const requestId = randomUUID();
    const targets = Array.from({ length: count }, () => migrateAtomicFile({ version: 1, id: randomUUID(), kind: 'text',
      title: 'Public synthetic settlement', body: 'Public synthetic offline body', items: [], pinned: false,
      encV: 0, payload: null, createdAt: now.toISOString(), updatedAt: now.toISOString() }));
    const rows = targets.map((file) => remoteNoteRowSchema.parse({ id: file.id, kind: 'text', title: file.title, body: file.body,
      items: [], pinned: false, deleted: false, enc_v: 0, payload: null, base_version: 0, created_at: file.createdAt }));
    const operation = await openSync(db, fixture.owner, requestId, rows, mode);
    // Debit/format registration/preparation are separate synthetic assembly steps.
    await syncOperations(db).updateOne({ _id: operation._id }, { $set: { recoveryFormat: 1 } });
    const intents = targets.map((file) => noteWriteIntentSchema.parse({ _id: `${fixture.owner}:${requestId}:${file.id}`,
      format: 1, userId: fixture.owner, noteId: file.id, requestId, operationId: operation._id, fingerprint: operation.fingerprint,
      expectedVersion: 0, expectedFileId: null, expectedHash: null, stagedFileId: `synthetic-${randomUUID()}`,
      targetHash: noteContentHash({ ...file, enc_v: 0 }), targetFlags: { kind: 'text', encV: 0, pinned: false, deleted: false },
      wipeEpoch: lease.wipeEpoch, leaseToken: lease.token, state: 'prepared', createdAt: now, updatedAt: now,
      committedVersion: null, committedSequence: null, terminalReason: null }));
    await prepareRecoveryIntents(db, lease, intents);
    return { requestId, targets, rows, operation, intents, mode };
  };
  phase = 'capped_setup';
  const failed = await prepare(1, 'standard');
  assert.equal((await collections.atomicUsers(db).findOne({ _id: fixture.owner }))!.energy, 95);
  const grant = await fetch(`${fixture.origin}/api/admin/energy`, { method: 'POST',
    headers: { 'content-type': 'application/json', 'x-admin-api-key': FIXTURE_ADMIN_KEY },
    body: JSON.stringify({ user_id: fixture.owner, energy_delta: 23 }) });
  assert.equal(grant.status, 200);
  assert.equal((await collections.atomicUsers(db).findOne({ _id: fixture.owner }))!.energy, 118);
  const before = await snapshot();
  phase = 'journal_validation_rollback';
  await db.command({ collMod: 'note_write_intents', validator: { state: { $ne: 'abandoned' } }, validationLevel: 'strict', validationAction: 'error' });
  await assert.rejects(finishRecoverySync(db, lease, failed.operation._id),
    (error: unknown) => typeof error === 'object' && error !== null && 'code' in error && error.code === 121);
  assert.deepEqual(await snapshot(), before);
  await db.command({ collMod: 'note_write_intents', validator: {}, validationLevel: 'strict', validationAction: 'error' });
  phase = 'post_write_rollback';
  await assert.rejects(finishRecoverySync(db, lease, failed.operation._id, async () => { throw new Error('synthetic_settlement_barrier'); }), /synthetic_settlement_barrier/);
  assert.deepEqual(await snapshot(), before);
  phase = 'capped_retry';
  const complete = await finishRecoverySync(db, lease, failed.operation._id);
  assert.equal(complete.charged, 5); assert.equal(complete.refunded, 2); assert.equal(complete.results[0].ok, false);
  assert.equal((await collections.atomicUsers(db).findOne({ _id: fixture.owner }))!.energy, 120);
  assert.equal((await collections.atomicUsers(db).findOne({ _id: fixture.owner }))!.lastStandardSyncAt, null);
  assert.equal((await journal.findOne({ _id: failed.intents[0]._id }))!.state, 'abandoned');
  assert.equal((await journal.findOne({ _id: failed.intents[0]._id }))!.terminalReason, 'write_interrupted');
  const closed = await snapshot();
  assert.deepEqual(await finishRecoverySync(db, lease, failed.operation._id), complete); assert.deepEqual(await snapshot(), closed);
  await assert.rejects(stageRecoveryIntent(db, lease, failed.intents[0]._id, sdk, 'synthetic-parent', failed.targets[0]), /recovery_intent_not_stageable/);
  assert.equal(writes, 0);
  phase = 'partial_commit';
  const partial = await prepare(2, 'instant');
  await stageRecoveryIntent(db, lease, partial.intents[0]._id, sdk, 'synthetic-parent', partial.targets[0]);
  const saved = await commitRecoveryIntents(db, lease, [partial.intents[0]._id], sdk, 'synthetic-parent');
  assert.equal(saved.size, 1);
  const partialBefore = await snapshot();
  phase = 'partial_settlement_rollback';
  await assert.rejects(finishRecoverySync(db, lease, partial.operation._id, async () => { throw new Error('synthetic_partial_barrier'); }), /synthetic_partial_barrier/);
  assert.deepEqual(await snapshot(), partialBefore);
  const settled = await finishRecoverySync(db, lease, partial.operation._id);
  assert.equal(settled.charged, 10); assert.equal(settled.refunded, 0);
  assert.deepEqual(settled.results.map((result) => result.ok), [true, false]);
  assert.equal(settled.results[0].version, saved.get(partial.targets[0].id)!.localVersion);
  assert.equal((await journal.findOne({ _id: partial.intents[0]._id }))!.state, 'committed');
  assert.equal((await journal.findOne({ _id: partial.intents[1]._id }))!.state, 'abandoned');
  assert.equal((await collections.atomicUsers(db).findOne({ _id: fixture.owner }))!.energy, 110);
  assert.equal(writes, 1);
  phase = 'inconsistent_success_refusal';
  const invalid = await prepare(1, 'instant');
  await syncOperations(db).updateOne({ _id: invalid.operation._id }, { $push: { results: { id: invalid.rows[0].id, ok: true, version: 77, seq: 77 } } });
  const invalidBefore = await snapshot();
  await assert.rejects(finishRecoverySync(db, lease, invalid.operation._id), /recovery_settlement_commit_mismatch/);
  assert.deepEqual(await snapshot(), invalidBefore);
  await syncOperations(db).updateOne({ _id: invalid.operation._id }, { $set: { results: [] } });
  await finishRecoverySync(db, lease, invalid.operation._id);
  phase = 'owner_isolation';
  const otherLease = await acquireRecoveryLease(db, fixture.other);
  try { await assert.rejects(finishRecoverySync(db, otherLease, failed.operation._id), /recovery_settlement_operation_invalid/); }
  finally { await releaseRecoveryLease(db, otherLease); }
  const replayBefore = await snapshot();
  await releaseRecoveryLease(db, lease); release = undefined;
  phase = 'actual_receipt_replay';
  for (const [request, receipt, status] of [[failed, complete, 502], [partial, settled, 502]] as const) {
    const response = await call({ requestId: request.requestId, mode: request.mode, rows: request.rows });
    assert.equal(response.status, status);
    const body = await response.json() as { results: unknown[]; refunded: number; charged: number };
    assert.deepEqual(body.results, receipt.results); assert.equal(body.refunded, receipt.refunded); assert.equal(body.charged, receipt.charged);
  }
  assert.deepEqual(await snapshot(), replayBefore); assert.equal(writes, 1);
  phase = 'complete'; passed = true;
});
