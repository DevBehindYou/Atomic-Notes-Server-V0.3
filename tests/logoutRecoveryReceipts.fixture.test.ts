import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash, randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { startClientFixture, FIXTURE_TOKENS } from './clientFixture.js';
import { assertFixtureCleanup } from './clientFixtureSafety.js';
import { logoutBatchFingerprint } from '../src/lib/logoutContract.js';
import { remoteNoteRowSchema } from '../src/types/noteWire.js';

test('dormant receipt delivery is immutable, bounded and never reconciles uncertain writes',
  { timeout: 60000 }, async t => {
    let phase = 'setup', passed = false;
    t.after(() => writeFileSync('ci-logout-recovery-receipts-proof.json', JSON.stringify({ version: 1,
      scope: 'disposable opt-in read-only logout recovery receipts', phase, outcome: passed ? 'pass' : 'fail' })));
    const fixture = await startClientFixture(process.env.MONGODB_URI, process.env.MONGODB_DB_NAME, undefined, { logoutSync: true });
    t.after(() => fixture.close());
    const { getDb } = await import('../src/db/mongo.js');
    const { collections } = await import('../src/db/collections.js');
    const { createNotesRoute } = await import('../src/routes/notes.js');
    const { logoutAttempts } = await import('../src/lib/logoutAttempt.js');
    const { syncOperations } = await import('../src/lib/syncOperation.js');
    const db = await getDb(); assertFixtureCleanup(db.databaseName, fixture.database);
    const attemptId = randomUUID(), requestId = randomUUID();
    const rows = [remoteNoteRowSchema.parse({ id: randomUUID(), kind: 'text', title: 'Public receipt delivery',
      body: 'Never expose this synthetic note text in receipts', items: [], pinned: false, deleted: false,
      created_at: new Date().toISOString(), enc_v: 0, payload: null, base_version: 0 })];
    const batches = [{ requestId, fingerprint: logoutBatchFingerprint(rows), rowIds: rows.map(row => row.id),
      wireBytes: Buffer.byteLength(JSON.stringify({ rows, requestId, mode: 'instant', logoutAttemptId: attemptId })) }];
    const oldHash = createHash('sha256').update(FIXTURE_TOKENS.a).digest('hex');
    const body = { attemptId, previousSessionHash: oldHash, batches };
    const call = async (path: string, token: string, payload: object | string) => {
      const response = await fetch(fixture.origin + '/api/notes/' + path, { method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: typeof payload === 'string' ? payload : JSON.stringify(payload) });
      return { status: response.status, body: await response.json() };
    };
    const read = (token: string = FIXTURE_TOKENS.b, payload: object | string = body) => call('logout-attempt/recovery-receipts', token, payload);
    const snapshot = async () => ({
      wallets: await collections.atomicUsers(db).find({}).sort({ _id: 1 }).toArray(),
      ledger: await collections.energyLedger(db).find({}).sort({ _id: 1 }).toArray(),
      sessions: await collections.sessions(db).find({}).sort({ _id: 1 }).toArray(),
      attempts: await logoutAttempts(db).find({}).sort({ _id: 1 }).toArray(),
      operations: await syncOperations(db).find({}).sort({ _id: 1 }).toArray(),
      notes: await collections.notes(db).find({}).sort({ _id: 1 }).toArray(),
    });
    phase = 'disabled_and_input_bounds';
    const disabled = createNotesRoute(undefined, { logoutSync: false });
    assert.equal((await disabled.request('http://localhost/logout-attempt/recovery-receipts', {
      method: 'POST', headers: { authorization: `Bearer ${FIXTURE_TOKENS.b}` }, body: 'invalid',
    })).status, 404);
    assert.equal((await read('')).status, 401);
    assert.equal((await read(FIXTURE_TOKENS.b, 'x'.repeat(16385))).status, 413);
    assert.equal((await read(FIXTURE_TOKENS.b, '{')).status, 400);
    assert.equal((await read(FIXTURE_TOKENS.b, { ...body, user_id: fixture.owner })).status, 400);
    assert.equal((await call('logout-attempt', FIXTURE_TOKENS.a, { attemptId, batches })).status, 200);
    phase = 'active_and_missing_refusal';
    const active = await snapshot();
    assert.equal((await read()).status, 409);
    assert.deepEqual(await snapshot(), active);
    phase = 'real_push_and_terminal_receipts';
    const push = await call('push', FIXTURE_TOKENS.a, { rows, requestId, mode: 'instant', logoutAttemptId: attemptId });
    assert.equal(push.status, 200);
    assert.equal((await call('logout-attempt/complete', FIXTURE_TOKENS.a, { attemptId })).status, 200);
    const expected = { status: 200, body: { attemptId, state: 'completed', batches: [{ requestId,
      charged: 10, refunded: 0, results: (push.body as { results: unknown[] }).results }] } };
    const settled = await snapshot();
    assert.deepEqual(await read(), expected);
    assert.deepEqual(await read(), expected);
    assert.deepEqual(await snapshot(), settled);
    for (const forbidden of [rows[0].body, rows[0].title, FIXTURE_TOKENS.a, oldHash, fixture.owner, 'fingerprint', 'logoutSessionHash']) {
      assert.equal(JSON.stringify(expected.body).includes(forbidden), false);
    }
    assert.equal((await read(FIXTURE_TOKENS.other)).status, 409);
    assert.equal((await read(FIXTURE_TOKENS.a)).status, 401);
    assert.equal((await read(FIXTURE_TOKENS.b, { ...body, batches: [{ ...batches[0], fingerprint: 'b'.repeat(64) }] })).status, 409);
    assert.deepEqual(await snapshot(), settled);
    phase = 'projection_and_optional_metadata';
    const original = (push.body as { results: Array<{ id: string; ok: boolean; version: number; updated_at: string; seq?: number }> }).results;
    const annotated = [{ ...original[0], privateMarker: rows[0].body }];
    await syncOperations(db).updateOne({ _id: `${fixture.owner}:${requestId}` },
      { $set: { results: annotated } });
    const projected = await snapshot();
    assert.deepEqual(await read(), expected);
    assert.deepEqual(await snapshot(), projected);
    await syncOperations(db).updateOne({ _id: `${fixture.owner}:${requestId}` },
      { $set: { results: [{ ...original[0], seq: -1 }] } });
    const invalidOptional = await snapshot();
    assert.deepEqual(await read(), { status: 409, body: { error: 'logout_recovery_receipt_invalid' } });
    assert.deepEqual(await snapshot(), invalidOptional);
    phase = 'pending_and_missing_never_settled';
    const opId = `${fixture.owner}:${requestId}`;
    await syncOperations(db).updateOne({ _id: opId }, { $set: { status: 'pending' } });
    const pending = await snapshot();
    assert.deepEqual(await read(), { status: 409, body: { error: 'logout_recovery_reconciliation_required' } });
    assert.deepEqual(await snapshot(), pending);
    await syncOperations(db).updateOne({ _id: opId }, { $set: { status: 'complete',
      results: [{ id: rows[0].id, ok: false, error: 'Public private exception text' }] } });
    await logoutAttempts(db).updateOne({ _id: `${fixture.owner}:${attemptId}` }, { $set: { state: 'prepared' } });
    const malformed = await snapshot();
    assert.deepEqual(await read(), { status: 409, body: { error: 'logout_recovery_receipt_invalid' } });
    assert.deepEqual(await snapshot(), malformed);
    await syncOperations(db).deleteOne({ _id: opId });
    const missing = await snapshot();
    assert.deepEqual(await read(), { status: 409, body: { error: 'logout_recovery_receipt_missing' } });
    assert.deepEqual(await snapshot(), missing);
    const state = await (await fetch(fixture.origin + '/__fixture/state')).json() as { writes: number };
    assert.equal(state.writes, 1);
    phase = 'complete'; passed = true;
  });
