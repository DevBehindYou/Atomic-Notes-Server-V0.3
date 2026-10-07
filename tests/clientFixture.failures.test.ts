import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { FIXTURE_TOKENS, startClientFixture } from './clientFixture.js';

const stateSchema = z.object({ writes: z.number(), writeAttempts: z.number(), writeFailures: z.number(),
  users: z.array(z.object({ energy: z.number(), notes: z.number(),
    ledger: z.array(z.object({ energyDelta: z.number() }).passthrough()) }).passthrough()) }).passthrough();
const receiptSchema = z.object({ charged: z.number(), refunded: z.number(),
  results: z.array(z.object({ id: z.string(), ok: z.boolean(), error: z.string().optional() }).passthrough()) }).passthrough();

test('bounded fixture failures prove partial/all-failed receipts and immutable replay', { timeout: 60000 }, async (t) => {
  const fixture = await startClientFixture(process.env.MONGODB_URI, process.env.MONGODB_DB_NAME);
  t.after(fixture.close);
  const call = (path: string, body?: object, token: string = FIXTURE_TOKENS.a) => fetch(`${fixture.origin}${path}`, {
    method: body ? 'POST' : 'GET', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: body ? JSON.stringify(body) : undefined,
  });
  const state = async () => stateSchema.parse(await (await call('/__fixture/state')).json());
  const arm = async (ids: string[]) => assert.equal((await call('/__fixture/fail-writes', { ids })).status, 200);
  const row = (id: string) => ({ id, kind: 'text', title: 'Failure fixture', body: 'Synthetic',
    items: [], pinned: false, deleted: false, enc_v: 0, payload: null, base_version: 0,
    created_at: new Date().toISOString() });
  assert.equal((await call('/__fixture/fail-writes', { ids: [] }, 'invalid-fixture-token')).status, 401);
  assert.equal((await call('/__fixture/fail-writes', { ids: ['invalid'] })).status, 400);
  const acceptedId = randomUUID(), refusedId = randomUUID(), allFailedId = randomUUID();
  await arm([refusedId]);
  const initial = await state();
  const partialRequest = { requestId: randomUUID(), mode: 'instant', rows: [row(acceptedId), row(refusedId)] };
  const partialResponse = await call('/api/notes/push', partialRequest);
  assert.equal(partialResponse.status, 502);
  const partial = receiptSchema.parse(await partialResponse.json());
  assert.equal(partial.charged, 10); assert.equal(partial.refunded, 0);
  assert.equal(partial.results.find((entry) => entry.id === acceptedId)!.ok, true);
  assert.equal(partial.results.find((entry) => entry.id === refusedId)!.error, 'note_write_failed');
  const committed = await state();
  assert.equal(committed.writes, initial.writes + 1);
  assert.equal(committed.writeAttempts, initial.writeAttempts + 2);
  assert.equal(committed.writeFailures, initial.writeFailures + 1);
  assert.equal(committed.users[0].energy, initial.users[0].energy - 10);
  assert.equal(committed.users[0].notes, initial.users[0].notes + 1);
  assert.deepEqual(await (await call('/api/notes/push', partialRequest, FIXTURE_TOKENS.b)).json(), partial);
  assert.deepEqual(await state(), committed);

  await arm([allFailedId]);
  const failedRequest = { requestId: randomUUID(), mode: 'instant', rows: [row(allFailedId)] };
  const failedResponse = await call('/api/notes/push', failedRequest);
  assert.equal(failedResponse.status, 502);
  const failed = receiptSchema.parse(await failedResponse.json());
  assert.equal(failed.charged, 10); assert.equal(failed.refunded, 10);
  assert.ok(failed.results.every((entry) => !entry.ok && entry.error === 'note_write_failed'));
  const refunded = await state();
  assert.equal(refunded.users[0].energy, committed.users[0].energy);
  assert.equal(refunded.users[0].notes, committed.users[0].notes);
  assert.equal(refunded.writes, committed.writes);
  assert.equal(refunded.writeAttempts, committed.writeAttempts + 1);
  assert.equal(refunded.writeFailures, committed.writeFailures + 1);
  assert.equal(refunded.users[0].ledger.filter((entry) => entry.energyDelta === -10).length, 2);
  assert.equal(refunded.users[0].ledger.filter((entry) => entry.energyDelta === 10).length, 1);
  assert.deepEqual(await (await call('/api/notes/push', failedRequest)).json(), failed);
  assert.deepEqual(await state(), refunded);

  await arm([]);
  // Repairing the fake adapter cannot change a completed operation's results.
  assert.deepEqual(await (await call('/api/notes/push', failedRequest)).json(), failed);
  assert.deepEqual(await state(), refunded);
  const retried = await call('/api/notes/push', { ...failedRequest, requestId: randomUUID() });
  assert.equal(retried.status, 200);
  const recovered = await state();
  assert.equal(recovered.writes, refunded.writes + 1);
  assert.equal(recovered.users[0].energy, refunded.users[0].energy - 10);
  assert.equal(recovered.users[0].notes, refunded.users[0].notes + 1);
});
