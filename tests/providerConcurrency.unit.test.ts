import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { once } from 'node:events';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Readable } from 'node:stream';
import { google } from 'googleapis';
import { createNoteFileWith, driveClient, driveSession, withDriveRetry } from '../src/lib/googleDrive.js';
import { mapConcurrent } from '../src/lib/concurrency.js';
import { timedDrive } from '../src/lib/perf.js';

// Deterministic provider cost benchmark. The real googleapis, google-auth-library
// and gaxios stack talks over HTTP to a loopback stand-in for Google's token and
// Drive endpoints, so client construction, connection reuse, nested retries and
// token refresh are the libraries' actual behavior. Nothing reaches Google.

/** Same bounds as src/routes/notes.ts: Drive calls per push request, and rows (all read at once) per pull page. */
const DRIVE_CONCURRENCY = 8, PULL_PAGE = 10;

// Count every OAuth client and Drive client the code under test builds.
const built = { oauth: 0, drive: 0 };
const BaseOAuth2 = google.auth.OAuth2;
google.auth.OAuth2 = class CountedOAuth2 extends BaseOAuth2 {
  constructor(...args: ConstructorParameters<typeof BaseOAuth2>) { super(...args); built.oauth++; }
} as typeof BaseOAuth2;
const baseDrive = google.drive.bind(google);
google.drive = ((...args: Parameters<typeof baseDrive>) => { built.drive++; return baseDrive(...args); }) as typeof google.drive;

type Calls = {
  createNoteFile(parentId: string, filename: string, content: object): Promise<{ id?: string | null }>;
  updateNoteFile(fileId: string, content: object): Promise<unknown>;
  getNoteFileContent(fileId: string): Promise<Record<string, unknown>>;
};
type Overrides = { origin: string };
const fields = 'id, headRevisionId, modifiedTime';
const media = (content: object) => ({ mimeType: 'application/json', body: Readable.from(JSON.stringify(content)) });

/** The adapter path as of the C23 head: every Drive call builds its own OAuth and Drive client. */
const perCall = (accessToken: string, refreshToken: string, o: Overrides): Calls => ({
  createNoteFile: (parentId, filename, content) => createNoteFileWith(driveClient(accessToken, refreshToken, o), parentId, filename, content),
  updateNoteFile: async (fileId, content) => (await driveClient(accessToken, refreshToken, o).files.update({
    fileId, requestBody: { trashed: false }, media: media(content), fields })).data,
  getNoteFileContent: async (fileId) => (await driveClient(accessToken, refreshToken, o).files.get(
    { fileId, alt: 'media' }, { responseType: 'json' })).data as Record<string, unknown>,
});

type Strategy = { name: string; forRequest: (accessToken: string, refreshToken: string, o: Overrides) => Calls };
const strategies: Strategy[] = [{ name: 'per-call', forRequest: perCall }, { name: 'per-request', forRequest: driveSession }];

// ---------------------------------------------------------------------------
// Loopback Google
// ---------------------------------------------------------------------------
type Fault = { status?: number; delayMs?: number; drop?: boolean } | undefined;
type Kind = 'list' | 'create' | 'update' | 'read' | 'token';
type FaultFn = (kind: Kind, key: string, attempt: number) => Fault;
const users = ['A', 'B'] as const;
type User = typeof users[number];
const ownerOf = (key: string): User | undefined => users.find((u) => key.startsWith(`u${u}-`));

async function fakeGoogle(t: TestContext, options: { latencyMs?: number; tokenLatencyMs?: number; fault?: FaultFn;
  stale?: string[]; jitterMs?: number } = {}) {
  const latency = options.latencyMs ?? 5;
  const valid = new Map<string, User>(users.map((u) => [`synthetic-access-${u}`, u]));
  const stale = new Set(options.stale ?? []);
  for (const token of stale) valid.delete(token);
  const files = new Map<string, { name: string; owner: User; body: string }>();
  const attempts = new Map<string, number>();
  const stats = { sockets: 0, requests: 0, token: 0, list: 0, create: 0, update: 0, read: 0, unauthorized: 0,
    crossed: 0, inFlight: 0, maxInFlight: 0, perUser: { A: { inFlight: 0, max: 0 }, B: { inFlight: 0, max: 0 } },
    refreshes: { A: 0, B: 0 } as Record<User, number>, staleSent: 0 };
  let jitter = 0;
  const reply = (res: ServerResponse, status: number, value: unknown, delayMs: number) => setTimeout(() => {
    res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(value));
  }, delayMs);
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    let body = '';
    req.on('data', (part) => { body += part; });
    req.on('end', () => {
      const url = new URL(req.url!, 'http://loopback');
      if (url.pathname === '/token') {
        stats.token++;
        const refresh = new URLSearchParams(body).get('refresh_token') ?? '';
        const user = users.find((u) => refresh === `synthetic-refresh-${u}`);
        if (!user) return reply(res, 400, { error: 'invalid_grant' }, 0);
        const issued = `synthetic-access-${user}-r${++stats.refreshes[user]}`;
        valid.set(issued, user);
        return reply(res, 200, { access_token: issued, expires_in: 3600, token_type: 'Bearer' }, options.tokenLatencyMs ?? 5);
      }
      stats.requests++;
      let kind: Kind, key: string;
      const fileId = url.pathname.match(/\/files\/([^/]+)$/)?.[1];
      if (req.method === 'GET' && !fileId) { kind = 'list'; key = url.searchParams.get('q')?.match(/name = '([^']+)'/)?.[1] ?? ''; }
      else if (req.method === 'POST') { kind = 'create'; key = body.match(/"name":"([^"]+)"/)?.[1] ?? ''; }
      else if (req.method === 'PATCH') { kind = 'update'; key = fileId ?? ''; }
      else { kind = 'read'; key = fileId ?? ''; }
      stats[kind]++;
      const owner = ownerOf(key);
      const bearer = (req.headers.authorization ?? '').replace(/^Bearer /, '');
      const caller = valid.get(bearer) ?? users.find((u) => bearer.startsWith(`synthetic-stale-${u}`));
      if (!owner || caller !== owner) stats.crossed++;
      if (stale.has(bearer)) stats.staleSent++;
      stats.inFlight++; stats.maxInFlight = Math.max(stats.maxInFlight, stats.inFlight);
      const lane = owner ? stats.perUser[owner] : undefined;
      if (lane) { lane.inFlight++; lane.max = Math.max(lane.max, lane.inFlight); }
      res.on('close', () => { stats.inFlight--; if (lane) lane.inFlight--; });
      const delay = latency + (options.jitterMs ? (jitter = (jitter * 7 + 3) % (options.jitterMs + 1)) : 0);
      if (!valid.has(bearer)) { stats.unauthorized++; return reply(res, 401, { error: { code: 401, message: 'synthetic expired' } }, delay); }
      const attempt = (attempts.get(`${kind}:${key}`) ?? 0) + 1;
      attempts.set(`${kind}:${key}`, attempt);
      const fault = options.fault?.(kind, key, attempt);
      const wait = delay + (fault?.delayMs ?? 0);
      if (fault?.drop) return req.socket.destroy();
      if (fault?.status) return reply(res, fault.status, { error: { code: fault.status, message: 'synthetic provider fault' } }, wait);
      if (kind === 'list') return reply(res, 200, { files: [...files].filter(([, f]) => f.name === key).map(([id]) => ({ id })) }, wait);
      if (kind === 'create') {
        const id = `${key.replace(/\.atomic$/, '')}-file`;
        files.set(id, { name: key, owner: owner!, body });
        return reply(res, 200, { id, headRevisionId: 'synthetic-revision' }, wait);
      }
      if (kind === 'update') return reply(res, 200, { id: key, headRevisionId: 'synthetic-revision-2' }, wait);
      return reply(res, 200, { version: 1, id: key, kind: 'text', title: 'Public synthetic', body: 'Public synthetic body' }, wait);
    });
  });
  server.on('connection', () => { stats.sockets++; });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }));
  return { stats, overrides: { origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}` } };
}

// ---------------------------------------------------------------------------
// Workloads, composed exactly as src/routes/notes.ts composes them
// ---------------------------------------------------------------------------
const content = (id: string) => ({ version: 1, id, kind: 'text', title: 'Public synthetic', body: 'Public synthetic benchmark body',
  items: [], pinned: false, encV: 0, payload: null, createdAt: '2026-11-07T00:00:00.000Z', updatedAt: '2026-11-07T00:00:00.000Z' });
const rowIds = (user: User, n: number) => Array.from({ length: n }, (_, i) => `u${user}-n${String(i).padStart(3, '0')}`);
type Backoff = { ms: number; sleeps: number };
const recordSleep = (backoff: Backoff) => async (ms: number) => { backoff.ms += ms; backoff.sleeps++; };
const tokensOf = (user: User, stale = false) => [stale ? `synthetic-stale-${user}` : `synthetic-access-${user}`, `synthetic-refresh-${user}`] as const;

/** One /push request: one set of Drive calls, rows written through mapConcurrent, each failure kept per row. */
async function push(strategy: Strategy, o: Overrides, user: User, ids: string[], mode: 'create' | 'update', backoff: Backoff,
  starts?: string[], stale = false) {
  const calls = strategy.forRequest(...tokensOf(user, stale), o);
  return mapConcurrent(ids, DRIVE_CONCURRENCY, async (id) => {
    starts?.push(id);
    try {
      await timedDrive(() => withDriveRetry(() => mode === 'create'
        ? calls.createNoteFile(`u${user}-folder`, `${id}.atomic`, content(id))
        : calls.updateNoteFile(`${id}-file`, content(id)), { sleep: recordSleep(backoff) }));
      return true;
    } catch { return false; }
  });
}

/** A full pull walk: one request per page, each page's reads at once; a failed read fails the page. */
async function pullWalk(strategy: Strategy, o: Overrides, user: User, ids: string[], backoff: Backoff) {
  let failedPages = 0;
  for (let page = 0; page < ids.length; page += PULL_PAGE) {
    const calls = strategy.forRequest(...tokensOf(user), o);
    try {
      await mapConcurrent(ids.slice(page, page + PULL_PAGE), PULL_PAGE, (id) =>
        timedDrive(() => withDriveRetry(() => calls.getNoteFileContent(`${id}-file`), { sleep: recordSleep(backoff) })));
    } catch { failedPages++; }
  }
  return failedPages;
}

type Sample = Record<string, number | string>;
async function measure(google: Awaited<ReturnType<typeof fakeGoogle>>, run: () => Promise<Sample>) {
  const before = { ...built };
  (globalThis as { gc?: () => void }).gc?.();
  const heap = process.memoryUsage().heapUsed, started = performance.now();
  const extra = await run();
  const wallMs = Math.round(performance.now() - started);
  const s = google.stats;
  return { clients: built.drive - before.drive, oauthClients: built.oauth - before.oauth, sockets: s.sockets,
    requests: s.requests, list: s.list, create: s.create, update: s.update, read: s.read, token: s.token,
    maxInFlight: s.maxInFlight, crossed: s.crossed, wallMs, heapDeltaKB: Math.round((process.memoryUsage().heapUsed - heap) / 1024),
    ...extra };
}
const report: Record<string, Record<string, Sample>> = {};
const record = (scenario: string, strategy: string, sample: Sample) => { (report[scenario] ??= {})[strategy] = sample; };
test.after(() => { console.log(`provider-benchmark ${JSON.stringify(report)}`); });

const persistent = (status: number, keys: Set<string>, kinds: Kind[]): FaultFn => (kind, key) =>
  kinds.includes(kind) && keys.has(key) ? { status } : undefined;
const firstN = (fault: Fault, n: number, keys: Set<string>, kinds: Kind[]): FaultFn => (kind, key, attempt) =>
  kinds.includes(kind) && keys.has(key) && attempt <= n ? fault : undefined;
const either = (...fns: FaultFn[]): FaultFn => (kind, key, attempt) => fns.map((f) => f(kind, key, attempt)).find(Boolean);
const failed = (ok: boolean[]) => ok.filter((v) => !v).length;
const names = (ids: string[]) => new Set(ids.map((id) => `${id}.atomic`));
const fileIds = (ids: string[]) => new Set(ids.map((id) => `${id}-file`));
const atMost = (s: Sample, key: string, bound: number) => assert.ok(Number(s[key]) <= bound, `${key} ${s[key]} > ${bound}`);

type Scenario = { name: string; title: string; run: (strategy: Strategy, t: TestContext) => Promise<Sample>;
  /** Invariants the per-request path must hold. */ expect: (s: Sample) => void };
const ids100 = rowIds('A', 100);
const scenarios: Scenario[] = [
  { name: 'push-create-100', title: '100-row push of new notes', async run(strategy, t) {
    const g = await fakeGoogle(t, { latencyMs: 10 }), backoff = { ms: 0, sleeps: 0 };
    return measure(g, async () => ({ failedRows: failed(await push(strategy, g.overrides, 'A', ids100, 'create', backoff)) }));
  }, expect(s) {
    assert.deepEqual([s.clients, s.oauthClients, s.requests, s.failedRows], [1, 1, 200, 0]);
    atMost(s, 'maxInFlight', DRIVE_CONCURRENCY); atMost(s, 'sockets', DRIVE_CONCURRENCY);
  } },
  { name: 'push-update-100', title: '100-row push of edited notes', async run(strategy, t) {
    const g = await fakeGoogle(t, { latencyMs: 10 }), backoff = { ms: 0, sleeps: 0 };
    return measure(g, async () => ({ failedRows: failed(await push(strategy, g.overrides, 'A', ids100, 'update', backoff)) }));
  }, expect(s) {
    assert.deepEqual([s.clients, s.requests, s.failedRows], [1, 100, 0]);
    atMost(s, 'maxInFlight', DRIVE_CONCURRENCY); atMost(s, 'sockets', DRIVE_CONCURRENCY);
  } },
  { name: 'pull-walk-100', title: 'full pull walk of 100 notes (10 page requests)', async run(strategy, t) {
    const g = await fakeGoogle(t, { latencyMs: 10 }), backoff = { ms: 0, sleeps: 0 };
    return measure(g, async () => ({ failedPages: await pullWalk(strategy, g.overrides, 'A', ids100, backoff) }));
  }, expect(s) {
    // One client per page request, never one per file.
    assert.deepEqual([s.clients, s.requests, s.failedPages], [100 / PULL_PAGE, 100, 0]);
    atMost(s, 'maxInFlight', PULL_PAGE); atMost(s, 'sockets', PULL_PAGE);
  } },
  { name: 'push-create-100-429', title: '100-row push, 10 lookups always 429 and 10 twice', async run(strategy, t) {
    const g = await fakeGoogle(t, { latencyMs: 5, fault: either(persistent(429, names(ids100.slice(0, 10)), ['list']),
      firstN({ status: 429 }, 2, names(ids100.slice(10, 20)), ['list'])) });
    const backoff = { ms: 0, sleeps: 0 };
    return measure(g, async () => ({ failedRows: failed(await push(strategy, g.overrides, 'A', ids100, 'create', backoff)),
      backoffMs: Math.round(backoff.ms), outerRetries: backoff.sleeps }));
  }, expect(s) {
    // 80 clean lookups + 10 x 3 (recovered) + 10 x 4 (withDriveRetry's bound), instead of 16 per failing lookup.
    assert.deepEqual([s.list, s.create, s.failedRows, s.outerRetries], [80 + 30 + 40, 90, 10, 20 + 30]);
  } },
  { name: 'push-update-100-503', title: '100-row push, 5 updates always 503 and 10 twice', async run(strategy, t) {
    const g = await fakeGoogle(t, { latencyMs: 5, fault: either(persistent(503, fileIds(ids100.slice(0, 5)), ['update']),
      firstN({ status: 503 }, 2, fileIds(ids100.slice(5, 15)), ['update'])) });
    const backoff = { ms: 0, sleeps: 0 };
    return measure(g, async () => ({ failedRows: failed(await push(strategy, g.overrides, 'A', ids100, 'update', backoff)),
      backoffMs: Math.round(backoff.ms), outerRetries: backoff.sleeps }));
  }, expect(s) {
    // Writes were never retried inside the library: unchanged at 85 + 10 x 3 + 5 x 4.
    assert.deepEqual([s.update, s.failedRows, s.clients], [135, 5, 1]);
  } },
  { name: 'pull-page-429', title: 'pull page whose every read is rate limited', async run(strategy, t) {
    const ids = rowIds('A', PULL_PAGE), backoff = { ms: 0, sleeps: 0 };
    const g = await fakeGoogle(t, { latencyMs: 5, fault: persistent(429, fileIds(ids), ['read']) });
    return measure(g, async () => ({ failedPages: await pullWalk(strategy, g.overrides, 'A', ids, backoff), backoffMs: Math.round(backoff.ms) }));
  }, expect(s) {
    assert.deepEqual([s.read, s.failedPages, s.clients], [PULL_PAGE * 4, 1, 1]);
  } },
  { name: 'pull-page-drop', title: 'pull page whose reads each lose their connection once', async run(strategy, t) {
    const ids = rowIds('A', PULL_PAGE), backoff = { ms: 0, sleeps: 0 };
    const g = await fakeGoogle(t, { latencyMs: 5, fault: firstN({ drop: true }, 1, fileIds(ids), ['read']) });
    return measure(g, async () => ({ failedPages: await pullWalk(strategy, g.overrides, 'A', ids, backoff), outerRetries: backoff.sleeps }));
  }, expect(s) {
    // The library still resends a read that got no response at all; that retry is kept.
    assert.deepEqual([s.read, s.failedPages, s.outerRetries], [PULL_PAGE * 2, 0, 0]);
  } },
  { name: 'push-create-100-slow', title: 'push with 5 slow lookups: no starvation, bounded in-flight', async run(strategy, t) {
    const slow = names(ids100.filter((_, i) => i % 20 === 0));
    const g = await fakeGoogle(t, { latencyMs: 10, fault: (kind, key) => kind === 'list' && slow.has(key) ? { delayMs: 400 } : undefined });
    const backoff = { ms: 0, sleeps: 0 }, starts: string[] = [];
    return measure(g, async () => {
      const ok = await push(strategy, g.overrides, 'A', ids100, 'create', backoff, starts);
      return { failedRows: failed(ok), fifo: String(starts.length === ids100.length && starts.every((id, i) => id === ids100[i])) };
    });
  }, expect(s) {
    assert.deepEqual([s.failedRows, s.fifo, s.requests], [0, 'true', 200]);
    atMost(s, 'maxInFlight', DRIVE_CONCURRENCY);
  } },
  { name: 'two-users-stale-40x2', title: 'two users at once with stale tokens: own credentials, lanes and refreshes', async run(strategy, t) {
    const g = await fakeGoogle(t, { latencyMs: 5, tokenLatencyMs: 20, jitterMs: 15, stale: ['synthetic-stale-A', 'synthetic-stale-B'],
      fault: (_kind, key) => ownerOf(key) === 'A' ? { delayMs: 60 } : undefined });
    const backoff = { ms: 0, sleeps: 0 };
    let doneA = 0, doneB = 0;
    return measure(g, async () => {
      const [a, b] = await Promise.all([
        push(strategy, g.overrides, 'A', rowIds('A', 40), 'create', backoff, undefined, true).then((r) => { doneA = performance.now(); return r; }),
        push(strategy, g.overrides, 'B', rowIds('B', 40), 'create', backoff, undefined, true).then((r) => { doneB = performance.now(); return r; }),
      ]);
      return { failedRows: failed([...a, ...b]), refreshesA: g.stats.refreshes.A, refreshesB: g.stats.refreshes.B, staleSent: g.stats.staleSent,
        maxInFlightA: g.stats.perUser.A.max, maxInFlightB: g.stats.perUser.B.max, bFirst: String(doneB < doneA) };
    });
  }, expect(s) {
    // Every request carried its owner's own token, stale or refreshed, never the other user's (crossed is 0).
    assert.deepEqual([s.failedRows, s.clients, s.bFirst], [0, 2, 'true']);
    // Only each user's first wave used the stale token, and each user refreshed only for itself.
    for (const key of ['refreshesA', 'refreshesB', 'maxInFlightA', 'maxInFlightB']) {
      assert.ok(Number(s[key]) >= 1, key); atMost(s, key, DRIVE_CONCURRENCY);
    }
    atMost(s, 'staleSent', 2 * DRIVE_CONCURRENCY); atMost(s, 'maxInFlight', 2 * DRIVE_CONCURRENCY);
  } },
  { name: 'late-401-40', title: 'a 401 that arrives after the token was already refreshed', async run(strategy, t) {
    // Lookups sent with the stale token answer 401 at different times; some land after the first
    // refresh has finished. Each must still refresh and replay once, so no row fails.
    const g = await fakeGoogle(t, { latencyMs: 1, tokenLatencyMs: 0, jitterMs: 80, stale: ['synthetic-stale-A'] });
    const backoff = { ms: 0, sleeps: 0 };
    return measure(g, async () => ({ failedRows: failed(await push(strategy, g.overrides, 'A', rowIds('A', 40), 'create', backoff, undefined, true)),
      refreshesA: g.stats.refreshes.A, staleSent: g.stats.staleSent }));
  }, expect(s) {
    assert.deepEqual([s.failedRows, s.clients], [0, 1]);
    atMost(s, 'refreshesA', DRIVE_CONCURRENCY); atMost(s, 'staleSent', DRIVE_CONCURRENCY);
  } },
  { name: 'stale-update-20', title: 'edits sent with a stale token (characterized, unchanged)', async run(strategy, t) {
    const g = await fakeGoogle(t, { latencyMs: 2, stale: ['synthetic-stale-A'] }), backoff = { ms: 0, sleeps: 0 };
    return measure(g, async () => ({ failedRows: failed(await push(strategy, g.overrides, 'A', rowIds('A', 20), 'update', backoff, undefined, true)),
      refreshesA: g.stats.refreshes.A }));
  }, expect(s) {
    // The auth library never replays a streamed upload after a 401, so these rows fail and the App retries
    // them. Same as the per-call path; recorded as a residual risk, not changed here.
    assert.deepEqual([s.failedRows, s.refreshesA], [20, 0]);
  } },
];

for (const scenario of scenarios) {
  test(scenario.title, async (t) => {
    const samples: Record<string, Sample> = {};
    for (const strategy of strategies) {
      await t.test(strategy.name, async (t) => {
        const sample = await scenario.run(strategy, t);
        samples[strategy.name] = sample;
        record(scenario.name, strategy.name, sample);
        assert.equal(sample.crossed, 0, 'a request carried another user\'s credentials');
      });
    }
    scenario.expect(samples['per-request']);
    // Same workload: the per-request path never sends more upstream requests or builds more clients.
    atMost(samples['per-request'], 'requests', Number(samples['per-call'].requests));
    atMost(samples['per-request'], 'clients', Number(samples['per-call'].clients));
  });
}

test('constructing one OAuth and Drive client (indicative)', () => {
  const n = 200;
  (globalThis as { gc?: () => void }).gc?.();
  const heap = process.memoryUsage().heapUsed, started = performance.now();
  const kept = Array.from({ length: n }, () => driveClient('synthetic-access-A', 'synthetic-refresh-A', { origin: 'http://127.0.0.1:9' }));
  record('construct-client', 'each', { microsPerClient: Math.round((performance.now() - started) * 1000 / n),
    retainedKBPerClient: Math.round((process.memoryUsage().heapUsed - heap) / 1024 / n * 10) / 10, kept: kept.length });
});
