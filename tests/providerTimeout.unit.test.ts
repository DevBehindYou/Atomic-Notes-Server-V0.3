import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { once } from 'node:events';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { DRIVE_REQUEST_TIMEOUT_MS, createNoteFileWith, driveClient, isDriveRetryable, withDriveRetry }
  from '../src/lib/googleDrive.js';
import { GOOGLE_TOKEN_TIMEOUT_MS, isInvalidGrant, refreshAccessToken } from '../src/lib/googleOAuth.js';

// Loopback stand-in for Google's token and Drive endpoints. The real googleapis,
// google-auth-library and gaxios stack talks to it over HTTP, so retries,
// timeouts and lost responses are the libraries' actual behavior, not a mock's.
type Handler = (req: IncomingMessage, res: ServerResponse, body: string) => void;
const content = { version: 1, id: '00000000-0000-4000-8000-0000000000c3', kind: 'text', title: 'Public synthetic',
  body: 'Public synthetic provider timeout body', items: [], pinned: false, encV: 0, payload: null,
  createdAt: '2026-11-07T00:00:00.000Z', updatedAt: '2026-11-07T00:00:00.000Z' };
const parent = 'synthetic-provider-parent', filename = `${content.id}.atomic`;
const noSleep = { sleep: async () => {} };
const hang: Handler = () => {};
const json = (res: ServerResponse, status: number, value: unknown) => {
  res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(value));
};

async function fakeGoogle(t: TestContext, handlers: { token?: Handler; drive: Handler }) {
  const counts = { token: 0, list: 0, create: 0, update: 0 };
  const server = createServer((req, res) => {
    const path = new URL(req.url!, 'http://loopback').pathname;
    if (path === '/token') counts.token++;
    else if (req.method === 'GET' && path === '/drive/v3/files') counts.list++;
    else if (req.method === 'POST' && path === '/upload/drive/v3/files') counts.create++;
    else if (req.method === 'PATCH') counts.update++;
    let body = '';
    req.on('data', (part) => { body += part; });
    req.on('end', () => path === '/token' ? (handlers.token ?? hang)(req, res, body) : handlers.drive(req, res, body));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { counts, overrides: { origin } };
}

const elapsedSince = (started: number) => performance.now() - started;
/** Settles [call] or gives up well after the bound, so an unbounded call fails the test instead of hanging it. */
async function settleWithin(call: Promise<unknown>, ms: number) {
  let timer: NodeJS.Timeout | undefined;
  const gaveUp = new Promise<'hung'>((resolve) => { timer = setTimeout(() => resolve('hung'), ms); });
  try {
    return await Promise.race([call.then(() => ({ ok: true as const }), (error: unknown) => ({ ok: false as const, error })), gaveUp]);
  } finally { clearTimeout(timer); }
}
/** The bound the Server promises for one token-endpoint request. */
const TOKEN_BOUND_MS = 10000;

test('token refresh and Drive requests have fixed bounds', () => {
  assert.equal(GOOGLE_TOKEN_TIMEOUT_MS, TOKEN_BOUND_MS);
  assert.equal(DRIVE_REQUEST_TIMEOUT_MS, 20000);
  const drive = driveClient('synthetic-access', 'synthetic-refresh') as unknown as { context: { _options: { timeout?: number } } };
  assert.equal(drive.context._options.timeout, DRIVE_REQUEST_TIMEOUT_MS);
});

test('a stalled Google token endpoint cannot hold a request open', { timeout: 40000, concurrency: true }, async (t) => {
  const explicit = t.test('explicit refresh before a push or pull fails after the token timeout', async (t) => {
    const google = await fakeGoogle(t, { drive: hang });
    const started = performance.now();
    const outcome = await settleWithin(refreshAccessToken('synthetic-refresh', google.overrides),
      TOKEN_BOUND_MS + 5000);
    const elapsed = elapsedSince(started);
    assert.notEqual(outcome, 'hung', 'token refresh is unbounded');
    assert.ok(outcome !== 'hung' && !outcome.ok);
    // Not invalid_grant: the route answers a transient 500 and keeps the Google account, not 401 sign-in-again.
    assert.equal(isInvalidGrant(outcome.error), false);
    assert.ok(elapsed >= TOKEN_BOUND_MS - 250, `elapsed ${elapsed}`);
    // An aborted token request is not replayed by the library's retry policy.
    assert.equal(google.counts.token, 1);
  });
  const implicit = t.test('the refresh the Drive library makes after a 401 is bounded and writes nothing', async (t) => {
    const google = await fakeGoogle(t, { drive: (_req, res) => json(res, 401, { error: { code: 401, message: 'synthetic expired' } }) });
    const drive = driveClient('synthetic-stale-access', 'synthetic-refresh', google.overrides);
    const started = performance.now();
    const outcome = await settleWithin(withDriveRetry(() => createNoteFileWith(drive, parent, filename, content), noSleep),
      TOKEN_BOUND_MS + 5000);
    const elapsed = elapsedSince(started);
    assert.notEqual(outcome, 'hung', 'Drive library token refresh is unbounded');
    assert.ok(outcome !== 'hung' && !outcome.ok);
    assert.ok(elapsed >= TOKEN_BOUND_MS - 250, `elapsed ${elapsed}`);
    assert.deepEqual(google.counts, { token: 1, list: 1, create: 0, update: 0 });
  });
  await Promise.all([explicit, implicit]);
});

test('a Drive timeout before any write is final for the request and leaves nothing to duplicate', async (t) => {
  await t.test('stalled name lookup: one attempt, no create', async (t) => {
    const google = await fakeGoogle(t, { drive: hang });
    const drive = driveClient('synthetic-access', 'synthetic-refresh', { ...google.overrides, timeout: 200 });
    const started = performance.now();
    const error = await withDriveRetry(() => createNoteFileWith(drive, parent, filename, content), noSleep).then(
      () => assert.fail('expected timeout'), (e: unknown) => e);
    assert.ok(elapsedSince(started) < 3000);
    assert.equal(isDriveRetryable(error), false);
    assert.deepEqual(google.counts, { token: 0, list: 1, create: 0, update: 0 });
  });

  await t.test('stalled upload: one create, never replayed in the same request', async (t) => {
    const google = await fakeGoogle(t, { drive: (req, res) => req.method === 'GET' ? json(res, 200, { files: [] }) : undefined });
    const drive = driveClient('synthetic-access', 'synthetic-refresh', { ...google.overrides, timeout: 1000 });
    const started = performance.now();
    await assert.rejects(withDriveRetry(() => createNoteFileWith(drive, parent, filename, content), noSleep),
      (error: unknown) => !isDriveRetryable(error));
    // The Drive timeout governs the upload, not the longer token-request default.
    assert.ok(elapsedSince(started) < 3000);
    assert.deepEqual(google.counts, { token: 0, list: 1, create: 1, update: 0 });
  });
});

/** A one-folder Drive whose name lookup sees every committed file at once. */
function memoryDrive(createFault: (attempt: number) => 'commit' | 'commit_then_drop' | 'commit_then_503' | 'reject_429') {
  const files = new Map<string, { name: string; body: string }>();
  let attempt = 0, nextId = 1;
  const handler: Handler = (req, res, body) => {
    const url = new URL(req.url!, 'http://loopback');
    if (req.method === 'GET' && url.pathname === '/drive/v3/files') {
      const q = url.searchParams.get('q') ?? '';
      return json(res, 200, { files: [...files].filter(([, f]) => q.includes(`name = '${f.name}'`)).map(([id]) => ({ id })) });
    }
    if (req.method === 'POST' && url.pathname === '/upload/drive/v3/files') {
      const fault = createFault(++attempt);
      if (fault === 'reject_429') return json(res, 429, { error: { code: 429, message: 'synthetic rate limit' } });
      const id = `synthetic-file-${nextId++}`;
      files.set(id, { name: body.match(/"name":"([^"]+)"/)![1], body });
      if (fault === 'commit_then_drop') return req.socket.destroy();
      if (fault === 'commit_then_503') return json(res, 503, { error: { code: 503, message: 'synthetic backend' } });
      return json(res, 200, { id, headRevisionId: 'synthetic-revision' });
    }
    const updated = url.pathname.match(/^\/upload\/drive\/v3\/files\/([^/]+)$/);
    if (req.method === 'PATCH' && updated && files.has(updated[1])) {
      files.get(updated[1])!.body = body;
      return json(res, 200, { id: updated[1], headRevisionId: 'synthetic-revision-2' });
    }
    json(res, 404, { error: { code: 404, message: 'synthetic not found' } });
  };
  return { files, handler };
}

test('a create whose response is lost after Drive committed is not replayed blindly', async (t) => {
  const memory = memoryDrive((n) => n === 1 ? 'commit_then_drop' : 'commit');
  const google = await fakeGoogle(t, { drive: memory.handler });
  const drive = driveClient('synthetic-access', 'synthetic-refresh', google.overrides);
  // The request reports the row as failed; neither gaxios nor withDriveRetry resends the POST.
  await assert.rejects(withDriveRetry(() => createNoteFileWith(drive, parent, filename, content), noSleep),
    (error: unknown) => !isDriveRetryable(error));
  assert.deepEqual(google.counts, { token: 0, list: 1, create: 1, update: 0 });
  assert.equal(memory.files.size, 1);
  // The App's later retry finds the committed file by name and rewrites it.
  const replay = await withDriveRetry(() => createNoteFileWith(drive, parent, filename, content), noSleep);
  assert.equal(replay.id, 'synthetic-file-1');
  assert.deepEqual(google.counts, { token: 0, list: 2, create: 1, update: 1 });
  assert.equal(memory.files.size, 1);
});

test('a retryable answer after a committed create rewrites the same file', async (t) => {
  const memory = memoryDrive((n) => n === 1 ? 'commit_then_503' : 'commit');
  const google = await fakeGoogle(t, { drive: memory.handler });
  const drive = driveClient('synthetic-access', 'synthetic-refresh', google.overrides);
  const created = await withDriveRetry(() => createNoteFileWith(drive, parent, filename, content), noSleep);
  assert.equal(created.id, 'synthetic-file-1');
  // withDriveRetry reruns the whole lookup-then-create, never the bare create.
  assert.deepEqual(google.counts, { token: 0, list: 2, create: 1, update: 1 });
  assert.equal(memory.files.size, 1);
});

test('a rate-limited create is retried with backoff and writes once', async (t) => {
  const memory = memoryDrive((n) => n === 1 ? 'reject_429' : 'commit');
  const google = await fakeGoogle(t, { drive: memory.handler });
  const drive = driveClient('synthetic-access', 'synthetic-refresh', google.overrides);
  const waits: number[] = [];
  const created = await withDriveRetry(() => createNoteFileWith(drive, parent, filename, content),
    { sleep: async (ms) => { waits.push(ms); } });
  assert.equal(created.id, 'synthetic-file-1');
  assert.equal(waits.length, 1); assert.ok(waits[0] >= 500 && waits[0] < 1000);
  assert.deepEqual(google.counts, { token: 0, list: 2, create: 2, update: 0 });
  assert.equal(memory.files.size, 1);
});
