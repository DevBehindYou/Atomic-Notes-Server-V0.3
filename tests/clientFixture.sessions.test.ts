import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { MongoClient } from 'mongodb';
import { z } from 'zod';
import { FIXTURE_TOKENS, startClientFixture } from './clientFixture.js';

const stateSchema = z.object({ writes: z.number(), users: z.array(z.unknown()) });
type SessionRow = { _id: string; userId: string; createdAt: Date; expiresAt: Date; revoked: boolean };
const hash = (token: string) => createHash('sha256').update(token).digest('hex');

test('real logout retires only its session; expiry, hashed issuance and five-session cap apply', { timeout: 60000 }, async (t) => {
  const fixture = await startClientFixture(process.env.MONGODB_URI, process.env.MONGODB_DB_NAME);
  t.after(fixture.close);
  const call = (path: string, token: string, method = 'GET') => fetch(`${fixture.origin}${path}`, {
    method, headers: { authorization: `Bearer ${token}` },
  });
  const state = async () => stateSchema.parse(await (await call('/__fixture/state', FIXTURE_TOKENS.b)).json());
  const before = await state();
  assert.equal((await call('/api/notes/count', FIXTURE_TOKENS.a)).status, 200);
  assert.equal((await call('/api/auth/logout', FIXTURE_TOKENS.a, 'POST')).status, 200);
  const retired = await call('/api/notes/count', FIXTURE_TOKENS.a);
  assert.equal(retired.status, 401); assert.deepEqual(await retired.json(), { error: 'invalid_token' });
  assert.equal((await call('/api/auth/logout', FIXTURE_TOKENS.a, 'POST')).status, 401);
  for (const token of [FIXTURE_TOKENS.b, FIXTURE_TOKENS.other, FIXTURE_TOKENS.batch]) {
    assert.equal((await call('/api/notes/count', token)).status, 200);
  }
  assert.deepEqual(await state(), before);
  const inspector = new MongoClient(process.env.MONGODB_URI!);
  try {
    await inspector.connect();
    const db = inspector.db(fixture.database);
    const sessions = db.collection<SessionRow>('sessions');
    assert.equal((await sessions.findOne({ _id: hash(FIXTURE_TOKENS.a) }))!.revoked, true);
    assert.equal((await sessions.findOne({ _id: hash(FIXTURE_TOKENS.b) }))!.revoked, false);
    // Only this generated namespace is modified. Expiry is checked by auth,
    // independent of whether Mongo's background TTL cleanup has run.
    await sessions.updateOne({ _id: hash(FIXTURE_TOKENS.other) }, { $set: { expiresAt: new Date(0) } });
    assert.equal((await call('/api/notes/count', FIXTURE_TOKENS.other)).status, 401);
    assert.equal((await call('/api/notes/count', FIXTURE_TOKENS.b)).status, 200);
    const { createSession, verifySession, MAX_ACTIVE_SESSIONS } = await import('../src/lib/session.js');
    const issued: string[] = [];
    for (let i = 0; i < 6; i++) issued.push(await createSession(db, fixture.owner, 'synthetic-session-proof'));
    for (const token of issued) {
      const stored = (await sessions.findOne({ _id: hash(token) }))!;
      assert.equal(stored.userId, fixture.owner);
      assert.notEqual(stored._id, token);
      assert.equal(stored.expiresAt.getTime() - stored.createdAt.getTime(), 7 * 24 * 60 * 60 * 1000);
    }
    assert.equal(MAX_ACTIVE_SESSIONS, 5);
    assert.equal(await sessions.countDocuments({ userId: fixture.owner, revoked: false }), 5);
    const accepted = await Promise.all(issued.map((token) => verifySession(db, token)));
    assert.equal(accepted.filter((user) => user === fixture.owner).length, 5);
    const validIndex = accepted.findIndex((user) => user === fixture.owner);
    assert.equal((await call('/api/notes/count', issued[validIndex])).status, 200);
    assert.deepEqual(await state(), before);
  } finally { await inspector.close(); }
});
