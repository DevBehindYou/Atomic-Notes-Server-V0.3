import assert from 'node:assert/strict';
import test from 'node:test';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { google } from 'googleapis';
import type { DriveAdapter } from '../src/routes/notes.js';
import { driveSession } from '../src/lib/googleDrive.js';
import { FIXTURE_TOKENS, startClientFixture } from './clientFixture.js';
import { assertFixtureCleanup } from './clientFixtureSafety.js';

// The real /push, /pull and wipe routes, with the production per-request Drive session
// pointed at a loopback stand-in for Drive. Proves one Drive client per HTTP request,
// the route's in-flight bound, and that every Drive request carries the stored token.
// Synthetic notes in a disposable fixture database; nothing reaches Google.
test('each sync request builds one Drive client and stays within its in-flight bound', { timeout: 60000 }, async (t) => {
  let built = 0;
  const baseDrive = google.drive.bind(google);
  google.drive = ((...args: Parameters<typeof baseDrive>) => { built++; return baseDrive(...args); }) as typeof google.drive;
  t.after(() => { google.drive = baseDrive as typeof google.drive; });

  const files = new Map<string, { name: string; body: string; trashed: boolean }>();
  const stats = { requests: 0, inFlight: 0, maxInFlight: 0, foreignAuth: 0 };
  let nextId = 0;
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (part) => { body += part; });
    req.on('end', () => {
      stats.requests++; stats.inFlight++; stats.maxInFlight = Math.max(stats.maxInFlight, stats.inFlight);
      res.on('close', () => { stats.inFlight--; });
      if (req.headers.authorization !== 'Bearer fixture-access') stats.foreignAuth++;
      const url = new URL(req.url!, 'http://loopback');
      const fileId = url.pathname.match(/\/files\/([^/]+)$/)?.[1];
      const send = (status: number, value: unknown) => setTimeout(() => {
        res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(value));
      }, 15);
      if (req.method === 'GET' && !fileId) {
        const name = url.searchParams.get('q')?.match(/name = '([^']+)'/)?.[1];
        return send(200, { files: [...files].filter(([, f]) => f.name === name && !f.trashed).map(([id]) => ({ id })) });
      }
      if (req.method === 'POST') {
        const id = `synthetic-concurrency-file-${++nextId}`;
        files.set(id, { name: body.match(/"name":"([^"]+)"/)![1], body: body.match(/(\{"version":1[^\r\n]*\})/)![1], trashed: false });
        return send(200, { id, headRevisionId: 'synthetic-revision' });
      }
      const file = fileId ? files.get(fileId) : undefined;
      if (!file) return send(404, { error: { code: 404, message: 'synthetic not found' } });
      if (req.method === 'PATCH') {
        const content = body.match(/(\{"version":1[^\r\n]*\})/)?.[1];
        if (content) file.body = content;
        if (/"trashed":true/.test(body)) file.trashed = true;
        if (/"trashed":false/.test(body)) file.trashed = false;
        return send(200, { id: fileId, headRevisionId: `synthetic-revision-${stats.requests}` });
      }
      res.writeHead(200, { 'content-type': 'application/json' }); setTimeout(() => res.end(file.body), 15);
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  const unexpected = async () => { throw new Error('per-call Drive adapter used'); };
  const drive: DriveAdapter = { createNoteFile: unexpected, updateNoteFile: unexpected, deleteNoteFile: unexpected,
    getNoteFileContent: unexpected, forRequest: (accessToken, refreshToken) => driveSession(accessToken, refreshToken, { origin }) };
  const fixture = await startClientFixture(process.env.MONGODB_URI, process.env.MONGODB_DB_NAME, drive);
  t.after(fixture.close);
  const { getDb } = await import('../src/db/mongo.js');
  const db = await getDb(); assertFixtureCleanup(db.databaseName, fixture.database);

  const call = async (method: string, path: string, body?: object) => {
    const before = { built, requests: stats.requests };
    stats.maxInFlight = 0;
    const response = await fetch(`${fixture.origin}${path}`, { method,
      headers: { 'content-type': 'application/json', authorization: `Bearer ${FIXTURE_TOKENS.a}` },
      body: body ? JSON.stringify(body) : undefined });
    const json = await response.json() as Record<string, unknown>;
    return { status: response.status, json, clients: built - before.built, requests: stats.requests - before.requests, maxInFlight: stats.maxInFlight };
  };
  const ids = Array.from({ length: 25 }, () => randomUUID());
  const row = (id: string, body: string, base = 0) => ({ id, kind: 'text', title: 'Provider concurrency fixture', body,
    items: [], pinned: false, deleted: false, enc_v: 0, payload: null, base_version: base, created_at: '2026-11-07T00:00:00.000Z' });
  type Results = { results: { ok: boolean }[] };

  // 25 new notes: 25 lookups and 25 creates through one client, at most 8 at once.
  const created = await call('POST', '/api/notes/push', { requestId: randomUUID(), mode: 'instant', rows: ids.map((id) => row(id, 'Synthetic body')) });
  assert.equal(created.status, 200);
  assert.ok((created.json as Results).results.every((r) => r.ok));
  assert.deepEqual([created.clients, created.requests, files.size], [1, 50, 25]);
  assert.ok(created.maxInFlight <= 8, `push in flight ${created.maxInFlight}`);

  // Edits: 25 updates, one client.
  const edited = await call('POST', '/api/notes/push', { requestId: randomUUID(), mode: 'instant', rows: ids.map((id) => row(id, 'Synthetic edit', 1)) });
  assert.equal(edited.status, 200);
  assert.deepEqual([edited.clients, edited.requests], [1, 25]);
  assert.ok(edited.maxInFlight <= 8, `push in flight ${edited.maxInFlight}`);

  // A full pull walk: three page requests, one client each, a page's reads at most 10 at once.
  let after = 0, pages = 0, rows = 0;
  for (;;) {
    const page = await call('GET', `/api/notes/pull?after=${after}`);
    assert.equal(page.status, 200);
    const body = page.json as { rows: { body: string }[]; nextCursor: number; hasMore: boolean };
    assert.ok(body.rows.every((r) => r.body === 'Synthetic edit'));
    assert.deepEqual([page.clients, page.requests], [1, body.rows.length]);
    assert.ok(page.maxInFlight <= 10, `pull in flight ${page.maxInFlight}`);
    pages++; rows += body.rows.length; after = body.nextCursor;
    if (!body.hasMore) break;
  }
  assert.deepEqual([pages, rows], [3, 25]);

  // Emptying the cloud: 25 trash requests, one client.
  const wiped = await call('DELETE', '/api/notes');
  assert.equal(wiped.status, 200);
  assert.deepEqual([wiped.clients, wiped.requests], [1, 25]);
  assert.ok([...files.values()].every((f) => f.trashed));
  assert.equal(stats.foreignAuth, 0, 'every Drive request carries this user\'s stored token');
});
