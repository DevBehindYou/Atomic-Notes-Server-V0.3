import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { startClientFixture, FIXTURE_TOKENS } from './clientFixture.js';
import { assertFixtureCleanup } from './clientFixtureSafety.js';

const DAY = 24 * 60 * 60 * 1000;
const hash = (token: string) => createHash('sha256').update(token).digest('hex');
const names = ['hashed_issuance', 'fixed_180_days', 'expiry_boundary', 'no_inactivity_renewal',
  'newest_five', 'legacy_stored_expiry', 'logout', 'no_data_mutation', 'cleanup'] as const;
type Case = typeof names[number];

test('App sessions last a fixed 180 days without idle renewal and preserve legacy expiry/revocation',
  { timeout: 60000 }, async () => {
    const cases: Record<Case, 'pending' | 'pass'> = Object.fromEntries(names.map(name => [name, 'pending'])) as Record<Case, 'pending' | 'pass'>;
    let phase: Case | 'setup' | 'complete' = 'setup';
    let fixture: Awaited<ReturnType<typeof startClientFixture>> | undefined;
    try {
      fixture = await startClientFixture(process.env.MONGODB_URI, process.env.MONGODB_DB_NAME);
      const { getDb } = await import('../src/db/mongo.js');
      const { collections } = await import('../src/db/collections.js');
      const { createSession, verifySession, MAX_ACTIVE_SESSIONS } = await import('../src/lib/session.js');
      const db = await getDb(); assertFixtureCleanup(db.databaseName, fixture.database);
      const sessions = collections.sessions(db);
      const call = (path: string, token: string, method = 'GET') => fetch(`${fixture!.origin}${path}`, {
        method, headers: { authorization: `Bearer ${token}` },
      });
      const state = async () => (await call('/__fixture/state', FIXTURE_TOKENS.b)).json();
      const before = await state();
      // Future synthetic dates keep Mongo's independent TTL cleaner from racing
      // deterministic expiry assertions. The real helper defaults to wall time.
      const issuedAt = Date.UTC(2100, 0, 1), expiry = issuedAt + 180 * DAY;
      const token = await createSession(db, fixture.other, 'public-synthetic-lifetime', new Date(issuedAt));
      const stored = (await sessions.findOne({ _id: hash(token) }))!;

      phase = 'hashed_issuance';
      assert.match(token, /^[A-Za-z0-9_-]{43}$/); assert.equal(stored._id, hash(token));
      assert.notEqual(stored._id, token); assert.equal(await sessions.findOne({ _id: token }), null);
      assert.deepEqual(Object.keys(stored).sort(), ['_id', 'createdAt', 'expiresAt', 'revoked', 'userAgent', 'userId'].sort());
      cases[phase] = 'pass';

      phase = 'fixed_180_days';
      assert.equal(stored.createdAt.getTime(), issuedAt); assert.equal(stored.expiresAt.getTime(), expiry);
      assert.equal(stored.expiresAt.getTime() - stored.createdAt.getTime(), 180 * DAY);
      cases[phase] = 'pass';

      phase = 'no_inactivity_renewal';
      // No requests occur between issuance and day 179. Neither elapsed idle
      // time nor subsequent reads shorten or slide the persisted deadline.
      assert.equal(await verifySession(db, token, new Date(issuedAt + 179 * DAY)), fixture.other);
      for (const day of [0, 8, 30, 90, 179]) {
        assert.equal(await verifySession(db, token, new Date(issuedAt + day * DAY)), fixture.other);
        assert.deepEqual(await sessions.findOne({ _id: hash(token) }), stored);
      }
      cases[phase] = 'pass';

      phase = 'expiry_boundary';
      assert.equal(await verifySession(db, token, new Date(expiry - 1)), fixture.other);
      assert.equal(await verifySession(db, token, new Date(expiry)), null);
      assert.equal(await verifySession(db, token, new Date(expiry + 1)), null);
      assert.deepEqual(await sessions.findOne({ _id: hash(token) }), stored);
      cases[phase] = 'pass';

      phase = 'legacy_stored_expiry';
      const legacyToken = 'public-synthetic-existing-seven-day-token';
      const legacyExpiry = issuedAt + 7 * DAY;
      await sessions.insertOne({ _id: hash(legacyToken), userId: fixture.other,
        createdAt: new Date(issuedAt), expiresAt: new Date(legacyExpiry), revoked: false, userAgent: null });
      const legacyBefore = await sessions.findOne({ _id: hash(legacyToken) });
      assert.equal(await verifySession(db, legacyToken, new Date(legacyExpiry - 1)), fixture.other);
      assert.equal(await verifySession(db, legacyToken, new Date(legacyExpiry)), null);
      assert.equal(await verifySession(db, legacyToken, new Date(issuedAt + 8 * DAY)), null);
      assert.deepEqual(await sessions.findOne({ _id: hash(legacyToken) }), legacyBefore);
      cases[phase] = 'pass';

      phase = 'newest_five';
      const issued: string[] = [];
      for (let i = 0; i < 6; i++) {
        issued.push(await createSession(db, fixture.batchOwner, null, new Date(issuedAt + i)));
      }
      assert.equal(MAX_ACTIVE_SESSIONS, 5);
      assert.equal(await sessions.countDocuments({ userId: fixture.batchOwner, revoked: false }), 5);
      assert.equal(await verifySession(db, issued[0], new Date(issuedAt + DAY)), null);
      for (const current of issued.slice(1)) {
        assert.equal(await verifySession(db, current, new Date(issuedAt + DAY)), fixture.batchOwner);
      }
      assert.equal(await verifySession(db, FIXTURE_TOKENS.a), fixture.owner);
      cases[phase] = 'pass';

      phase = 'logout';
      // Real requireAuth and logout still accept/revoke a newly issued token;
      // another session on the same account remains untouched.
      const live = await createSession(db, fixture.owner, 'public-synthetic-http-session');
      const liveStored = (await sessions.findOne({ _id: hash(live) }))!;
      assert.equal(liveStored.expiresAt.getTime() - liveStored.createdAt.getTime(), 180 * DAY);
      assert.equal((await call('/api/notes/count', live)).status, 200);
      assert.equal((await call('/api/auth/logout', live, 'POST')).status, 200);
      const rejected = await call('/api/notes/count', live);
      assert.equal(rejected.status, 401); assert.deepEqual(await rejected.json(), { error: 'invalid_token' });
      assert.equal((await call('/api/notes/count', FIXTURE_TOKENS.b)).status, 200);
      cases[phase] = 'pass';

      phase = 'no_data_mutation';
      assert.deepEqual(await state(), before);
      assert.equal(await collections.notes(db).countDocuments({}), 0);
      cases[phase] = 'pass';
    } finally {
      const reachedEnd = cases.no_data_mutation === 'pass';
      try {
        if (fixture) await fixture.close();
        if (fixture) cases.cleanup = 'pass';
        if (reachedEnd && cases.cleanup === 'pass') phase = 'complete';
      } finally {
        writeFileSync('ci-session-lifetime-proof.json', JSON.stringify({ version: 1,
          scope: 'disposable fixed 180-day App session expiry; no inactivity renewal or legacy migration',
          phase, outcome: phase === 'complete' ? 'pass' : 'fail', cases }));
      }
    }
  });
