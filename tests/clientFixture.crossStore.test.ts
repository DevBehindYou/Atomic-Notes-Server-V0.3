import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { MongoClient } from 'mongodb';
import { FIXTURE_TOKENS, startClientFixture } from './clientFixture.js';
import { assertFixtureCleanup } from './clientFixtureSafety.js';

test('successful Drive overwrite followed by rejected metadata commit remains mismatched until a fresh dirty retry', { timeout: 60000 }, async (t) => {
  let phase = 'setup', passed = false;
  t.after(() => writeFileSync('ci-cross-store-proof.json', JSON.stringify({ version: 1,
    scope: 'disposable metadata rejection after fake Drive overwrite', phase, outcome: passed ? 'pass' : 'fail' })));
  const fixture = await startClientFixture(process.env.MONGODB_URI, process.env.MONGODB_DB_NAME);
  t.after(fixture.close);
  const call = (path: string, body?: object) => fetch(`${fixture.origin}${path}`, {
    method: body ? 'POST' : 'GET', headers: { 'content-type': 'application/json', authorization: `Bearer ${FIXTURE_TOKENS.a}` },
    body: body ? JSON.stringify(body) : undefined,
  });
  const state = async () => await (await call('/__fixture/state')).json() as {
    writes: number; users: { energy: number; notes: number; ledger: unknown[] }[] };
  const inspector = new MongoClient(process.env.MONGODB_URI!);
  try {
    await inspector.connect();
    const db = inspector.db(fixture.database);
    assertFixtureCleanup(db.databaseName, fixture.database);
    const id = randomUUID();
    const row = { id, kind: 'text', title: 'Synthetic cross-store fixture', body: 'Synthetic canonical old body',
      items: [], pinned: false, deleted: false, enc_v: 0, payload: null, base_version: 0, created_at: new Date().toISOString() };
    phase = 'baseline';
    assert.equal((await call('/api/notes/push', { requestId: randomUUID(), mode: 'instant', rows: [row] })).status, 200);
    const metadata = await db.collection('notes').findOne({ userId: fixture.owner });
    const counter = await db.collection<{ _id: string }>('sync_counters').findOne({ _id: fixture.owner });
    const before = await state();
    assert.equal(before.writes, 1); assert.equal(before.users[0].energy, 90);
    // This validator is installed only in this generated, owned test database.
    // It refuses one selected note's metadata update after the real Drive seam
    // succeeded; it does not modify the note or simulate a pull response.
    phase = 'metadata_rejection';
    await db.command({ collMod: 'notes', validator: { _id: { $ne: id } }, validationLevel: 'strict', validationAction: 'error' });
    const edited = { ...row, body: 'Synthetic uncommitted newer body', base_version: 1 };
    const request = { requestId: randomUUID(), mode: 'instant', rows: [edited] };
    const response = await call('/api/notes/push', request);
    assert.equal(response.status, 502);
    const receipt = await response.json() as { charged: number; refunded: number; results: { ok: boolean; error: string }[] };
    assert.equal(receipt.charged, 10); assert.equal(receipt.refunded, 10);
    assert.equal(receipt.results[0].ok, false); assert.equal(receipt.results[0].error, 'note_write_failed');
    const failed = await state();
    assert.equal(failed.writes, 2); assert.equal(failed.users[0].energy, 90); assert.equal(failed.users[0].notes, 1);
    assert.deepEqual(await db.collection('notes').findOne({ userId: fixture.owner }), metadata);
    assert.deepEqual(await db.collection<{ _id: string }>('sync_counters').findOne({ _id: fixture.owner }), counter);
    const refusedPull = async () => {
      const pull = await call('/api/notes/pull?after=0');
      assert.equal(pull.status, 409);
      const error = await pull.json() as Record<string, unknown>;
      assert.equal(error.error, 'note_content_mismatch');
      assert.equal(error.rows, undefined); assert.equal(error.nextCursor, undefined);
    };
    phase = 'unsafe_pull_refused'; await refusedPull();
    // The real refused pull reads Drive, so capture its diagnostic counters
    // before checking that the following replay itself changes nothing.
    const beforeReplay = await state();
    phase = 'failed_replay';
    const replay = await call('/api/notes/push', request);
    assert.equal(replay.status, 502); assert.deepEqual(await replay.json(), receipt);
    assert.deepEqual(await state(), beforeReplay);
    phase = 'validator_removed';
    await db.command({ collMod: 'notes', validator: {}, validationLevel: 'strict', validationAction: 'error' });
    await refusedPull();
    phase = 'unchanged_is_not_repair';
    const unchanged = await call('/api/notes/push', { requestId: randomUUID(), mode: 'instant', rows: [{ ...row, base_version: 1 }] });
    assert.equal(unchanged.status, 200);
    const acknowledged = await unchanged.json() as { charged: number; refunded: number; results: { unchanged: boolean; version: number }[] };
    assert.equal(acknowledged.results[0].unchanged, true); assert.equal(acknowledged.results[0].version, 1);
    assert.equal(acknowledged.charged, 10); assert.equal(acknowledged.refunded, 0);
    const stillBroken = await state();
    assert.equal(stillBroken.writes, 2); assert.equal(stillBroken.users[0].energy, 80);
    await refusedPull();
    phase = 'fresh_dirty_retry';
    const retry = await call('/api/notes/push', { ...request, requestId: randomUUID() });
    assert.equal(retry.status, 200);
    const pulled = await call('/api/notes/pull?after=0');
    assert.equal(pulled.status, 200);
    const page = await pulled.json() as { nextCursor: number; rows: { body: string; version: number }[] };
    assert.equal(page.nextCursor, 2); assert.equal(page.rows[0].version, 2); assert.equal(page.rows[0].body, edited.body);
    const recovered = await state();
    assert.equal(recovered.writes, 3); assert.equal(recovered.users[0].energy, 70);
    phase = 'complete'; passed = true;
  } finally { await inspector.close(); }
});
