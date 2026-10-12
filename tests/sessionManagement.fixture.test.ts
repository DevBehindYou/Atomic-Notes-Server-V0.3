import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import type { Db } from 'mongodb';
import { startClientFixture, FIXTURE_TOKENS } from './clientFixture.js';
import { assertFixtureCleanup } from './clientFixtureSafety.js';

const hash = (token: string) => createHash('sha256').update(token).digest('hex');
const codes = ['list_whitelist', 'five_and_tie_order', 'overflow', 'retired_excluded', 'agent_filter',
  'auth_and_body_guards', 'selected_other', 'private_idempotence', 'current_refusal', 'bound_logout_refusal',
  'invalid_inventory', 'query_timeout_control', 'revision_exhaustion', 'late_read_auth', 'late_noop_auth', 'concurrent_current_revoke',
  'concurrent_target_attempt', 'concurrent_target_revoke', 'transaction_rollback', 'no_note_or_wallet_mutation', 'cleanup'] as const;
type Code = typeof codes[number];
type List = { sessions: { session_handle: string; created_at: string; expires_at: string;
  is_current: boolean; agent_label: string | null }[]; limit: number };

test('manual session management is bounded private and transactionally fenced from logout races',
  { timeout: 90000 }, async () => {
    let phase: Code | 'setup' | 'complete' = 'setup';
    const cases = Object.fromEntries(codes.map(code => [code, 'pending'])) as Record<Code, 'pending' | 'pass'>;
    let fixture: Awaited<ReturnType<typeof startClientFixture>> | undefined;
    try {
      fixture = await startClientFixture(process.env.MONGODB_URI, process.env.MONGODB_DB_NAME);
      const { getDb } = await import('../src/db/mongo.js');
      const { collections } = await import('../src/db/collections.js');
      const { listManagedSessions, revokeManagedSession } = await import('../src/lib/sessionManagement.js');
      const db = await getDb(); assertFixtureCleanup(db.databaseName, fixture.database);
      const sessions = collections.sessions(db);
      // Expired rows must remain for exact no-mutation assertions. This removes
      // TTL cleanup only from this generated namespace; auth still checks expiry.
      await sessions.dropIndex('expiresAt_1');
      const original = await sessions.find({}).sort({ _id: 1 }).toArray();
      const currentId = hash(FIXTURE_TOKENS.a), targetId = hash(FIXTURE_TOKENS.b);
      const reset = async () => { await sessions.deleteMany({}); await sessions.insertMany(structuredClone(original)); };
      const sessionState = () => sessions.find({}).sort({ _id: 1 }).toArray();
      const outsideSessions = async () => {
        const names = (await db.listCollections().toArray()).map(row => row.name).filter(name => name !== 'sessions').sort();
        return Promise.all(names.map(async name => ({ name, rows: await db.collection(name).find({}).sort({ _id: 1 }).toArray() })));
      };
      const unchanged = await outsideSessions();
      const request = (path: string, token: string | undefined = FIXTURE_TOKENS.a, body?: string) => fetch(`${fixture!.origin}${path}`, {
        method: body === undefined ? 'GET' : 'POST', headers: {
          ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        }, ...(body === undefined ? {} : { body }),
      });
      const list = async (token: string = FIXTURE_TOKENS.a) => {
        const response = await request('/api/auth/sessions', token); assert.equal(response.status, 200);
        assert.equal(response.headers.get('cache-control'), 'no-store'); return await response.json() as List;
      };
      const revoke = (handle: string, token: string = FIXTURE_TOKENS.a) => request('/api/auth/sessions/revoke', token, JSON.stringify({ session_handle: handle }));
      const refuse = async (run: () => Promise<unknown>, status: number, error: string) => {
        await assert.rejects(run, (reason: unknown) => reason instanceof Error && reason.message === error &&
          (reason as Error & { status?: number }).status === status);
      };
      const insert = async (token: string, offset: number, agent: string | null = null) => {
        const now = Date.now();
        await sessions.insertOne({ _id: hash(token), userId: fixture!.owner, createdAt: new Date(now + offset),
          expiresAt: new Date(now + 180 * 86400000), revoked: false, userAgent: agent });
      };
      const owner = fixture.owner;

      phase = 'list_whitelist';
      const beforeList = await sessionState(), dto = await list();
      assert.deepEqual(Object.keys(dto).sort(), ['limit', 'sessions']); assert.equal(dto.limit, 5); assert.equal(dto.sessions.length, 2);
      for (const row of dto.sessions) {
        assert.deepEqual(Object.keys(row).sort(), ['agent_label', 'created_at', 'expires_at', 'is_current', 'session_handle']);
        assert.match(row.session_handle, /^[A-Za-z0-9_-]{43}$/);
        assert.ok(Number.isFinite(Date.parse(row.created_at))); assert.ok(Number.isFinite(Date.parse(row.expires_at)));
        assert.equal(typeof row.is_current, 'boolean');
      }
      assert.equal(dto.sessions.filter(row => row.is_current).length, 1);
      const serialized = JSON.stringify(dto);
      for (const row of original) assert.equal(serialized.includes(row._id), false);
      for (const token of Object.values(FIXTURE_TOKENS)) assert.equal(serialized.includes(token), false);
      assert.deepEqual(await sessionState(), beforeList);
      const currentHandle = dto.sessions.find(row => row.is_current)!.session_handle;
      const targetHandle = dto.sessions.find(row => !row.is_current)!.session_handle;
      cases[phase] = 'pass';

      phase = 'five_and_tie_order';
      for (let i = 0; i < 3; i++) await insert(`public-management-extra-${i}`, 1000 + i, `public-order-${i}`);
      const tiedAt = new Date(Date.now() + 2000);
      await sessions.updateMany({ userId: owner }, { $set: { createdAt: tiedAt } });
      const five = await list(), sorted = await sessions.find({ userId: owner }).sort({ _id: -1 }).toArray();
      assert.equal(five.sessions.length, 5);
      assert.deepEqual(five.sessions.map(row => row.session_handle), sorted.map(row => createHash('sha256')
        .update('atomic-notes/session-management/handle/v1\0').update(owner).update('\0').update(row._id).digest('base64url')));
      cases[phase] = 'pass';

      phase = 'overflow';
      await insert('public-management-overflow', 3000); const overflowing = await sessionState();
      const overflow = await request('/api/auth/sessions'); assert.equal(overflow.status, 409);
      assert.deepEqual(await overflow.json(), { error: 'session_inventory_overflow' });
      await refuse(() => revokeManagedSession(db, owner, FIXTURE_TOKENS.a, { session_handle: targetHandle }), 409, 'session_inventory_overflow');
      assert.deepEqual(await sessionState(), overflowing); cases[phase] = 'pass';

      phase = 'retired_excluded';
      await reset();
      for (let i = 0; i < 20; i++) {
        await insert(`public-management-retired-${i}`, 10000 + i);
        await sessions.updateOne({ _id: hash(`public-management-retired-${i}`) }, { $set: i % 2 ? { revoked: true } : { expiresAt: new Date(0) } });
      }
      assert.equal((await list()).sessions.length, 2); cases[phase] = 'pass';

      phase = 'agent_filter';
      await reset();
      const rawAgent = '\u0000\n\u202e\u2028  ' + '\u{1f680}'.repeat(90) + '  ';
      await sessions.updateOne({ _id: targetId }, { $set: { userAgent: rawAgent } });
      const filtered = (await list()).sessions.find(row => !row.is_current)!;
      assert.equal(filtered.agent_label, '\u{1f680}'.repeat(80));
      await sessions.updateOne({ _id: targetId }, { $set: { userAgent: '\u0000\n  ' } });
      assert.equal((await list()).sessions.find(row => !row.is_current)!.agent_label, null);
      cases[phase] = 'pass';

      phase = 'auth_and_body_guards';
      await reset();
      const anonymous = await fetch(`${fixture.origin}/api/auth/sessions`);
      assert.equal(anonymous.status, 401); assert.deepEqual(await anonymous.json(), { error: 'missing_token' });
      assert.equal((await request('/api/auth/sessions', '')).status, 401);
      assert.equal((await request('/api/auth/sessions', 'public-unknown-auth')).status, 401);
      await sessions.updateOne({ _id: currentId }, { $set: { expiresAt: new Date(0) } });
      assert.equal((await request('/api/auth/sessions')).status, 401);
      await reset(); await sessions.updateOne({ _id: currentId }, { $set: { revoked: true } });
      assert.equal((await request('/api/auth/sessions')).status, 401);
      await reset();
      for (const body of ['{', '{}', JSON.stringify({ session_handle: 'bad' }),
        JSON.stringify({ session_handle: targetHandle, extra: true })]) {
        assert.equal((await request('/api/auth/sessions/revoke', FIXTURE_TOKENS.a, body)).status, 400);
      }
      const oversized = await request('/api/auth/sessions/revoke', FIXTURE_TOKENS.a,
        JSON.stringify({ session_handle: targetHandle, padding: 'x'.repeat(1100) }));
      assert.equal(oversized.status, 413); assert.deepEqual(await oversized.json(), { error: 'request_too_large' });
      assert.deepEqual(await sessionState(), original); cases[phase] = 'pass';

      phase = 'selected_other';
      const retired = await revoke(targetHandle); assert.equal(retired.status, 200); assert.deepEqual(await retired.json(), { ok: true });
      assert.equal(retired.headers.get('cache-control'), 'no-store');
      assert.equal((await request('/api/notes/count', FIXTURE_TOKENS.b)).status, 401);
      assert.equal((await request('/api/notes/count', FIXTURE_TOKENS.a)).status, 200);
      assert.equal((await request('/api/notes/count', FIXTURE_TOKENS.other)).status, 200);
      const changedCurrent = (await sessions.findOne({ _id: currentId }))!;
      assert.equal(changedCurrent.logoutAttemptRevision, 1);
      assert.equal(changedCurrent.expiresAt.getTime(), original.find(row => row._id === currentId)!.expiresAt.getTime());
      assert.deepEqual((await sessionState()).filter(row => row._id !== currentId && row._id !== targetId),
        original.filter(row => row._id !== currentId && row._id !== targetId));
      cases[phase] = 'pass';

      phase = 'private_idempotence';
      const foreignHandle = (await list(FIXTURE_TOKENS.other)).sessions[0].session_handle;
      for (const handle of [targetHandle, 'A'.repeat(43), foreignHandle]) {
        const before = await sessionState(), response = await revoke(handle);
        assert.equal(response.status, 200); assert.deepEqual(await response.json(), { ok: true });
        assert.deepEqual(await sessionState(), before);
      }
      await reset(); await sessions.updateOne({ _id: targetId }, { $set: { expiresAt: new Date(0) } });
      const expiredBefore = await sessionState(), expiredReply = await revoke(targetHandle);
      assert.equal(expiredReply.status, 200); assert.deepEqual(await expiredReply.json(), { ok: true });
      assert.deepEqual(await sessionState(), expiredBefore); cases[phase] = 'pass';

      phase = 'current_refusal';
      await reset(); const currentReply = await revoke(currentHandle);
      assert.equal(currentReply.status, 409); assert.deepEqual(await currentReply.json(), { error: 'current_session_requires_safe_logout' });
      assert.deepEqual(await sessionState(), original); cases[phase] = 'pass';

      phase = 'bound_logout_refusal';
      for (const id of [currentId, targetId]) {
        await reset(); await sessions.updateOne({ _id: id }, { $set: { logoutAttemptId: 'public-synthetic-bound-attempt' } });
        const before = await sessionState();
        await refuse(() => revokeManagedSession(db, owner, FIXTURE_TOKENS.a, { session_handle: targetHandle }), 409, 'session_logout_active');
        assert.deepEqual(await sessionState(), before);
      }
      cases[phase] = 'pass';

      phase = 'invalid_inventory';
      await reset(); await db.collection('sessions').updateOne({ _id: targetId }, { $set: { userAgent: ['invalid'] } });
      const invalidBefore = await sessionState();
      await refuse(() => listManagedSessions(db, owner, FIXTURE_TOKENS.a), 409, 'session_inventory_invalid');
      assert.deepEqual(await sessionState(), invalidBefore); cases[phase] = 'pass';

      phase = 'query_timeout_control';
      // A fixed server error-code control verifies public classification; this
      // does not claim measured performance or an actual timed-out Mongo query.
      const timedOut = { collection() { return { async findOne() { throw { code: 50 }; } }; } } as unknown as Db;
      await refuse(() => listManagedSessions(timedOut, owner, FIXTURE_TOKENS.a), 409, 'session_inventory_unavailable');
      cases[phase] = 'pass';

      phase = 'revision_exhaustion';
      await reset(); await sessions.updateOne({ _id: currentId }, { $set: { logoutAttemptRevision: Number.MAX_SAFE_INTEGER } });
      const exhaustedBefore = await sessionState();
      await refuse(() => revokeManagedSession(db, owner, FIXTURE_TOKENS.a, { session_handle: targetHandle }), 409, 'session_revision_exhausted');
      assert.deepEqual(await sessionState(), exhaustedBefore); cases[phase] = 'pass';

      phase = 'late_read_auth';
      await reset();
      await refuse(() => listManagedSessions(db, owner, FIXTURE_TOKENS.a, { afterInventory: async () => {
        await sessions.updateOne({ _id: currentId }, { $set: { revoked: true } });
      } }), 401, 'invalid_token');
      assert.equal((await sessions.findOne({ _id: targetId }))!.revoked, false); cases[phase] = 'pass';

      phase = 'late_noop_auth';
      await reset();
      await refuse(() => revokeManagedSession(db, owner, FIXTURE_TOKENS.a, { session_handle: 'A'.repeat(43) }, {
        beforeNoopReply: async () => { await sessions.updateOne({ _id: currentId }, { $set: { revoked: true } }); },
      }), 401, 'invalid_token');
      assert.equal((await sessions.findOne({ _id: targetId }))!.revoked, false); cases[phase] = 'pass';

      phase = 'concurrent_current_revoke';
      await reset(); let currentRaced = false;
      await refuse(() => revokeManagedSession(db, owner, FIXTURE_TOKENS.a, { session_handle: targetHandle }, {
        beforeFence: async () => { if (!currentRaced) { currentRaced = true;
          await sessions.updateOne({ _id: currentId }, { $set: { revoked: true } }); } },
      }), 401, 'invalid_token');
      assert.equal(currentRaced, true); assert.deepEqual(await sessions.findOne({ _id: targetId }), original.find(row => row._id === targetId));
      assert.equal((await sessions.findOne({ _id: currentId }))!.logoutAttemptRevision, undefined); cases[phase] = 'pass';

      phase = 'concurrent_target_attempt';
      await reset(); let attemptRaced = false;
      await refuse(() => revokeManagedSession(db, owner, FIXTURE_TOKENS.a, { session_handle: targetHandle }, {
        beforeFence: async () => { if (!attemptRaced) { attemptRaced = true;
          await sessions.updateOne({ _id: targetId }, { $set: { logoutAttemptId: 'public-synthetic-concurrent-attempt' } }); } },
      }), 409, 'session_logout_active');
      assert.equal(attemptRaced, true); assert.equal((await sessions.findOne({ _id: targetId }))!.revoked, false);
      assert.deepEqual(await sessions.findOne({ _id: currentId }), original.find(row => row._id === currentId)); cases[phase] = 'pass';

      phase = 'concurrent_target_revoke';
      await reset(); let targetRaced = false;
      assert.deepEqual(await revokeManagedSession(db, owner, FIXTURE_TOKENS.a, { session_handle: targetHandle }, {
        beforeFence: async () => { if (!targetRaced) { targetRaced = true;
          await sessions.updateOne({ _id: targetId }, { $set: { revoked: true } }); } },
      }), { ok: true });
      assert.equal(targetRaced, true); assert.equal((await sessions.findOne({ _id: targetId }))!.revoked, true);
      assert.deepEqual(await sessions.findOne({ _id: currentId }), original.find(row => row._id === currentId)); cases[phase] = 'pass';

      phase = 'transaction_rollback';
      await reset();
      await assert.rejects(revokeManagedSession(db, owner, FIXTURE_TOKENS.a, { session_handle: targetHandle }, {
        afterWrites: async () => { throw new Error('public-synthetic-rollback'); },
      }), /public-synthetic-rollback/);
      assert.deepEqual(await sessionState(), original); cases[phase] = 'pass';

      phase = 'no_note_or_wallet_mutation';
      assert.deepEqual(await outsideSessions(), unchanged); cases[phase] = 'pass';
    } finally {
      const reachedEnd = cases.no_note_or_wallet_mutation === 'pass';
      try {
        if (fixture) await fixture.close();
        if (fixture) cases.cleanup = 'pass';
        if (reachedEnd && cases.cleanup === 'pass') phase = 'complete';
      } finally {
        writeFileSync('ci-session-management-proof.json', JSON.stringify({ version: 1,
          scope: 'disposable bounded manual other-session management; no idle expiry or bulk revocation',
          phase, outcome: phase === 'complete' ? 'pass' : 'fail', cases }));
      }
    }
  });
