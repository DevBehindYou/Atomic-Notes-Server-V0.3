import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { startClientFixture, FIXTURE_TOKENS } from './clientFixture.js';
import { assertFixtureCleanup } from './clientFixtureSafety.js';
import { logoutBatchFingerprint } from '../src/lib/logoutContract.js';
import { remoteNoteRowSchema } from '../src/types/noteWire.js';

test('opt-in logout HTTP writes, replays and completes only acknowledged notes', { timeout: 60000 }, async t => {
  let phase = 'setup', passed = false;
  t.after(() => writeFileSync('ci-logout-http-proof.json', JSON.stringify({ version: 1,
    scope: 'disposable opt-in logout HTTP and Drive accounting', phase, outcome: passed ? 'pass' : 'fail' })));
  const fixture = await startClientFixture(process.env.MONGODB_URI, process.env.MONGODB_DB_NAME, undefined, { logoutSync: true });
  t.after(() => fixture.close());
  const { getDb } = await import('../src/db/mongo.js');
  const { collections } = await import('../src/db/collections.js');
  const { createNotesRoute } = await import('../src/routes/notes.js');
  const db = await getDb(); assertFixtureCleanup(db.databaseName, fixture.database);
  const row = (body: string) => remoteNoteRowSchema.parse({ id: randomUUID(), kind: 'text', title: 'Public synthetic logout',
    body, items: [], pinned: false, deleted: false, enc_v: 0, payload: null, base_version: 0, created_at: new Date().toISOString() });
  const plan = (groups: ReturnType<typeof row>[][]) => {
    const attemptId = randomUUID();
    const pushes = groups.map(rows => ({ rows, requestId: randomUUID(), mode: 'instant', logoutAttemptId: attemptId }));
    return { attemptId, pushes, batches: pushes.map(p => ({ requestId: p.requestId, fingerprint: logoutBatchFingerprint(p.rows),
      rowIds: p.rows.map(r => r.id), wireBytes: Buffer.byteLength(JSON.stringify(p)) })) };
  };
  const call = async (token: string, path: string, body?: object) => {
    const r = await fetch(fixture.origin + path, { method: body ? 'POST' : 'GET',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, body: await r.json() as Record<string, any> };
  };
  const state = async () => (await call(FIXTURE_TOKENS.a, '/__fixture/state')).body;
  const finance = async (userId: string) => {
    const wallet = (await collections.atomicUsers(db).findOne({ _id: userId }))!;
    return { energy: wallet.energy, coins: wallet.coins, lastStandard: wallet.lastStandardSyncAt,
      lastDaily: wallet.lastDailyGrantAt, ledger: await collections.energyLedger(db).find({ userId }).sort({ _id: 1 }).toArray() };
  };
  const begin = (token: string, p: ReturnType<typeof plan>) => call(token, '/api/notes/logout-attempt', { attemptId: p.attemptId, batches: p.batches });
  const finish = (token: string, p: ReturnType<typeof plan>) => call(token, '/api/notes/logout-attempt/complete', { attemptId: p.attemptId });
  const abort = (token: string, p: ReturnType<typeof plan>) => call(token, '/api/notes/logout-attempt/abort', { attemptId: p.attemptId });
  const a = FIXTURE_TOKENS.a, other = FIXTURE_TOKENS.other, batch = FIXTURE_TOKENS.batch;
  phase = 'disabled_gate';
  const disabled = createNotesRoute(undefined, { logoutSync: false });
  assert.equal((await disabled.request('http://localhost/logout-attempt/complete', { method: 'POST',
    headers: { 'content-type': 'application/json' }, body: JSON.stringify({ attemptId: randomUUID() }) })).status, 404);
  const capabilityBefore = await finance(fixture.owner), stateBefore = await state();
  const disabledCapability = await disabled.request('http://localhost/logout-capability', {
    headers: { authorization: `Bearer ${a}` },
  });
  assert.equal(disabledCapability.status, 200);
  assert.deepEqual(await disabledCapability.json(), { available: false });
  assert.equal((await disabled.request('http://localhost/logout-capability')).status, 401);
  assert.deepEqual(await call(a, '/api/notes/logout-capability'), { status: 200, body: { available: true } });
  assert.equal((await call('', '/api/notes/logout-capability')).status, 401);
  assert.deepEqual(await finance(fixture.owner), capabilityBefore);
  assert.deepEqual(await state(), stateBefore);
  assert.equal(await db.collection('logout_attempts').countDocuments({ userId: fixture.owner }), 0);
  phase = 'free_admission_and_binding';
  await collections.atomicUsers(db).updateOne({ _id: fixture.owner }, { $set: { energy: 0 } });
  const free = plan([[row('Public synthetic first logout body')], [row('Public synthetic second logout body')]]);
  const freeBefore = await finance(fixture.owner);
  const admission = await begin(a, free); assert.equal(admission.status, 200); assert.equal(admission.body.funding, 'emergency');
  assert.equal(admission.body.costPerBatch, 0); assert.deepEqual(await begin(a, free), admission);
  assert.equal((await finish(a, free)).status, 409);
  assert.equal((await call(other, '/api/notes/push', free.pushes[0])).status, 409);
  assert.equal((await call(a, '/api/notes/push', { ...free.pushes[0], mode: 'standard' })).status, 409);
  assert.equal((await call(a, '/api/notes/push', { ...free.pushes[0], rows: [{ ...free.pushes[0].rows[0], body: 'Public substituted body' }] })).status, 409);
  assert.deepEqual(await finance(fixture.owner), freeBefore);
  phase = 'real_free_writes_and_replay';
  const writesBefore = (await state()).writes;
  for (const [index, push] of free.pushes.entries()) {
    const delivered = await call(a, '/api/notes/push', push);
    assert.equal(delivered.status, 200); assert.equal(delivered.body.charged, 0); assert.equal(delivered.body.refunded, 0);
    // Fresh versions use the retained per-user sequence, including across batches.
    assert.equal(delivered.body.results[0].version, index + 1);
    const afterWrite = (await state()).writes;
    assert.deepEqual(await call(a, '/api/notes/push', push), delivered);
    assert.equal((await state()).writes, afterWrite);
  }
  assert.equal((await state()).writes, writesBefore + 2); assert.deepEqual(await finance(fixture.owner), freeBefore);
  const pulled = await call(FIXTURE_TOKENS.b, '/api/notes/pull'); assert.equal(pulled.status, 200);
  assert.deepEqual(pulled.body.rows.map((r: { body: string }) => r.body).sort(), free.pushes.map(p => p.rows[0].body).sort());
  assert.equal((await call(other, '/api/notes/pull')).body.rows.length, 0);
  phase = 'completion_reply_replay';
  const completed = await finish(a, free); assert.equal(completed.status, 200); assert.equal(completed.body.state, 'completed');
  // Retry after the Server has revoked this token, as after a lost completion reply.
  assert.deepEqual(await finish(a, free), completed);
  assert.equal((await call(a, '/api/notes/pull')).status, 401);
  assert.equal((await call(FIXTURE_TOKENS.b, '/api/notes/pull')).status, 200);
  assert.deepEqual(await finance(fixture.owner), freeBefore);
  phase = 'paid_conflict_abort_and_replan';
  const original = row('Public synthetic paid existing body');
  assert.equal((await call(other, '/api/notes/push', { rows: [original], requestId: randomUUID(), mode: 'instant' })).status, 200);
  const paidBefore = await finance(fixture.other), paidWrites = (await state()).writes;
  const stale = plan([[{ ...original, body: 'Public synthetic stale edit' }]]);
  assert.equal((await begin(other, stale)).body.funding, 'paid');
  const conflict = await call(other, '/api/notes/push', stale.pushes[0]);
  assert.equal(conflict.status, 502); assert.equal(conflict.body.results[0].error, 'note_conflict');
  assert.equal(conflict.body.charged, 10); assert.equal(conflict.body.refunded, 10);
  assert.equal((await state()).writes, paidWrites); assert.equal((await finish(other, stale)).status, 409);
  assert.equal((await finance(fixture.other)).energy, paidBefore.energy);
  const aborted = await abort(other, stale); assert.equal(aborted.status, 200); assert.deepEqual(await abort(other, stale), aborted);
  const corrected = plan([[{ ...original, base_version: 1, body: 'Public synthetic corrected edit' }]]);
  assert.equal((await begin(other, corrected)).body.funding, 'paid');
  const correctedReply = await call(other, '/api/notes/push', corrected.pushes[0]);
  assert.equal(correctedReply.status, 200); assert.equal(correctedReply.body.charged, 10);
  assert.deepEqual(await call(other, '/api/notes/push', corrected.pushes[0]), correctedReply);
  assert.equal((await finance(fixture.other)).energy, paidBefore.energy - 10);
  assert.equal((await call(other, '/api/notes/pull')).body.rows[0].body, corrected.pushes[0].rows[0].body);
  assert.equal((await finish(other, corrected)).status, 200);
  phase = 'free_partial_failure_preserves_session';
  await collections.atomicUsers(db).updateOne({ _id: fixture.batchOwner }, { $set: { energy: 0 } });
  const good = row('Public synthetic delivered partial body'), bad = row('Public synthetic retained failed body');
  const partial = plan([[good, bad]]), batchBefore = await finance(fixture.batchOwner);
  assert.equal((await call(a, '/__fixture/fail-writes', { ids: [bad.id] })).status, 200);
  assert.equal((await begin(batch, partial)).body.funding, 'emergency');
  const failure = await call(batch, '/api/notes/push', partial.pushes[0]);
  assert.equal(failure.status, 502); assert.equal(failure.body.charged, 0); assert.equal(failure.body.refunded, 0);
  assert.equal(failure.body.results.filter((r: { ok: boolean }) => r.ok).length, 1);
  const afterFailureWrites = (await state()).writes;
  assert.deepEqual(await call(batch, '/api/notes/push', partial.pushes[0]), failure);
  assert.equal((await state()).writes, afterFailureWrites);
  assert.equal((await finish(batch, partial)).status, 409);
  assert.equal((await call(batch, '/api/notes/pull')).status, 200); assert.deepEqual(await finance(fixture.batchOwner), batchBefore);
  assert.equal((await abort(batch, partial)).status, 200);
  assert.equal((await call(a, '/__fixture/fail-writes', { ids: [] })).status, 200);
  const remaining = plan([[bad]]); assert.equal((await begin(batch, remaining)).body.funding, 'emergency');
  assert.equal((await call(batch, '/api/notes/push', remaining.pushes[0])).status, 200);
  const all = (await call(batch, '/api/notes/pull')).body.rows;
  assert.deepEqual(all.map((r: { body: string }) => r.body).sort(), [good.body, bad.body].sort());
  assert.equal((await finish(batch, remaining)).status, 200); assert.deepEqual(await finance(fixture.batchOwner), batchBefore);
  phase = 'complete'; passed = true;
});
