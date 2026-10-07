import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { noteWriteIntentSchema, type NoteWriteIntent } from '../src/db/recoveryContract.js';
import { remoteNoteRowSchema } from '../src/types/noteWire.js';
import { noteContentHash } from '../src/lib/contentHash.js';
import { startClientFixture, FIXTURE_TOKENS } from './clientFixture.js';
import { assertFixtureCleanup } from './clientFixtureSafety.js';

test('inactive admission persists debit and every intent together and retries without another debit', { timeout: 60000 }, async (t) => {
  let phase = 'setup', passed = false;
  t.after(() => writeFileSync('ci-recovery-admission-proof.json', JSON.stringify({ version: 1,
    scope: 'disposable inactive atomic debit and intent admission', phase, outcome: passed ? 'pass' : 'fail' })));
  const fixture = await startClientFixture(process.env.MONGODB_URI, process.env.MONGODB_DB_NAME);
  let release: (() => Promise<unknown>) | undefined;
  t.after(async () => { try { await release?.(); } finally { await fixture.close(); } });
  const { getDb } = await import('../src/db/mongo.js');
  const { collections } = await import('../src/db/collections.js');
  const { fingerprintOf, syncOperations } = await import('../src/lib/syncOperation.js');
  const { acquireRecoveryLease, releaseRecoveryLease } = await import('../src/lib/recoveryGate.js');
  const { beginRecoverySync } = await import('../src/lib/recoveryAdmission.js');
  const { finishRecoverySync } = await import('../src/lib/recoverySettlement.js');
  const db = await getDb(); assertFixtureCleanup(db.databaseName, fixture.database);
  const journal = db.collection<NoteWriteIntent>('note_write_intents'); await db.createCollection('note_write_intents');
  const lease = await acquireRecoveryLease(db, fixture.owner); release = () => releaseRecoveryLease(db, lease);
  const now = new Date();
  const make = (mode: 'standard' | 'instant' = 'instant') => {
    const requestId = randomUUID();
    const rows = Array.from({ length: 2 }, () => remoteNoteRowSchema.parse({ id: randomUUID(), kind: 'text',
      title: 'Public synthetic admission', body: 'Public synthetic preserved local body', items: [], pinned: false,
      deleted: false, enc_v: 0, payload: null, base_version: 0, created_at: now.toISOString() }));
    const intents = rows.map((row) => noteWriteIntentSchema.parse({ _id: `${fixture.owner}:${requestId}:${row.id}`,
      format: 1, userId: fixture.owner, noteId: row.id, requestId, operationId: `${fixture.owner}:${requestId}`,
      fingerprint: fingerprintOf(rows, mode), expectedVersion: 0, expectedFileId: null, expectedHash: null,
      stagedFileId: `synthetic-${randomUUID()}`, targetHash: noteContentHash(row),
      targetFlags: { kind: 'text', encV: 0, pinned: false, deleted: false }, wipeEpoch: lease.wipeEpoch,
      leaseToken: lease.token, state: 'prepared', createdAt: now, updatedAt: now,
      committedVersion: null, committedSequence: null, terminalReason: null }));
    return { requestId, rows, intents, mode };
  };
  const begin = (request: ReturnType<typeof make>, barrier?: () => Promise<void>) =>
    beginRecoverySync(db, lease, request.requestId, request.rows, request.mode, request.intents, barrier);
  const snapshot = async () => ({ wallet: await collections.atomicUsers(db).findOne({ _id: fixture.owner }),
    ledger: await collections.energyLedger(db).find({ userId: fixture.owner }).sort({ _id: 1 }).toArray(),
    operations: await syncOperations(db).find({ userId: fixture.owner }).sort({ _id: 1 }).toArray(),
    intents: await journal.find({ userId: fixture.owner }).sort({ _id: 1 }).toArray(),
    notes: await collections.notes(db).find({ userId: fixture.owner }).sort({ _id: 1 }).toArray() });
  const request = make(); const before = await snapshot(); assert.equal(before.wallet!.energy, 100);
  phase = 'manifest_validation_rollback';
  await db.command({ collMod: 'note_write_intents', validator: { _id: { $ne: request.intents[1]._id } }, validationLevel: 'strict', validationAction: 'error' });
  await assert.rejects(begin(request), (error: unknown) => typeof error === 'object' && error !== null && 'code' in error && error.code === 121);
  assert.deepEqual(await snapshot(), before);
  await db.command({ collMod: 'note_write_intents', validator: {}, validationLevel: 'strict', validationAction: 'error' });
  phase = 'post_write_rollback';
  await assert.rejects(begin(request, async () => { throw new Error('synthetic_admission_barrier'); }), /synthetic_admission_barrier/);
  assert.deepEqual(await snapshot(), before);
  phase = 'atomic_retry';
  const admitted = await begin(request);
  assert.equal(admitted.operation.charged, 10); assert.equal(admitted.intents.length, 2);
  assert.equal((admitted.operation as { recoveryFormat?: number }).recoveryFormat, 1);
  assert.equal((await collections.atomicUsers(db).findOne({ _id: fixture.owner }))!.energy, 90);
  assert.equal(await journal.countDocuments({ userId: fixture.owner }), 2);
  assert.equal(JSON.stringify(await journal.find({}).toArray()).includes(request.rows[0].body), false);
  const after = await snapshot();
  assert.deepEqual(await begin(request), admitted); assert.deepEqual(await snapshot(), after);
  phase = 'mismatch_and_reconciliation';
  const changed = { ...request, rows: request.rows.map((row) => ({ ...row, body: 'Public synthetic changed envelope' })) };
  changed.intents = changed.intents.map((intent, i) => ({ ...intent, fingerprint: fingerprintOf(changed.rows, changed.mode), targetHash: noteContentHash(changed.rows[i]) }));
  await assert.rejects(begin(changed), /sync_request_mismatch/); assert.deepEqual(await snapshot(), after);
  await assert.rejects(begin(make()), /recovery_admission_reconciliation_required/); assert.deepEqual(await snapshot(), after);
  await assert.rejects(begin({ ...request, intents: request.intents.map((intent) => ({ ...intent, stagedFileId: `different-${randomUUID()}` })) }), /recovery_intent_mismatch/);
  assert.deepEqual(await snapshot(), after);
  phase = 'terminal_replay';
  const finished = await finishRecoverySync(db, lease, admitted.operation._id);
  assert.equal(finished.refunded, 10);
  const terminal = await snapshot();
  const replay = await begin(request); assert.deepEqual(replay.operation, finished); assert.deepEqual(replay.intents, []);
  assert.deepEqual(await snapshot(), terminal);
  phase = 'cooldown_and_insufficient';
  await collections.atomicUsers(db).updateOne({ _id: fixture.owner }, { $set: { lastStandardSyncAt: new Date() } });
  const cooldown = await snapshot();
  await assert.rejects(begin(make('standard')), (error: unknown) => error instanceof Error && error.message === 'sync_cooldown' && (error as { status?: number }).status === 429);
  assert.deepEqual(await snapshot(), cooldown);
  // Explicit generated-wallet precondition; no production adjustment is performed.
  await collections.atomicUsers(db).updateOne({ _id: fixture.owner }, { $set: { energy: 0, lastStandardSyncAt: null } });
  const insufficient = await snapshot(); await assert.rejects(begin(make()), /insufficient_energy/); assert.deepEqual(await snapshot(), insufficient);
  phase = 'paid_standard';
  await collections.atomicUsers(db).updateOne({ _id: fixture.owner }, { $set: { energy: 100 } });
  const standard = make('standard'); const opened = await begin(standard);
  assert.equal(opened.operation.charged, 5);
  assert.equal((await collections.atomicUsers(db).findOne({ _id: fixture.owner }))!.energy, 95);
  assert.equal((await collections.atomicUsers(db).findOne({ _id: fixture.owner }))!.lastStandardSyncAt!.getTime(), opened.operation.createdAt.getTime());
  const standardClosed = await finishRecoverySync(db, lease, opened.operation._id); assert.equal(standardClosed.refunded, 5);
  assert.equal((await collections.atomicUsers(db).findOne({ _id: fixture.owner }))!.lastStandardSyncAt, null);
  const receiptState = await snapshot(); await releaseRecoveryLease(db, lease); release = undefined;
  phase = 'actual_http_replay';
  const response = await fetch(`${fixture.origin}/api/notes/push`, { method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${FIXTURE_TOKENS.a}` },
    body: JSON.stringify({ requestId: standard.requestId, mode: standard.mode, rows: standard.rows }) });
  assert.equal(response.status, 502);
  const receipt = await response.json() as { charged: number; refunded: number; results: unknown[] };
  assert.equal(receipt.charged, 5); assert.equal(receipt.refunded, 5); assert.deepEqual(receipt.results, standardClosed.results);
  assert.deepEqual(await snapshot(), receiptState);
  phase = 'complete'; passed = true;
});
