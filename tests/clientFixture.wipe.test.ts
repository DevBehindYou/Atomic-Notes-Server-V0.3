import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { MongoClient } from 'mongodb';
import { z } from 'zod';
import { FIXTURE_TOKENS, startClientFixture } from './clientFixture.js';

const pageSchema = z.object({ rows: z.array(z.object({ id: z.string(), body: z.string(), deleted: z.boolean() })), nextCursor: z.number() });
const stateSchema = z.object({ writes: z.number(), liveFiles: z.number(), users: z.array(z.object({
  userId: z.string(), energy: z.number(), notes: z.number(), ledger: z.array(z.unknown()),
})) });

test('cloud wipe leaves no tombstones, retains cursor and receipts, and isolates other owners', { timeout: 60000 }, async (t) => {
  const fixture = await startClientFixture(process.env.MONGODB_URI, process.env.MONGODB_DB_NAME);
  t.after(fixture.close);
  const call = (path: string, method = 'GET', body?: object, token: string = FIXTURE_TOKENS.a) => fetch(`${fixture.origin}${path}`, {
    method, headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: body ? JSON.stringify(body) : undefined,
  });
  const row = () => ({ id: randomUUID(), kind: 'text', title: 'Synthetic wipe fixture', body: 'Synthetic retained local content',
    items: [], pinned: false, deleted: false, enc_v: 0, payload: null, base_version: 0, created_at: new Date().toISOString() });
  const request = { requestId: randomUUID(), mode: 'instant', rows: [row(), row()] };
  const pushed = await call('/api/notes/push', 'POST', request);
  assert.equal(pushed.status, 200);
  const receipt = await pushed.json();
  const otherRequest = { requestId: randomUUID(), mode: 'instant', rows: [row()] };
  assert.equal((await call('/api/notes/push', 'POST', otherRequest, FIXTURE_TOKENS.other)).status, 200);
  const beforePage = pageSchema.parse(await (await call('/api/notes/pull', 'GET', undefined, FIXTURE_TOKENS.b)).json());
  assert.equal(beforePage.rows.length, 2);
  const before = stateSchema.parse(await (await call('/__fixture/state')).json());
  const inspector = new MongoClient(process.env.MONGODB_URI!);
  try {
    await inspector.connect();
    const db = inspector.db(fixture.database);
    const counters = db.collection<{ _id: string; value: number }>('sync_counters');
    const counter = await counters.findOne({ _id: fixture.owner });
    const otherMetadata = await db.collection('notes').find({ userId: fixture.other }).toArray();
    assert.equal((await call('/api/notes', 'DELETE', undefined, 'invalid-fixture-token')).status, 401);
    assert.equal(await db.collection('notes').countDocuments({ userId: fixture.owner }), 2);
    const wiped = await call('/api/notes', 'DELETE');
    assert.equal(wiped.status, 200);
    assert.deepEqual(await wiped.json(), { ok: true, deleted: 2 });
    assert.equal(await db.collection('notes').countDocuments({ userId: fixture.owner }), 0);
    assert.equal(await db.collection('notes').countDocuments({ userId: fixture.owner, deleted: true }), 0);
    assert.deepEqual(await counters.findOne({ _id: fixture.owner }), counter);
    assert.deepEqual(await db.collection('notes').find({ userId: fixture.other }).toArray(), otherMetadata);
    for (const after of [0, beforePage.nextCursor]) {
      const response = await call(`/api/notes/pull?after=${after}`, 'GET', undefined, FIXTURE_TOKENS.b);
      assert.equal(response.status, 200);
      const page = pageSchema.parse(await response.json());
      assert.deepEqual(page.rows, []);
      assert.equal(page.nextCursor, beforePage.nextCursor);
    }
    const after = stateSchema.parse(await (await call('/__fixture/state')).json());
    assert.equal(after.liveFiles, before.liveFiles - 2);
    assert.equal(after.writes, before.writes + 2);
    assert.deepEqual(after.users.map(({ userId, energy, ledger }) => ({ userId, energy, ledger })),
      before.users.map(({ userId, energy, ledger }) => ({ userId, energy, ledger })));
    assert.deepEqual(await (await call('/api/notes/push', 'POST', request, FIXTURE_TOKENS.b)).json(), receipt);
    const replayed = stateSchema.parse(await (await call('/__fixture/state')).json());
    assert.deepEqual(replayed, after);
    assert.equal(await db.collection('notes').countDocuments({ userId: fixture.owner }), 0);
    const repeated = await call('/api/notes', 'DELETE');
    assert.equal(repeated.status, 200);
    assert.deepEqual(await repeated.json(), { ok: true, deleted: 0 });
    assert.deepEqual(stateSchema.parse(await (await call('/__fixture/state')).json()), after);
    const otherPage = pageSchema.parse(await (await call('/api/notes/pull', 'GET', undefined, FIXTURE_TOKENS.other)).json());
    assert.equal(otherPage.rows[0].body, otherRequest.rows[0].body);
    assert.equal(otherPage.rows[0].deleted, false);
  } finally { await inspector.close(); }
});
