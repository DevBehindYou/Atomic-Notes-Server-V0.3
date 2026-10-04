import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { MongoClient } from 'mongodb';
import { z } from 'zod';
import { FIXTURE_TOKENS, startClientFixture } from './clientFixture.js';

const receiptSchema = z.object({ charged: z.number(), refunded: z.number(),
  results: z.array(z.object({ version: z.number() }).passthrough()) }).passthrough();
const stateSchema = z.object({ writes: z.number(), reads: z.number(), liveFiles: z.number(),
  users: z.array(z.object({ userId: z.string(), energy: z.number(), notes: z.number(),
    ledger: z.array(z.object({ kind: z.string(), energyDelta: z.number() })) })) });
const pageSchema = z.object({ rows: z.array(z.object({ id: z.string(), body: z.string(), version: z.number() })) });

test('disposable HTTP fixture serves real auth/push/pull/replay and drops only its database', { timeout: 60000 }, async (t) => {
  const fixture = await startClientFixture(process.env.MONGODB_URI, process.env.MONGODB_DB_NAME);
  t.after(fixture.close);
  const call = (path: string, method = 'GET', body?: object, token?: string) => fetch(`${fixture.origin}${path}`, {
    method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  assert.equal((await call('/api/notes/count')).status, 401);
  assert.equal((await call('/api/notes/count', 'GET', undefined, 'invalid-fixture-token')).status, 401);
  const id = randomUUID();
  const request = { requestId: randomUUID(), mode: 'instant', rows: [{ id, kind: 'text',
    title: 'Synthetic fixture title', body: 'Synthetic fixture body', items: [], pinned: false,
    deleted: false, created_at: new Date().toISOString(), enc_v: 0, payload: null, base_version: 0 }] };
  const pushed = await call('/api/notes/push', 'POST', request, FIXTURE_TOKENS.a);
  assert.equal(pushed.status, 200);
  const receipt = receiptSchema.parse(await pushed.json());
  assert.equal(receipt.charged, 10); assert.equal(receipt.refunded, 0);
  assert.equal(receipt.results[0].version, 1);
  const state = stateSchema.parse(await (await call('/__fixture/state')).json());
  assert.equal(state.writes, 1);
  assert.equal(state.users[0].energy, 90); assert.equal(state.users[0].notes, 1);
  assert.equal(state.users[0].ledger.filter((entry: { energyDelta: number }) => entry.energyDelta === -10).length, 1);
  assert.deepEqual(await (await call('/api/notes/push', 'POST', request, FIXTURE_TOKENS.b)).json(), receipt);
  const replayed = stateSchema.parse(await (await call('/__fixture/state')).json());
  assert.equal(replayed.writes, 1); assert.deepEqual(replayed.users, state.users);
  const pull = await call('/api/notes/pull', 'GET', undefined, FIXTURE_TOKENS.b);
  assert.equal(pull.status, 200);
  const page = pageSchema.parse(await pull.json());
  assert.equal(page.rows[0].id, id); assert.equal(page.rows[0].body, request.rows[0].body);
  assert.equal(page.rows[0].version, 1);
  assert.deepEqual(await (await call('/api/notes/count', 'GET', undefined, FIXTURE_TOKENS.other)).json(), { count: 0 });
  const inspector = new MongoClient(process.env.MONGODB_URI!);
  try {
    await inspector.connect();
    const db = inspector.db(fixture.database);
    const stored = await db.collection<{ _id: string; title?: unknown; body?: unknown }>('notes').findOne({ _id: id });
    assert.equal(stored!.title, undefined); assert.equal(stored!.body, undefined);
    await fixture.close(); await fixture.close();
    const catalog = await inspector.db('admin').admin().listDatabases({ nameOnly: true });
    assert.ok(!catalog.databases.some((item) => item.name === fixture.database));
  } finally { await inspector.close(); }
});
