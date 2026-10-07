import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { FIXTURE_TOKENS, startClientFixture } from './clientFixture.js';

const receiptSchema = z.object({ charged: z.number(), refunded: z.number(),
  results: z.array(z.object({ id: z.string(), ok: z.boolean(), version: z.number(), error: z.string().optional() })) });
const stateSchema = z.object({ writes: z.number(), writeAttempts: z.number(),
  users: z.array(z.object({ energy: z.number(), notes: z.number(),
    ledger: z.array(z.object({ energyDelta: z.number() }).passthrough()) }).passthrough()) }).passthrough();
const pageSchema = z.object({ rows: z.array(z.object({ id: z.string(), deleted: z.boolean(),
  version: z.number(), body: z.string() }).passthrough()) }).passthrough();

test('stale deletes and edits preserve the accepted version and replay without another charge', { timeout: 60000 }, async (t) => {
  const fixture = await startClientFixture(process.env.MONGODB_URI, process.env.MONGODB_DB_NAME);
  t.after(fixture.close);
  const call = (path: string, body?: object, token: string = FIXTURE_TOKENS.a) => fetch(`${fixture.origin}${path}`, {
    method: body ? 'POST' : 'GET', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: body ? JSON.stringify(body) : undefined,
  });
  const state = async () => stateSchema.parse(await (await call('/__fixture/state')).json());
  const id = randomUUID();
  const original = { id, kind: 'text', title: 'Synthetic delete conflict', body: 'Original fixture', items: [],
    pinned: false, deleted: false, enc_v: 0, payload: null, base_version: 0, created_at: new Date().toISOString() };
  const push = async (row: typeof original, token: string = FIXTURE_TOKENS.a) => {
    const request = { requestId: randomUUID(), mode: 'instant', rows: [row] };
    const response = await call('/api/notes/push', request, token);
    return { request, status: response.status, receipt: receiptSchema.parse(await response.json()) };
  };
  const created = await push(original);
  assert.equal(created.status, 200);
  const base = created.receipt.results[0].version;
  const edit = { ...original, body: 'Accepted fixture edit', base_version: base };
  const edited = await push(edit, FIXTURE_TOKENS.b);
  assert.equal(edited.status, 200);
  const acceptedVersion = edited.receipt.results[0].version;
  assert.equal(acceptedVersion, base + 1);

  const verifyRefused = async (row: typeof original, expectedVersion: number) => {
    const before = await state();
    const rejected = await push(row);
    assert.equal(rejected.status, 502);
    assert.equal(rejected.receipt.charged, 10);
    assert.equal(rejected.receipt.refunded, 10);
    assert.deepEqual(rejected.receipt.results, [{ id, ok: false, error: 'note_conflict', version: expectedVersion }]);
    const after = await state();
    assert.equal(after.writes, before.writes);
    assert.equal(after.writeAttempts, before.writeAttempts);
    assert.equal(after.users[0].energy, before.users[0].energy);
    assert.equal(after.users[0].notes, before.users[0].notes);
    assert.equal(after.users[0].ledger.length, before.users[0].ledger.length + 2);
    const replay = await call('/api/notes/push', rejected.request, FIXTURE_TOKENS.b);
    assert.equal(replay.status, 502);
    assert.deepEqual(receiptSchema.parse(await replay.json()), rejected.receipt);
    assert.deepEqual(await state(), after);
  };

  await verifyRefused({ ...original, deleted: true, base_version: base }, acceptedVersion);
  const live = pageSchema.parse(await (await call('/api/notes/pull', undefined, FIXTURE_TOKENS.b)).json());
  assert.equal(live.rows[0].id, id);
  assert.equal(live.rows[0].deleted, false);
  assert.equal(live.rows[0].body, edit.body);
  assert.equal(live.rows[0].version, acceptedVersion);

  const removed = await push({ ...edit, deleted: true, base_version: acceptedVersion }, FIXTURE_TOKENS.b);
  assert.equal(removed.status, 200);
  const tombstoneVersion = removed.receipt.results[0].version;
  assert.equal(tombstoneVersion, acceptedVersion + 1);
  assert.equal((await state()).users[0].notes, 0);
  await verifyRefused({ ...edit, body: 'Stale fixture edit', base_version: acceptedVersion }, tombstoneVersion);
  const deleted = pageSchema.parse(await (await call('/api/notes/pull')).json());
  assert.equal(deleted.rows[0].id, id);
  assert.equal(deleted.rows[0].deleted, true);
  assert.equal(deleted.rows[0].version, tombstoneVersion);

  // A deliberate restore based on the current tombstone is accepted normally.
  const restored = await push({ ...edit, deleted: false, base_version: tombstoneVersion });
  assert.equal(restored.status, 200);
  assert.equal(restored.receipt.results[0].version, tombstoneVersion + 1);
  assert.equal((await state()).users[0].notes, 1);
});
