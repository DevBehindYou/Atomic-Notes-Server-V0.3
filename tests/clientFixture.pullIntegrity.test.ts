import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { MongoClient } from 'mongodb';
import { z } from 'zod';
import { FIXTURE_TOKENS, startClientFixture } from './clientFixture.js';

const receiptSchema = z.object({ results: z.array(z.object({ id: z.string(), seq: z.number() })) });
const pageSchema = z.object({ rows: z.array(z.object({ id: z.string(), body: z.string() })), nextCursor: z.number() });
const stateSchema = z.object({ writes: z.number(), users: z.array(z.unknown()) }).passthrough();

test('simulated unreadable/mismatched files refuse whole pages without changing metadata or billing', { timeout: 60000 }, async (t) => {
  const fixture = await startClientFixture(process.env.MONGODB_URI, process.env.MONGODB_DB_NAME);
  t.after(fixture.close);
  const call = (path: string, body?: object, token: string = FIXTURE_TOKENS.a) => fetch(`${fixture.origin}${path}`, {
    method: body ? 'POST' : 'GET', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: body ? JSON.stringify(body) : undefined,
  });
  const ids = [randomUUID(), randomUUID()];
  const rows = ids.map((id) => ({ id, kind: 'text', title: 'Synthetic pull fixture', body: 'Synthetic intact content',
    items: [], pinned: false, deleted: false, enc_v: 0, payload: null, base_version: 0, created_at: new Date().toISOString() }));
  const pushed = await call('/api/notes/push', { requestId: randomUUID(), mode: 'instant', rows });
  assert.equal(pushed.status, 200);
  const receipt = receiptSchema.parse(await pushed.json());
  const upper = Math.max(...receipt.results.map((r) => r.seq));
  const snapshot = stateSchema.parse(await (await call('/__fixture/state')).json());
  const inspector = new MongoClient(process.env.MONGODB_URI!);
  try {
    await inspector.connect();
    const db = inspector.db(fixture.database);
    const metadata = await db.collection('notes').find({ userId: fixture.owner }).sort({ _id: 1 }).toArray();
    const counters = db.collection<{ _id: string; value: number }>('sync_counters');
    const counter = await counters.findOne({ _id: fixture.owner });
    assert.equal((await call('/__fixture/read-fault', { noteId: ids[1], mode: 'missing' }, FIXTURE_TOKENS.b)).status, 401);
    assert.equal((await call('/__fixture/read-fault', { noteId: ids[1], mode: 'delete' })).status, 400);
    for (const mode of ['missing', 'corrupt', 'mismatch']) {
      assert.equal((await call('/__fixture/read-fault', { noteId: ids[1], mode })).status, 200);
      for (let attempt = 0; attempt < 2; attempt++) {
        const response = await call('/api/notes/pull?after=0', undefined, FIXTURE_TOKENS.b);
        assert.equal(response.status, 409);
        const error = await response.json() as Record<string, unknown>;
        assert.equal(error.error, mode === 'mismatch' ? 'note_content_mismatch' : 'note_content_unavailable');
        assert.equal(error.rows, undefined);
        assert.equal(error.nextCursor, undefined);
      }
      const state = stateSchema.parse(await (await call('/__fixture/state')).json());
      assert.equal(state.writes, snapshot.writes);
      assert.deepEqual(state.users, snapshot.users);
      assert.deepEqual(await db.collection('notes').find({ userId: fixture.owner }).sort({ _id: 1 }).toArray(), metadata);
      assert.deepEqual(await counters.findOne({ _id: fixture.owner }), counter);
      assert.equal((await call('/__fixture/read-fault', { noteId: ids[1], mode: 'none' })).status, 200);
      const recovered = await call('/api/notes/pull?after=0', undefined, FIXTURE_TOKENS.b);
      assert.equal(recovered.status, 200);
      const page = pageSchema.parse(await recovered.json());
      assert.equal(page.nextCursor, upper);
      assert.equal(page.rows.length, 2);
      assert.ok(page.rows.every((r) => r.body === 'Synthetic intact content'));
    }
  } finally { await inspector.close(); }
});
