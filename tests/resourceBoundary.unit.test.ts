import assert from 'node:assert/strict';
import test from 'node:test';
import { atomicFileV1Schema } from '../src/types/atomicFile.js';
import { remoteNoteRowSchema } from '../src/types/noteWire.js';

// Synthetic identifiers only.
const id = '0c5b2a4e-3f1d-4c8e-9a7b-1d2e3f4a5b6c';
const owner = '7f6e5d4c-3b2a-4190-8f7e-6d5c4b3a2918';

// Exact shape of the App's Note.toRemote(uid) after _sealRemote for a plaintext
// note: short item keys, a user_id the Server must discard, explicit importance,
// a base version and a UTC microsecond timestamp from DateTime.toIso8601String().
const appWireRow = { id, user_id: owner, base_version: 0, kind: 'todo', title: 'Synthetic checklist', body: '',
  items: [{ t: 'Synthetic task', d: false }, { t: 'Done task', d: true }], pinned: false, important: false,
  deleted: false, created_at: '2026-11-07T04:05:06.123456Z', enc_v: 0, payload: null };

// Push writes `new Date(row.created_at).toISOString()` into the Drive file and
// pull reads that file back with the .atomic reader. Both sides are the real code paths.
const driveCreatedAt = (value: string) => new Date(value).toISOString();
const driveReaderAccepts = (value: string) => atomicFileV1Schema.shape.createdAt.safeParse(value).success;
const withCreatedAt = (created_at: string) => ({ ...appWireRow, created_at });

test('created_at values the Drive write cannot store or read back reject at the wire boundary', () => {
  // Offsets outside 00-23 hours/00-59 minutes match the legacy shape but are an Invalid Date:
  // the push handler would throw building the Drive file, after opening the charged operation.
  for (const value of ['2026-10-24T12:13+24:00', '2026-10-24T12:13:14+9999', '2026-10-24T12:13-2360', '2026-10-24T12:13+00:60']) {
    assert.ok(Number.isNaN(Date.parse(value)), value);
    assert.equal(remoteNoteRowSchema.safeParse(withCreatedAt(value)).success, false, value);
  }
  // Valid instants that shift outside four-digit UTC years: the Drive file would be written,
  // then rejected as corrupt by the Server's own reader, making every later pull fail.
  for (const value of ['0000-01-01T00:00+00:01', '0000-01-01T05:00:00+05:30', '9999-12-31T23:59-01:00', '9999-12-31T20:00:00.5-0400']) {
    assert.equal(Number.isNaN(Date.parse(value)), false, value);
    assert.equal(driveReaderAccepts(driveCreatedAt(value)), false, value);
    assert.equal(remoteNoteRowSchema.safeParse(withCreatedAt(value)).success, false, value);
  }
});

test('every accepted created_at, including legacy offsets, round-trips through the Drive reader unchanged on the wire', () => {
  const legacy = ['2026-11-07T04:05:06.123456Z', '2026-10-24T12:13Z', '2026-10-24T12:13:14Z', '2024-02-29T00:00Z',
    '2026-10-24T12:13:14+0530', '2026-10-24T12:13+05:30', '2026-10-24T12:13:14-0700', '2026-10-24T12:13+00:00',
    '2026-10-24T12:13-23:59', '2026-10-24T12:13+2359', '0000-01-01T00:00Z', '0000-01-01T12:00-11:00',
    '9999-12-31T23:59:59.999999Z', '9999-12-31T00:00+05:30'];
  for (const value of legacy) {
    const parsed = remoteNoteRowSchema.parse(withCreatedAt(value));
    assert.equal(parsed.created_at, value, 'the wire string is not normalized');
    assert.ok(driveReaderAccepts(driveCreatedAt(value)), value);
  }
  // Exhaustive offset grid on an ordinary date: exactly the offsets V8 can convert are accepted.
  for (let hours = 0; hours < 100; hours++) for (let minutes = 0; minutes < 100; minutes++) {
    for (const separator of ['', ':']) for (const sign of ['+', '-']) {
      const value = `2026-06-15T12:00${sign}${String(hours).padStart(2, '0')}${separator}${String(minutes).padStart(2, '0')}`;
      assert.equal(remoteNoteRowSchema.safeParse(withCreatedAt(value)).success, hours <= 23 && minutes <= 59, value);
    }
  }
});

test('the App plaintext and sealed wire rows parse to the existing normalized shape', () => {
  const parsed = remoteNoteRowSchema.parse(appWireRow);
  assert.equal(JSON.stringify(parsed), JSON.stringify({ id, kind: 'todo', title: 'Synthetic checklist', body: '',
    items: [{ text: 'Synthetic task', done: false }, { text: 'Done task', done: true }], pinned: false, important: false,
    deleted: false, created_at: appWireRow.created_at, enc_v: 0, payload: null, base_version: 0 }));
  const sealed = remoteNoteRowSchema.parse({ ...appWireRow, title: '', items: [], enc_v: 1, payload: 'c3ludGhldGlj' });
  assert.equal(sealed.payload, 'c3ludGhldGlj'); assert.equal(sealed.created_at, appWireRow.created_at);
});

test('deep nesting, prototype keys and non-finite numbers reject or strip without throwing', () => {
  for (const depth of [1e4, 1e5]) {
    const deep = JSON.parse('['.repeat(depth) + ']'.repeat(depth));
    for (const field of ['id', 'kind', 'title', 'body', 'items', 'pinned', 'important', 'deleted', 'created_at', 'updated_at', 'enc_v', 'payload', 'base_version']) {
      assert.equal(remoteNoteRowSchema.safeParse({ ...appWireRow, [field]: deep }).success, false, `${field}@${depth}`);
    }
    assert.equal(remoteNoteRowSchema.safeParse({ ...appWireRow, items: [{ t: deep, d: true }] }).success, false);
    // Unknown members are stripped, not traversed or serialized.
    assert.equal(Object.hasOwn(remoteNoteRowSchema.parse({ ...appWireRow, extra: deep }), 'extra'), false);
  }
  const hostile = JSON.parse(JSON.stringify(appWireRow).replace('{', '{"__proto__":{"polluted":true},"constructor":{"prototype":{"polluted":true}},'));
  const parsed = remoteNoteRowSchema.parse(hostile);
  assert.equal(Object.getPrototypeOf(parsed), Object.prototype);
  assert.equal(Object.hasOwn(parsed, 'constructor'), false);
  assert.equal(({} as Record<string, unknown>).polluted, undefined);
  for (const base_version of [JSON.parse('1e309'), JSON.parse('-1e309'), -1, 0.5]) {
    assert.equal(remoteNoteRowSchema.safeParse({ ...appWireRow, base_version }).success, false, String(base_version));
  }
});

test('the real Server entrypoint refuses oversized notes requests before session or Drive access', { timeout: 20000 }, async () => {
  // A closed port: any MongoDB access would fail or stall instead of answering 413.
  process.env.MONGODB_URI = 'mongodb://127.0.0.1:9';
  const { default: app } = await import('../src/app.js');
  const oversized = 'x'.repeat(4 * 1024 * 1024 + 1);
  const headers = { 'content-type': 'application/json', authorization: 'Bearer synthetic-unknown-session' };
  for (const path of ['/api/notes/push', '/api/notes/logout-attempt', '/api/notes/logout-attempt/recovery-commit']) {
    const declared = await app.request(path, { method: 'POST', headers: { ...headers, 'content-length': String(oversized.length) }, body: oversized });
    assert.equal(declared.status, 413, path); assert.deepEqual(await declared.json(), { error: 'request_too_large' });
    // Without Content-Length the stream is counted rather than trusted.
    const bytes = new TextEncoder().encode(oversized);
    const body = new ReadableStream<Uint8Array>({ start(controller) {
      for (let offset = 0; offset < bytes.length; offset += 65536) controller.enqueue(bytes.subarray(offset, offset + 65536));
      controller.close();
    } });
    const streamed = await app.request(path, { method: 'POST', headers, body, duplex: 'half' } as RequestInit);
    assert.equal(streamed.status, 413, path); assert.deepEqual(await streamed.json(), { error: 'request_too_large' });
  }
});
