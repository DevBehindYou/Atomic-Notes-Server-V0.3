import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash, randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { startClientFixture, FIXTURE_TOKENS } from './clientFixture.js';
import { assertFixtureCleanup } from './clientFixtureSafety.js';
import { logoutBatchFingerprint } from '../src/lib/logoutContract.js';
import { remoteNoteRowSchema } from '../src/types/noteWire.js';

test('settled-only recovery commit fences current auth, preserves charges and replays terminal receipts',
  { timeout: 90000 }, async t => {
    let phase = 'setup', passed = false;
    t.after(() => writeFileSync('ci-logout-recovery-commit-proof.json', JSON.stringify({ version: 1,
      scope: 'disposable opt-in settled-only logout recovery commit', phase, outcome: passed ? 'pass' : 'fail' })));
    const fixture = await startClientFixture(process.env.MONGODB_URI, process.env.MONGODB_DB_NAME, undefined, { logoutSync: true });
    t.after(() => fixture.close());
    const { getDb } = await import('../src/db/mongo.js');
    const { collections } = await import('../src/db/collections.js');
    const { createNotesRoute } = await import('../src/routes/notes.js');
    const { logoutAttempts, admitLogoutAttempt, openLogoutBatch, settleLogoutBatch } = await import('../src/lib/logoutAttempt.js');
    const { syncOperations, recordSyncResult } = await import('../src/lib/syncOperation.js');
    const { commitLogoutRecovery } = await import('../src/lib/logoutRecovery.js');
    const db = await getDb(); assertFixtureCleanup(db.databaseName, fixture.database);
    const hash = (token: string) => createHash('sha256').update(token).digest('hex');
    const sessions = collections.sessions(db);
    const snapshot = async () => ({
      wallets: await collections.atomicUsers(db).find({}).sort({ _id: 1 }).toArray(),
      ledger: await collections.energyLedger(db).find({}).sort({ _id: 1 }).toArray(),
      sessions: await sessions.find({}).sort({ _id: 1 }).toArray(),
      attempts: await logoutAttempts(db).find({}).sort({ _id: 1 }).toArray(),
      operations: await syncOperations(db).find({}).sort({ _id: 1 }).toArray(),
      notes: await collections.notes(db).find({}).sort({ _id: 1 }).toArray(),
    });
    const unchangedBusiness = (before: Awaited<ReturnType<typeof snapshot>>, after: Awaited<ReturnType<typeof snapshot>>) => {
      for (const field of ['wallets', 'ledger', 'operations', 'notes'] as const) assert.deepEqual(after[field], before[field]);
    };
    const seed = async (success = true, emergency = false) => {
      const attemptId = randomUUID(), requestId = randomUUID(), tag = randomUUID();
      const oldToken = `public-recovery-old-${tag}`, currentToken = `public-recovery-current-${tag}`;
      const oldHash = hash(oldToken), currentHash = hash(currentToken), now = new Date();
      for (const token of [oldToken, currentToken]) await sessions.insertOne({ _id: hash(token), userId: fixture.owner,
        revoked: false, createdAt: now, expiresAt: new Date(now.getTime() + 86400000), userAgent: 'disposable-recovery' });
      await collections.atomicUsers(db).updateOne({ _id: fixture.owner }, { $set: { energy: emergency ? 0 : 100 } });
      const rows = [remoteNoteRowSchema.parse({ id: randomUUID(), kind: 'text', title: 'Public synthetic recovery',
        body: 'Never return synthetic note text', items: [], pinned: false, deleted: false,
        created_at: now.toISOString(), enc_v: 0, payload: null, base_version: 0 })];
      const batches = [{ requestId, fingerprint: logoutBatchFingerprint(rows), rowIds: rows.map(row => row.id),
        wireBytes: Buffer.byteLength(JSON.stringify({ rows, requestId, mode: 'instant', logoutAttemptId: attemptId })) }];
      await admitLogoutAttempt(db, fixture.owner, oldToken, attemptId, batches);
      const operation = await openLogoutBatch(db, fixture.owner, oldToken, attemptId, requestId, rows);
      // Synthetic results exercise real debit/refund settlement, not Drive writes.
      await recordSyncResult(db, operation, success
        ? { id: rows[0].id, ok: true, version: 1, seq: 1, updated_at: now.toISOString() }
        : { id: rows[0].id, ok: false, error: 'note_conflict' });
      const settled = await settleLogoutBatch(db, fixture.owner, oldToken, attemptId, requestId);
      await sessions.updateOne({ _id: oldHash }, { $set: { revoked: true } });
      return { attemptId, requestId, oldToken, currentToken, oldHash, currentHash, rows,
        body: { attemptId, previousSessionHash: oldHash, batches },
        expected: { attemptId, state: success ? 'completed' : 'aborted', batches: [{ requestId,
          charged: settled.charged, refunded: settled.refunded, results: settled.results }] } };
    };
    type Plan = Awaited<ReturnType<typeof seed>>;
    const call = async (plan: Plan, token = plan.currentToken, payload: object | string = plan.body) => {
      const response = await fetch(fixture.origin + '/api/notes/logout-attempt/recovery-commit', { method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: typeof payload === 'string' ? payload : JSON.stringify(payload) });
      return { status: response.status, body: await response.json() };
    };
    const commit = (plan: Plan, hooks: Parameters<typeof commitLogoutRecovery>[6] = {}) =>
      commitLogoutRecovery(db, fixture.owner, plan.currentToken, plan.attemptId, plan.oldHash, plan.body.batches, hooks);
    phase = 'disabled_auth_bounds_and_owner_guards';
    const paid = await seed(), before = await snapshot();
    const disabled = createNotesRoute(undefined, { logoutSync: false });
    assert.equal((await disabled.request('http://localhost/logout-attempt/recovery-commit', {
      method: 'POST', headers: { authorization: `Bearer ${paid.currentToken}` }, body: 'invalid' })).status, 404);
    assert.equal((await call(paid, '')).status, 401);
    assert.equal((await call(paid, paid.currentToken, 'x'.repeat(16385))).status, 413);
    assert.equal((await call(paid, paid.currentToken, '{')).status, 400);
    assert.equal((await call(paid, paid.currentToken, { ...paid.body, user_id: fixture.owner })).status, 400);
    assert.equal((await call(paid, FIXTURE_TOKENS.other)).status, 409);
    assert.equal((await call(paid, paid.currentToken, { ...paid.body,
      batches: [{ ...paid.body.batches[0], fingerprint: 'b'.repeat(64) }] })).status, 409);
    assert.deepEqual(await snapshot(), before);
    phase = 'paid_close_lost_reply_and_parallel_replay';
    assert.deepEqual(await call(paid), { status: 200, body: paid.expected }); // Discarded/lost first reply.
    const once = await snapshot(); unchangedBusiness(before, once);
    assert.equal((await sessions.findOne({ _id: paid.currentHash }))!.logoutAttemptRevision, 1);
    assert.deepEqual(once.sessions.filter(row => row._id !== paid.currentHash), before.sessions.filter(row => row._id !== paid.currentHash));
    assert.deepEqual(once.attempts.filter(row => row.attemptId !== paid.attemptId), before.attempts.filter(row => row.attemptId !== paid.attemptId));
    const closed = await logoutAttempts(db).findOne({ _id: `${fixture.owner}:${paid.attemptId}` });
    assert.equal(closed!.state, 'completed');
    const replies = await Promise.all([call(paid), call(paid)]);
    for (const reply of replies) assert.deepEqual(reply, { status: 200, body: paid.expected });
    assert.equal((await sessions.findOne({ _id: paid.currentHash }))!.logoutAttemptRevision, 3);
    assert.deepEqual(await logoutAttempts(db).findOne({ _id: closed!._id }), closed);
    unchangedBusiness(once, await snapshot());
    for (const forbidden of [paid.rows[0].body, paid.rows[0].title, paid.oldToken, paid.oldHash,
      fixture.owner, 'fingerprint', 'logoutSessionHash']) assert.equal(JSON.stringify(paid.expected).includes(forbidden), false);
    phase = 'failed_and_emergency_terminal_receipts';
    const failed = await seed(false), failedBefore = await snapshot();
    assert.equal(failed.expected.batches[0].charged, 10); assert.equal(failed.expected.batches[0].refunded, 10);
    assert.deepEqual(await call(failed), { status: 200, body: failed.expected });
    unchangedBusiness(failedBefore, await snapshot());
    const free = await seed(true, true), freeBefore = await snapshot();
    assert.equal(free.expected.batches[0].charged, 0);
    await sessions.deleteOne({ _id: free.oldHash });
    assert.deepEqual(await call(free), { status: 200, body: free.expected });
    unchangedBusiness(freeBefore, await snapshot());
    phase = 'transaction_rollback_and_revision_exhaustion';
    const rollback = await seed(), rollbackBefore = await snapshot();
    await assert.rejects(commit(rollback, { afterWrites: async () => { throw new Error('synthetic_recovery_rollback'); } }), /synthetic_recovery_rollback/);
    assert.deepEqual(await snapshot(), rollbackBefore);
    await sessions.updateOne({ _id: rollback.currentHash }, { $set: { logoutAttemptRevision: Number.MAX_SAFE_INTEGER } });
    const exhausted = await snapshot();
    assert.deepEqual(await call(rollback), { status: 409, body: { error: 'logout_revision_exhausted' } });
    assert.deepEqual(await snapshot(), exhausted);
    phase = 'current_revocation_and_attempt_races';
    const revoke = await seed(); let revoked = false;
    const revokeBefore = await snapshot();
    await assert.rejects(commit(revoke, { beforeWrites: async () => {
      if (!revoked) { revoked = true; await sessions.updateOne({ _id: revoke.currentHash }, { $set: { revoked: true } }); }
    } }), /logout_recovery_current_session_invalid|logout_session_changed/);
    assert.equal((await sessions.findOne({ _id: revoke.currentHash }))!.logoutAttemptRevision, undefined);
    assert.equal((await logoutAttempts(db).findOne({ _id: `${fixture.owner}:${revoke.attemptId}` }))!.state, 'prepared');
    unchangedBusiness(revokeBefore, await snapshot());
    const replaced = await seed(); let replacedOnce = false;
    const replacedBefore = await snapshot();
    await assert.rejects(commit(replaced, { beforeWrites: async () => {
      if (!replacedOnce) { replacedOnce = true; await sessions.updateOne({ _id: replaced.currentHash }, { $set: { userId: fixture.other } }); }
    } }), /logout_recovery_current_session_invalid|logout_session_changed/);
    assert.equal((await sessions.findOne({ _id: replaced.currentHash }))!.logoutAttemptRevision, undefined);
    assert.equal((await logoutAttempts(db).findOne({ _id: `${fixture.owner}:${replaced.attemptId}` }))!.state, 'prepared');
    unchangedBusiness(replacedBefore, await snapshot());
    const active = await seed(); let activated = false;
    const activeBefore = await snapshot();
    await assert.rejects(commit(active, { beforeWrites: async () => {
      if (!activated) { activated = true; await sessions.updateOne({ _id: active.currentHash }, { $set: { logoutAttemptId: 'synthetic-active-attempt' } }); }
    } }), /logout_recovery_current_attempt_active|logout_session_changed/);
    assert.equal((await sessions.findOne({ _id: active.currentHash }))!.logoutAttemptRevision, undefined);
    assert.equal((await logoutAttempts(db).findOne({ _id: `${fixture.owner}:${active.attemptId}` }))!.state, 'prepared');
    unchangedBusiness(activeBefore, await snapshot());
    phase = 'revision_and_old_attempt_transaction_retries';
    const race = await seed(); let revised = false;
    assert.deepEqual(await commit(race, { beforeWrites: async () => {
      if (!revised) { revised = true; await sessions.updateOne({ _id: race.currentHash }, { $inc: { logoutAttemptRevision: 1 } }); }
    } }), race.expected);
    assert.equal((await sessions.findOne({ _id: race.currentHash }))!.logoutAttemptRevision, 2);
    const terminalRace = await seed(); let aborted = false;
    assert.deepEqual(await commit(terminalRace, { beforeWrites: async () => {
      if (!aborted) { aborted = true; await logoutAttempts(db).updateOne({ _id: `${fixture.owner}:${terminalRace.attemptId}` },
        { $set: { state: 'aborted', updatedAt: new Date() } }); }
    } }), { ...terminalRace.expected, state: 'aborted' });
    phase = 'malformed_receipt_refused_before_fence';
    const invalid = await seed();
    await syncOperations(db).updateOne({ _id: `${fixture.owner}:${invalid.requestId}` },
      { $set: { results: [{ ...invalid.expected.batches[0].results[0], seq: -1 }] } });
    const invalidBefore = await snapshot();
    assert.deepEqual(await call(invalid), { status: 409, body: { error: 'logout_recovery_receipt_invalid' } });
    assert.deepEqual(await snapshot(), invalidBefore);
    await syncOperations(db).updateOne({ _id: `${fixture.owner}:${invalid.requestId}` },
      { $set: { results: invalid.expected.batches[0].results } });
    phase = 'missing_pending_and_live_old_session_never_settled';
    const uncertain = await seed();
    await sessions.updateOne({ _id: uncertain.oldHash }, { $set: { revoked: false } });
    const live = await snapshot(); assert.equal((await call(uncertain)).status, 409); assert.deepEqual(await snapshot(), live);
    await sessions.updateOne({ _id: uncertain.oldHash }, { $set: { revoked: true } });
    await syncOperations(db).updateOne({ _id: `${fixture.owner}:${uncertain.requestId}` }, { $set: { status: 'pending' } });
    const pending = await snapshot();
    assert.deepEqual(await call(uncertain), { status: 409, body: { error: 'logout_recovery_reconciliation_required' } });
    assert.deepEqual(await snapshot(), pending);
    await syncOperations(db).deleteOne({ _id: `${fixture.owner}:${uncertain.requestId}` });
    const missing = await snapshot();
    assert.deepEqual(await call(uncertain), { status: 409, body: { error: 'logout_recovery_receipt_missing' } });
    assert.deepEqual(await snapshot(), missing);
    assert.equal((await (await fetch(fixture.origin + '/__fixture/state')).json() as { writes: number }).writes, 0);
    assert.equal(await db.collection('operation_locks').countDocuments({}), 0);
    phase = 'complete'; passed = true;
  });
