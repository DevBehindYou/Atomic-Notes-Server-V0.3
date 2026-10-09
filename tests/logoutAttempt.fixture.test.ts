import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID, createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { startClientFixture, FIXTURE_TOKENS } from './clientFixture.js';
import { assertFixtureCleanup } from './clientFixtureSafety.js';
import { logoutBatchFingerprint } from '../src/lib/logoutContract.js';
import { remoteNoteRowSchema } from '../src/types/noteWire.js';

test('inactive logout attempts atomically bind free or paid batches and revoke only after all successful receipts', { timeout: 60000 }, async t => {
  let phase = 'setup', passed = false;
  t.after(() => writeFileSync('ci-logout-attempt-proof.json', JSON.stringify({ version: 1,
    scope: 'disposable inactive logout funding admission and completion', phase, outcome: passed ? 'pass' : 'fail' })));
  const fixture = await startClientFixture(process.env.MONGODB_URI, process.env.MONGODB_DB_NAME);
  t.after(() => fixture.close());
  const { getDb } = await import('../src/db/mongo.js');
  const { collections } = await import('../src/db/collections.js');
  const { syncOperations, recordSyncResult } = await import('../src/lib/syncOperation.js');
  const { admitLogoutAttempt, openLogoutBatch, settleLogoutBatch, completeLogoutAttempt, logoutAttempts } = await import('../src/lib/logoutAttempt.js');
  const { verifySession } = await import('../src/lib/session.js');
  const db = await getDb(); assertFixtureCleanup(db.databaseName, fixture.database);
  await db.createCollection('logout_attempts');
  const make = (count = 1) => {
    const attemptId = randomUUID();
    const requests = Array.from({ length: count }, () => {
      const requestId = randomUUID(), rows = [remoteNoteRowSchema.parse({ id: randomUUID(), kind: 'text',
        title: 'Public synthetic logout fixture', body: 'Public synthetic only local work', items: [], pinned: false,
        deleted: false, enc_v: 0, payload: null, base_version: 0, created_at: new Date().toISOString() })];
      return { requestId, rows, manifest: { requestId, fingerprint: logoutBatchFingerprint(rows), rowIds: rows.map(r => r.id),
        wireBytes: Buffer.byteLength(JSON.stringify({ rows, requestId, mode: 'instant', logoutAttemptId: attemptId })) } };
    });
    return { attemptId, requests, batches: requests.map(r => r.manifest) };
  };
  const snapshot = async (userId: string) => ({
    wallet: await collections.atomicUsers(db).findOne({ _id: userId }),
    ledger: await collections.energyLedger(db).find({ userId }).sort({ _id: 1 }).toArray(),
    sessions: await collections.sessions(db).find({ userId }).sort({ _id: 1 }).toArray(),
    attempts: await logoutAttempts(db).find({ userId }).sort({ _id: 1 }).toArray(),
    operations: await syncOperations(db).find({ userId }).sort({ _id: 1 }).toArray(),
    notes: await collections.notes(db).find({ userId }).sort({ _id: 1 }).toArray(),
  });
  const finance = (state: Awaited<ReturnType<typeof snapshot>>) => ({ energy: state.wallet!.energy,
    coins: state.wallet!.coins, cap: state.wallet!.energyCap, daily: state.wallet!.lastDailyGrantAt,
    standard: state.wallet!.lastStandardSyncAt, ledger: state.ledger });
  // Generated fixture wallet only; daily grant remains within its existing window.
  await collections.atomicUsers(db).updateOne({ _id: fixture.owner }, { $set: { energy: 0 } });
  const plan = make(2), before = await snapshot(fixture.owner);
  const admit = (barrier?: () => Promise<void>) => admitLogoutAttempt(db, fixture.owner, FIXTURE_TOKENS.a, plan.attemptId, plan.batches, barrier);
  phase = 'admission_rollback';
  await assert.rejects(admit(async () => { throw new Error('synthetic_logout_admission_barrier'); }), /synthetic_logout_admission_barrier/);
  assert.deepEqual(await snapshot(fixture.owner), before);
  phase = 'emergency_admission_replay';
  const admitted = await admit(); assert.equal(admitted.funding, 'emergency');
  const admittedState = await snapshot(fixture.owner); assert.deepEqual(finance(admittedState), finance(before));
  assert.deepEqual(await admit(), admitted); assert.deepEqual(await snapshot(fixture.owner), admittedState);
  assert.equal(JSON.stringify(admitted).includes(plan.requests[0].rows[0].body), false);
  assert.equal(JSON.stringify(admitted).includes(FIXTURE_TOKENS.a), false);
  const otherPlan = make();
  await assert.rejects(admitLogoutAttempt(db, fixture.owner, FIXTURE_TOKENS.a, otherPlan.attemptId, otherPlan.batches), /logout_attempt_active/);
  await assert.rejects(admitLogoutAttempt(db, fixture.owner, FIXTURE_TOKENS.other, plan.attemptId, plan.batches), /logout_session_invalid/);
  await assert.rejects(admitLogoutAttempt(db, fixture.owner, FIXTURE_TOKENS.a, plan.attemptId,
    plan.batches.map((b, i) => i ? b : { ...b, fingerprint: 'b'.repeat(64) })), /logout_attempt_mismatch/);
  assert.deepEqual(await snapshot(fixture.owner), admittedState);
  const first = plan.requests[0], second = plan.requests[1];
  const open = (r: typeof first, barrier?: () => Promise<void>) =>
    openLogoutBatch(db, fixture.owner, FIXTURE_TOKENS.a, plan.attemptId, r.requestId, r.rows, barrier);
  phase = 'batch_rollback_and_binding';
  await assert.rejects(open(first, async () => { throw new Error('synthetic_logout_batch_barrier'); }), /synthetic_logout_batch_barrier/);
  assert.deepEqual(await snapshot(fixture.owner), admittedState);
  await assert.rejects(open({ ...first, rows: first.rows.map(r => ({ ...r, body: 'Public synthetic changed request' })) }), /logout_batch_mismatch/);
  assert.deepEqual(await snapshot(fixture.owner), admittedState);
  const initial = await open(first); assert.equal(initial.charged, 0); assert.equal(initial.refunded, 0);
  const pendingState = await snapshot(fixture.owner);
  assert.deepEqual(await open(first), initial); assert.deepEqual(await snapshot(fixture.owner), pendingState);
  assert.deepEqual(finance(pendingState), finance(before));
  await assert.rejects(open(second), /logout_reconciliation_required/);
  await assert.rejects(completeLogoutAttempt(db, fixture.owner, FIXTURE_TOKENS.a, plan.attemptId), /logout_sync_incomplete/);
  assert.deepEqual(await snapshot(fixture.owner), pendingState);
  phase = 'legacy_http_refusal';
  const response = await fetch(`${fixture.origin}/api/notes/push`, { method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${FIXTURE_TOKENS.a}` },
    body: JSON.stringify({ requestId: first.requestId, rows: first.rows, mode: 'instant' }) });
  assert.equal(response.status, 409); assert.equal((await response.json() as { error: string }).error, 'sync_logout_required');
  assert.deepEqual(await snapshot(fixture.owner), pendingState);
  // Deliberately stored receipts test completion eligibility only. This is not
  // a Drive/metadata commit or App orchestration proof.
  phase = 'partial_receipts_block_completion';
  await recordSyncResult(db, initial, { id: first.rows[0].id, ok: true, version: 1, seq: 1 });
  assert.equal((await settleLogoutBatch(db, fixture.owner, FIXTURE_TOKENS.a, plan.attemptId, first.requestId)).charged, 0);
  await assert.rejects(completeLogoutAttempt(db, fixture.owner, FIXTURE_TOKENS.a, plan.attemptId), /logout_sync_incomplete/);
  const next = await open(second); await recordSyncResult(db, next, { id: second.rows[0].id, ok: true, version: 1, seq: 2 });
  await settleLogoutBatch(db, fixture.owner, FIXTURE_TOKENS.a, plan.attemptId, second.requestId);
  const completeBefore = await snapshot(fixture.owner);
  phase = 'completion_rollback';
  await assert.rejects(completeLogoutAttempt(db, fixture.owner, FIXTURE_TOKENS.a, plan.attemptId,
    async () => { throw new Error('synthetic_logout_completion_barrier'); }), /synthetic_logout_completion_barrier/);
  assert.deepEqual(await snapshot(fixture.owner), completeBefore);
  assert.equal(await verifySession(db, FIXTURE_TOKENS.a), fixture.owner);
  phase = 'atomic_completion_and_replay';
  const closed = await completeLogoutAttempt(db, fixture.owner, FIXTURE_TOKENS.a, plan.attemptId);
  assert.equal(closed.state, 'completed'); assert.equal(await verifySession(db, FIXTURE_TOKENS.a), null);
  assert.equal(await verifySession(db, FIXTURE_TOKENS.b), fixture.owner);
  const completeAfter = await snapshot(fixture.owner); assert.deepEqual(finance(completeAfter), finance(before));
  assert.deepEqual(await completeLogoutAttempt(db, fixture.owner, FIXTURE_TOKENS.a, plan.attemptId), closed);
  assert.deepEqual(await snapshot(fixture.owner), completeAfter);
  await assert.rejects(open(first), /logout_session_invalid/);
  phase = 'paid_debit_replay_and_failed_receipt';
  const paid = make(), paidBefore = await snapshot(fixture.other);
  assert.equal((await admitLogoutAttempt(db, fixture.other, FIXTURE_TOKENS.other, paid.attemptId, paid.batches)).funding, 'paid');
  const paidRequest = paid.requests[0];
  const paidOpened = await openLogoutBatch(db, fixture.other, FIXTURE_TOKENS.other, paid.attemptId, paidRequest.requestId, paidRequest.rows);
  assert.equal(paidOpened.charged, 10);
  const paidState = await snapshot(fixture.other); assert.equal(paidState.wallet!.energy, paidBefore.wallet!.energy - 10);
  assert.equal(paidState.ledger.length, paidBefore.ledger.length + 1);
  assert.deepEqual(await openLogoutBatch(db, fixture.other, FIXTURE_TOKENS.other, paid.attemptId, paidRequest.requestId, paidRequest.rows), paidOpened);
  assert.deepEqual(await snapshot(fixture.other), paidState);
  await recordSyncResult(db, paidOpened, { id: paidRequest.rows[0].id, ok: false, error: 'note_conflict' });
  const failed = await settleLogoutBatch(db, fixture.other, FIXTURE_TOKENS.other, paid.attemptId, paidRequest.requestId);
  assert.equal(failed.refunded, 10);
  const failedState = await snapshot(fixture.other);
  await assert.rejects(completeLogoutAttempt(db, fixture.other, FIXTURE_TOKENS.other, paid.attemptId), /logout_sync_incomplete/);
  assert.deepEqual(await snapshot(fixture.other), failedState);
  assert.equal(await verifySession(db, FIXTURE_TOKENS.other), fixture.other);
  phase = 'aggregate_insufficiency';
  await collections.atomicUsers(db).updateOne({ _id: fixture.batchOwner }, { $set: { energy: 10 } });
  const aggregate = make(2);
  assert.equal((await admitLogoutAttempt(db, fixture.batchOwner, FIXTURE_TOKENS.batch, aggregate.attemptId, aggregate.batches)).funding, 'emergency');
  assert.equal((await collections.atomicUsers(db).findOne({ _id: fixture.batchOwner }))!.energy, 10);
  const aggregateBefore = finance(await snapshot(fixture.batchOwner)), aggregateRequest = aggregate.requests[0];
  const freeFailed = await openLogoutBatch(db, fixture.batchOwner, FIXTURE_TOKENS.batch,
    aggregate.attemptId, aggregateRequest.requestId, aggregateRequest.rows);
  await recordSyncResult(db, freeFailed, { id: aggregateRequest.rows[0].id, ok: false, error: 'note_write_failed' });
  const freeClosed = await settleLogoutBatch(db, fixture.batchOwner, FIXTURE_TOKENS.batch, aggregate.attemptId, aggregateRequest.requestId);
  assert.equal(freeClosed.charged, 0); assert.equal(freeClosed.refunded, 0);
  assert.deepEqual(finance(await snapshot(fixture.batchOwner)), aggregateBefore);
  await assert.rejects(completeLogoutAttempt(db, fixture.batchOwner, FIXTURE_TOKENS.batch, aggregate.attemptId), /logout_sync_incomplete/);
  assert.equal(await verifySession(db, FIXTURE_TOKENS.batch), fixture.batchOwner);
  assert.equal(createHash('sha256').update(FIXTURE_TOKENS.a).digest('hex'), closed.sessionHash);
  phase = 'complete'; passed = true;
});
