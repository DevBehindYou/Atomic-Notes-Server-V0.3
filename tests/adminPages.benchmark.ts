import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { Hono } from 'hono';

// This command cannot opt into Atlas or reuse a supplied database name.
const uri = process.env.MONGODB_URI;
if (!uri || !/^mongodb:\/\/(127\.0\.0\.1|localhost):\d+(?:[/?]|$)/.test(uri)) {
  throw new Error('Admin baseline requires a disposable localhost replica set');
}
const databaseName = `atomic_bench_${randomUUID().replaceAll('-', '').slice(0, 20)}`;
process.env.MONGODB_DB_NAME = databaseName;
process.env.ADMIN_API_KEY = 'public-benchmark-fixture-key';
process.env.TOKEN_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');
delete process.env.COIN_EXPIRY_ACTIVATED_AT;

const { getDb, closeDb } = await import('../src/db/mongo');
const { collections, ensureIndexes, notificationSchema } = await import('../src/db/collections');
const { default: admin } = await import('../src/routes/admin');
const { registerErrorHandler } = await import('../src/middleware/errorHandler');
const { mongoCommands } = await import('../src/lib/perf');
const app = new Hono();
registerErrorHandler(app);
app.route('/api/admin', admin);
const db = await getDb();
const samples = 100, warmups = 5, limit = 50;
type Page = { rows: { id: string; created_at: string; reads: number; recipients: number }[]; next_cursor: string | null };
const percentile = (values: number[], p: number) => [...values].sort((a, b) => a - b)[Math.ceil(values.length * p) - 1];
function stages(plan: unknown): string[] {
  if (!plan || typeof plan !== 'object') return [];
  const object = plan as Record<string, unknown>;
  return [...new Set([
    ...(typeof object.stage === 'string' ? [object.stage] : []),
    ...Object.values(object).flatMap((value) => stages(value)),
  ])];
}

try {
  assert.equal(db.databaseName, databaseName);
  assert.ok((await db.admin().command({ hello: 1 })).setName, 'Replica set required');
  await ensureIndexes(db);
  console.log('ADMIN_PAGE_BASELINE_ENV', JSON.stringify({ node: process.version,
    mongo: (await db.admin().command({ buildInfo: 1 })).version,
    commit: process.env.GITHUB_SHA ?? 'local-unrecorded', samples, warmups, limit,
    boundary: 'in-process Hono + loopback Mongo; synthetic notification history; no Vercel/Drive/browser' }));

  for (const size of [1, 1000, 10000]) {
    // Every collection here belongs only to this randomly named disposable DB.
    await collections.notifications(db).deleteMany({});
    await collections.notificationRecipients(db).deleteMany({});
    await collections.notificationStates(db).deleteMany({});
    const userId = randomUUID();
    const fixtures = Array.from({ length: size }, (_, i) => notificationSchema.parse({
      _id: randomUUID(), type: 'information', subject: 'Synthetic baseline', description: 'Disposable fixture',
      status: (['active', 'resolved', 'expired'] as const)[i % 3], targetAudience: 'active',
      createdAt: new Date(Date.UTC(2026, 0, 1) + Math.floor(i / 3) * 1000),
    }));
    await collections.notifications(db).insertMany(fixtures);
    await collections.notificationRecipients(db).insertMany(fixtures.map((n) => ({
      _id: `${n._id}:${userId}`, notificationId: n._id, userId,
    })));
    await collections.notificationStates(db).insertMany(fixtures.map((n) => ({
      _id: `${userId}:${n._id}`, notificationId: n._id, userId,
      readAt: new Date(Date.UTC(2026, 0, 2)), dismissedAt: null,
    })));
    const expected = [...fixtures].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() ||
      (a._id < b._id ? 1 : a._id > b._id ? -1 : 0));

    async function page(cursor?: string) {
      const started = performance.now(), beforeCommands = mongoCommands.started;
      const response = await app.request(`/api/admin/notifications?limit=${limit}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`, {
        headers: { 'x-admin-api-key': 'public-benchmark-fixture-key' },
      });
      const body = await response.json() as Page;
      const durationMs = performance.now() - started, commands = mongoCommands.started - beforeCommands;
      assert.equal(response.status, 200);
      assert.ok(body.rows.length <= limit);
      assert.ok(body.rows.every((n) => n.reads === 1 && n.recipients === 1));
      return { body, durationMs, commands };
    }
    const initial = (await page()).body;
    for (const [pageName, cursor] of [
      ['first', undefined], ...(initial.next_cursor ? [['next', initial.next_cursor]] : []),
    ] as [string, string | undefined][]) {
      const offset = pageName === 'first' ? 0 : limit;
      const expectedIds = expected.slice(offset, offset + limit).map((n) => n._id);
      for (let i = 0; i < warmups; i++) await page(cursor);
      const durations: number[] = [], commands: number[] = [];
      for (let i = 0; i < samples; i++) {
        const result = await page(cursor);
        assert.deepEqual(result.body.rows.map((n) => n.id), expectedIds);
        durations.push(result.durationMs); commands.push(result.commands);
      }
      const boundary = offset ? expected[offset - 1] : null;
      const filter = boundary ? { $or: [
        { createdAt: { $lt: boundary.createdAt } },
        { createdAt: boundary.createdAt, _id: { $lt: boundary._id } },
      ] } : {};
      // This explains the exact candidate query shape; route timings above
      // also include auth, both delivery aggregations and JSON serialization.
      const explain = await collections.notifications(db).find(filter)
        .sort({ createdAt: -1, _id: -1 }).limit(limit + 1).explain('executionStats');
      console.log('ADMIN_PAGE_BASELINE', JSON.stringify({ size, page: pageName,
        returned: expectedIds.length, samples, warmups,
        p50Ms: percentile(durations, 0.5), p95Ms: percentile(durations, 0.95),
        minMs: Math.min(...durations), maxMs: Math.max(...durations), durationsMs: durations,
        commands, candidateQuery: { returned: explain.executionStats.nReturned,
          documentsExamined: explain.executionStats.totalDocsExamined,
          keysExamined: explain.executionStats.totalKeysExamined,
          stages: stages(explain.queryPlanner.winningPlan) } }));
    }
  }
} finally {
  try { assert.equal(db.databaseName, databaseName); await db.dropDatabase(); }
  finally { await closeDb(); }
}
