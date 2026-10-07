import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { MongoClient } from 'mongodb';
import { z } from 'zod';
import { FIXTURE_TOKENS, FIXTURE_ADMIN_KEY, startClientFixture } from './clientFixture.js';

const stateSchema = z.object({ writes: z.number(), users: z.array(z.object({ userId: z.string(), energy: z.number(),
  notes: z.number(), ledger: z.array(z.object({ kind: z.string(), energyDelta: z.number() })) })) });
const receiptSchema = z.object({ charged: z.number(), refunded: z.number(),
  results: z.array(z.object({ id: z.string(), ok: z.boolean(), error: z.string() })) });

test('intervening real admin grants cap failed-sync refunds and replay keeps the stored receipt', { timeout: 60000 }, async (t) => {
  const fixture = await startClientFixture(process.env.MONGODB_URI, process.env.MONGODB_DB_NAME);
  t.after(fixture.close);
  const call = (path: string, body?: object, token: string = FIXTURE_TOKENS.a) => fetch(`${fixture.origin}${path}`, {
    method: body ? 'POST' : 'GET', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: body ? JSON.stringify(body) : undefined,
  });
  const state = async () => stateSchema.parse(await (await call('/__fixture/state')).json());
  const wallet = (s: z.infer<typeof stateSchema>) => s.users.find((u) => u.userId === fixture.owner)!;
  const invalidAdmin = await fetch(`${fixture.origin}/api/admin/energy`, { method: 'POST',
    headers: { 'content-type': 'application/json', 'x-admin-api-key': `${FIXTURE_ADMIN_KEY}-invalid` },
    body: JSON.stringify({ user_id: fixture.owner, energy_delta: 1 }) });
  assert.equal(invalidAdmin.status, 401);
  const inspector = new MongoClient(process.env.MONGODB_URI!);
  try {
    await inspector.connect();
    const db = inspector.db(fixture.database);
    for (const mode of ['partial', 'full']) {
      const noteId = randomUUID();
      assert.equal((await call('/__fixture/refund-fault', { noteId, mode }, FIXTURE_TOKENS.b)).status, 401);
      assert.equal((await call('/__fixture/refund-fault', { noteId, mode })).status, 200);
      const before = await state();
      const request = { requestId: randomUUID(), mode: 'standard', rows: [{ id: noteId, kind: 'text',
        title: 'Synthetic capped refund', body: 'Synthetic preserved offline work', items: [], pinned: false,
        deleted: false, enc_v: 0, payload: null, base_version: 0, created_at: new Date().toISOString() }] };
      const response = await call('/api/notes/push', request);
      assert.equal(response.status, 502);
      const original = await response.json();
      const receipt = receiptSchema.parse(original);
      assert.equal(receipt.charged, 5); assert.equal(receipt.refunded, mode === 'partial' ? 1 : 0);
      assert.deepEqual(receipt.results, [{ id: noteId, ok: false, error: 'note_write_failed' }]);
      const after = await state();
      assert.equal(after.writes, before.writes);
      assert.equal(wallet(after).notes, 0);
      assert.equal(wallet(after).energy, 120);
      const grant = (mode === 'partial' ? 119 : 120) - (wallet(before).energy - 5);
      const additions = wallet(after).ledger.slice(wallet(before).ledger.length);
      assert.deepEqual(additions.map((r) => r.energyDelta), mode === 'partial' ? [-5, grant, 1] : [-5, grant]);
      assert.ok(additions.every((r) => ['spend', 'admin_adjust'].includes(r.kind)));
      const storedWallet = await db.collection<{ _id: string; lastStandardSyncAt: Date | null }>('atomic_users').findOne({ _id: fixture.owner });
      assert.equal(storedWallet!.lastStandardSyncAt, null);
      const operation = await db.collection<{ _id: string; status: string; charged: number; refunded: number }>('sync_operations')
        .findOne({ _id: `${fixture.owner}:${request.requestId}` });
      assert.equal(operation!.status, 'complete');
      assert.equal(operation!.refunded, receipt.refunded);
      const replay = await call('/api/notes/push', request);
      assert.equal(replay.status, 502);
      assert.deepEqual(await replay.json(), original);
      assert.deepEqual(await state(), after);
      assert.equal((await call('/__fixture/refund-fault', { noteId, mode: 'none' })).status, 200);
    }
  } finally { await inspector.close(); }
});
