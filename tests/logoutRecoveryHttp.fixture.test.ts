import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash, randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { startClientFixture, FIXTURE_TOKENS } from './clientFixture.js';
import { assertFixtureCleanup } from './clientFixtureSafety.js';
import { logoutBatchFingerprint } from '../src/lib/logoutContract.js';
import { remoteNoteRowSchema } from '../src/types/noteWire.js';

test('dormant recovery status HTTP is bounded, owner scoped and never settles pending writes',
  { timeout: 60000 }, async t => {
    let phase = 'setup', passed = false;
    t.after(() => writeFileSync('ci-logout-recovery-http-proof.json', JSON.stringify({ version: 1,
      scope: 'disposable opt-in read-only logout recovery HTTP', phase, outcome: passed ? 'pass' : 'fail' })));
    const fixture = await startClientFixture(process.env.MONGODB_URI, process.env.MONGODB_DB_NAME, undefined, { logoutSync: true });
    t.after(() => fixture.close());
    const { getDb } = await import('../src/db/mongo.js');
    const { collections } = await import('../src/db/collections.js');
    const { createNotesRoute } = await import('../src/routes/notes.js');
    const { admitLogoutAttempt, openLogoutBatch, settleLogoutBatch, logoutAttempts } = await import('../src/lib/logoutAttempt.js');
    const { syncOperations, recordSyncResult } = await import('../src/lib/syncOperation.js');
    const db = await getDb(); assertFixtureCleanup(db.databaseName, fixture.database);
    await db.createCollection('logout_attempts');
    const attemptId = randomUUID(), requestId = randomUUID();
    const rows = [remoteNoteRowSchema.parse({ id: randomUUID(), kind: 'text', title: 'Public recovery HTTP',
      body: 'Public synthetic content', items: [], pinned: false, deleted: false,
      created_at: new Date().toISOString(), enc_v: 0, payload: null, base_version: 0 })];
    const batches = [{ requestId, fingerprint: logoutBatchFingerprint(rows), rowIds: rows.map(row => row.id),
      wireBytes: Buffer.byteLength(JSON.stringify({ rows, requestId, mode: 'instant', logoutAttemptId: attemptId })) }];
    const oldHash = createHash('sha256').update(FIXTURE_TOKENS.a).digest('hex');
    const body = { attemptId, previousSessionHash: oldHash, batches };
    const endpoint = '/api/notes/logout-attempt/recovery-status';
    const call = async (token: string, payload: object | string = body) => {
      const response = await fetch(fixture.origin + endpoint, { method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: typeof payload === 'string' ? payload : JSON.stringify(payload) });
      return { status: response.status, body: await response.json() };
    };
    const snapshot = async () => ({
      wallet: await collections.atomicUsers(db).findOne({ _id: fixture.owner }),
      ledger: await collections.energyLedger(db).find({ userId: fixture.owner }).sort({ _id: 1 }).toArray(),
      sessions: await collections.sessions(db).find({}).sort({ _id: 1 }).toArray(),
      attempts: await logoutAttempts(db).find({}).sort({ _id: 1 }).toArray(),
      operations: await syncOperations(db).find({}).sort({ _id: 1 }).toArray(),
      notes: await collections.notes(db).find({}).sort({ _id: 1 }).toArray(),
    });
    phase = 'disabled_auth_and_body_bounds';
    const before = await snapshot();
    const disabled = createNotesRoute(undefined, { logoutSync: false });
    assert.equal((await disabled.request('http://localhost/logout-attempt/recovery-status', {
      method: 'POST', headers: { authorization: `Bearer ${FIXTURE_TOKENS.b}` }, body: 'invalid',
    })).status, 404);
    assert.equal((await call('')).status, 401);
    assert.deepEqual(await call(FIXTURE_TOKENS.b, 'x'.repeat(16385)),
      { status: 413, body: { error: 'logout_recovery_payload_too_large' } });
    assert.deepEqual(await call(FIXTURE_TOKENS.b, '{'), { status: 400, body: { error: 'invalid_json' } });
    assert.equal((await call(FIXTURE_TOKENS.b, { ...body, user_id: fixture.owner })).status, 400);
    assert.deepEqual(await snapshot(), before);
    await collections.atomicUsers(db).updateOne({ _id: fixture.owner }, { $set: { energy: 0 } });
    await admitLogoutAttempt(db, fixture.owner, FIXTURE_TOKENS.a, attemptId, batches);
    const operation = await openLogoutBatch(db, fixture.owner, FIXTURE_TOKENS.a, attemptId, requestId, rows);
    await collections.sessions(db).updateOne({ _id: oldHash }, { $set: { revoked: true } });
    phase = 'pending_refusal_without_legacy_settlement';
    const pending = await snapshot();
    assert.deepEqual(await call(FIXTURE_TOKENS.b), { status: 409,
      body: { error: 'logout_recovery_reconciliation_required' } });
    assert.deepEqual(await snapshot(), pending);
    // Synthetic receipt setup only. No Drive/metadata write is claimed.
    await collections.sessions(db).updateOne({ _id: oldHash }, { $set: { revoked: false } });
    await recordSyncResult(db, operation, { id: rows[0].id, ok: true, version: 1, updated_at: new Date().toISOString() });
    await settleLogoutBatch(db, fixture.owner, FIXTURE_TOKENS.a, attemptId, requestId);
    phase = 'live_and_foreign_refusal';
    const live = await snapshot();
    assert.deepEqual(await call(FIXTURE_TOKENS.b), { status: 409,
      body: { error: 'logout_recovery_previous_session_active' } });
    assert.deepEqual(await call(FIXTURE_TOKENS.other), { status: 409,
      body: { error: 'logout_recovery_attempt_missing' } });
    assert.deepEqual(await snapshot(), live);
    await collections.sessions(db).updateOne({ _id: oldHash }, { $set: { revoked: true } });
    phase = 'settled_and_completed_reads';
    const settled = await snapshot();
    assert.deepEqual(await call(FIXTURE_TOKENS.b), { status: 200, body: { attemptId,
      state: 'prepared', batches: [{ requestId, charged: 0, refunded: 0, accepted: 1, failed: 0 }] } });
    assert.deepEqual(await snapshot(), settled);
    await logoutAttempts(db).updateOne({ _id: `${fixture.owner}:${attemptId}` }, { $set: { state: 'completed' } });
    await collections.sessions(db).deleteOne({ _id: oldHash });
    const terminal = await snapshot(), response = await call(FIXTURE_TOKENS.b);
    assert.equal(response.status, 200);
    assert.equal((response.body as { state: string }).state, 'completed');
    assert.equal(JSON.stringify(response.body).includes(rows[0].body), false);
    assert.equal(JSON.stringify(response.body).includes(FIXTURE_TOKENS.a), false);
    assert.deepEqual(await snapshot(), terminal);
    assert.equal((await (await fetch(fixture.origin + '/__fixture/state')).json() as { writes: number }).writes, 0);
    phase = 'complete'; passed = true;
  });
