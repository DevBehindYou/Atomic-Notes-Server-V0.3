import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { MongoClient } from 'mongodb';
import { z } from 'zod';
import { FIXTURE_TOKENS, startClientFixture } from './clientFixture.js';

const receiptSchema = z.object({ charged: z.number(), refunded: z.number(), results: z.array(z.object({ id: z.string(), ok: z.boolean(), seq: z.number() })) });
const stateSchema = z.object({ writes: z.number(), users: z.array(z.object({ userId: z.string(), energy: z.number(), notes: z.number(), ledger: z.array(z.unknown()) })) });
const pageSchema = z.object({ rows: z.array(z.object({ id: z.string(), body: z.string(), version: z.number() })), nextCursor: z.number(), hasMore: z.boolean() });

test('isolated capacity-tier fixture charges each batch, refuses standard cooldown and pages 51 rows', { timeout: 60000 }, async (t) => {
  const fixture = await startClientFixture(process.env.MONGODB_URI, process.env.MONGODB_DB_NAME);
  t.after(fixture.close);
  const call = (path: string, body?: object) => fetch(`${fixture.origin}${path}`, {
    method: body ? 'POST' : 'GET', headers: { 'content-type': 'application/json', authorization: `Bearer ${FIXTURE_TOKENS.batch}` },
    body: body ? JSON.stringify(body) : undefined,
  });
  const state = async () => stateSchema.parse(await (await call('/__fixture/state')).json());
  const wallet = (s: z.infer<typeof stateSchema>) => s.users.find((u) => u.userId === fixture.batchOwner)!;
  const rows = Array.from({ length: 51 }, () => ({ id: randomUUID(), kind: 'text', title: 'Synthetic batch fixture',
    body: 'Synthetic multi-byte content 雪', items: [], pinned: false, deleted: false, enc_v: 0, payload: null,
    base_version: 0, created_at: new Date().toISOString() }));
  const initial = await state();
  const request = { requestId: randomUUID(), mode: 'standard', rows: rows.slice(0, 50) };
  const first = await call('/api/notes/push', request);
  assert.equal(first.status, 200);
  const receipt = receiptSchema.parse(await first.json());
  assert.equal(receipt.results.length, 50); assert.ok(receipt.results.every((r) => r.ok));
  assert.equal(receipt.charged, 5); assert.equal(receipt.refunded, 0);
  const afterFirst = await state();
  assert.equal(wallet(afterFirst).energy, wallet(initial).energy - 5);
  assert.equal(wallet(afterFirst).notes, 50);
  assert.equal(afterFirst.writes, initial.writes + 50);
  const refusedRequest = { requestId: randomUUID(), mode: 'standard', rows: rows.slice(50) };
  const refused = await call('/api/notes/push', refusedRequest);
  assert.equal(refused.status, 429);
  assert.equal((await refused.json() as { error: string }).error, 'sync_cooldown');
  assert.deepEqual(await state(), afterFirst);
  const inspector = new MongoClient(process.env.MONGODB_URI!);
  try {
    await inspector.connect();
    const db = inspector.db(fixture.database);
    assert.equal((await db.collection<{ _id: string; noteLimit: number }>('atomic_users').findOne({ _id: fixture.batchOwner }))!.noteLimit, 100);
    assert.equal(await db.collection<{ _id: string }>('sync_operations').countDocuments({ _id: `${fixture.batchOwner}:${refusedRequest.requestId}` }), 0);
    const instant = await call('/api/notes/push', { ...refusedRequest, requestId: randomUUID(), mode: 'instant' });
    assert.equal(instant.status, 200);
    const second = receiptSchema.parse(await instant.json());
    assert.equal(second.results.length, 1); assert.equal(second.charged, 10); assert.equal(second.refunded, 0);
    const afterBoth = await state();
    assert.equal(wallet(afterBoth).energy, wallet(initial).energy - 15);
    assert.equal(wallet(afterBoth).notes, 51);
    assert.equal(wallet(afterBoth).ledger.length, wallet(initial).ledger.length + 2);
    assert.equal(afterBoth.writes, initial.writes + 51);
    const seen: string[] = []; let cursor = 0; let pages = 0;
    for (;;) {
      const response = await call(`/api/notes/pull?after=${cursor}`);
      assert.equal(response.status, 200);
      const page = pageSchema.parse(await response.json());
      pages++; assert.ok(pages <= 6); assert.ok(page.rows.length <= 10);
      assert.ok(page.nextCursor > cursor);
      seen.push(...page.rows.map((r) => r.id));
      assert.ok(page.rows.every((r) => r.body === rows[0].body));
      cursor = page.nextCursor;
      if (!page.hasMore) break;
    }
    assert.equal(pages, 6); assert.equal(cursor, 51);
    assert.deepEqual(new Set(seen), new Set(rows.map((r) => r.id))); assert.equal(seen.length, 51);
    assert.deepEqual(await state(), afterBoth);
    assert.deepEqual(await (await call('/api/notes/push', request)).json(), receipt);
    assert.deepEqual(await state(), afterBoth);
  } finally { await inspector.close(); }
});
