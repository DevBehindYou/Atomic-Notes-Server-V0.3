import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { MongoClient } from 'mongodb';
import type { DriveAdapter } from '../src/routes/notes.js';
import { FIXTURE_TOKENS, startClientFixture } from './clientFixture.js';

// Exact App Note.toRemote(uid) + _sealRemote plaintext row: short item keys, a
// discarded user_id, explicit importance and a UTC microsecond timestamp.
const appRow = (overrides: Record<string, unknown> = {}) => ({ id: randomUUID(), user_id: randomUUID(), base_version: 0,
  kind: 'todo', title: 'Synthetic checklist', body: '', items: [{ t: 'Synthetic task', d: false }], pinned: false,
  important: false, deleted: false, created_at: '2026-11-07T04:05:06.123456Z', enc_v: 0, payload: null, ...overrides });

test('push rejects malformed, oversized and unstorable rows before any Drive call or charge; App rows are unchanged',
  { timeout: 120000 }, async t => {
  const files = new Map<string, Record<string, unknown>>();
  const calls = { create: 0, update: 0, delete: 0, read: 0, folders: 0 };
  const notFound = () => Object.assign(new Error('fixture_file_missing'), { code: 404 });
  const drive: DriveAdapter = {
    async createNoteFile(_a, _r, _folder, _name, content) {
      calls.create++; const id = randomUUID(); files.set(id, structuredClone(content) as Record<string, unknown>);
      return { id, headRevisionId: 'fixture-revision' };
    },
    async updateNoteFile(_a, _r, id, content) {
      calls.update++; if (!files.has(id)) throw notFound();
      files.set(id, structuredClone(content) as Record<string, unknown>);
      return { id, headRevisionId: 'fixture-revision' };
    },
    async deleteNoteFile(_a, _r, id) { calls.delete++; if (!files.delete(id)) throw notFound(); },
    async getNoteFileContent(_a, _r, id) {
      calls.read++; const content = files.get(id); if (!content) throw notFound(); return structuredClone(content);
    },
    async ensureAppFolders() { calls.folders++; return { notesId: 'fixture-folder' }; },
  };
  const fixture = await startClientFixture(process.env.MONGODB_URI, process.env.MONGODB_DB_NAME, drive);
  t.after(fixture.close);
  const inspector = new MongoClient(process.env.MONGODB_URI!);
  await inspector.connect();
  t.after(() => inspector.close());
  const db = inspector.db(fixture.database);
  const post = (body: string, token: string = FIXTURE_TOKENS.a) => fetch(`${fixture.origin}/api/notes/push`, {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body });
  const push = (rows: unknown[], token?: string) => post(JSON.stringify({ mode: 'instant', requestId: randomUUID(), rows }), token);
  const providerCalls = () => calls.create + calls.update + calls.delete + calls.folders;
  const accountState = async (userId: string) => ({
    energy: (await db.collection<{ _id: string; energy: number }>('atomic_users').findOne({ _id: userId }))?.energy,
    ledger: await db.collection('energy_ledger').countDocuments({ userId }),
    operations: await db.collection('sync_operations').countDocuments({ userId }),
    notes: await db.collection('notes').countDocuments({ userId }),
  });

  // Another account's existing note, for the cross-account identity case.
  const foreign = appRow();
  assert.equal((await push([foreign], FIXTURE_TOKENS.other)).status, 200);

  const before = await accountState(fixture.owner), callsBefore = providerCalls();
  // Sent as raw text: JSON.stringify is recursive, the Server's JSON.parse is not.
  const deep = '['.repeat(10000) + ']'.repeat(10000);
  const pushDeep = (row: object) => post(JSON.stringify({ mode: 'instant', requestId: randomUUID(), rows: [row] }).replace('"__deep__"', deep));
  const rejected: Array<[string, () => Promise<Response>, number, string]> = [
    ['unparseable JSON', () => post('{"rows":['), 400, 'invalid_json'],
    ['non-object body', () => post('[]'), 400, 'invalid_request'],
    ['offset hour outside 00-23', () => push([appRow({ created_at: '2026-10-24T12:13+24:00' })]), 400, 'invalid_request'],
    ['offset minute outside 00-59', () => push([appRow({ created_at: '2026-10-24T12:13:14-0060' })]), 400, 'invalid_request'],
    ['instant shifted below year 0000', () => push([appRow({ created_at: '0000-01-01T00:00+00:01' })]), 400, 'invalid_request'],
    ['instant shifted above year 9999', () => push([appRow({ created_at: '9999-12-31T23:59-01:00' })]), 400, 'invalid_request'],
    ['malformed note ID', () => push([appRow({ id: '../not-a-note' })]), 400, 'invalid_request'],
    ['malformed request ID', () => post(JSON.stringify({ mode: 'instant', requestId: 'retry-1', rows: [appRow()] })), 400, 'invalid_request'],
    ['101 rows', () => push(Array.from({ length: 101 }, () => appRow())), 400, 'invalid_request'],
    ['duplicate note IDs', () => { const row = appRow(); return push([row, { ...row }]); }, 400, 'duplicate_note_ids'],
    ['deeply nested items', () => pushDeep(appRow({ items: '__deep__' })), 400, 'invalid_request'],
    ['deeply nested item text', () => pushDeep(appRow({ items: [{ t: '__deep__', d: false }] })), 400, 'invalid_request'],
    ['non-finite base version', () => post(JSON.stringify({ mode: 'instant', requestId: randomUUID(), rows: [appRow()] })
      .replace('"base_version":0', '"base_version":1e309')), 400, 'invalid_request'],
    ['rich body over the note bound', () => push([appRow({ kind: 'text', items: [], body: 'a'.repeat(262145) })]), 400, 'invalid_request'],
    ['another account\'s note ID', () => push([appRow({ id: foreign.id })]), 409, 'note_id_conflict'],
  ];
  for (const [name, send, status, error] of rejected) {
    const response = await send();
    assert.equal(response.status, status, name);
    assert.equal((await response.json() as { error: string }).error, error, name);
    assert.equal(providerCalls(), callsBefore, `${name}: no Drive write`);
  }
  assert.deepEqual(await accountState(fixture.owner), before, 'no charge, ledger, operation or note metadata');

  // Old native clients: the real App row and a legacy offset row are accepted and read back.
  const app = appRow(), legacyOffset = appRow({ kind: 'text', items: [], body: 'Legacy offset', created_at: '2026-10-24T12:13:14+0530' });
  const accepted = await push([app, legacyOffset]);
  assert.equal(accepted.status, 200);
  const receipt = await accepted.json() as { ok: boolean; results: Array<{ id: string; ok: boolean }> };
  assert.equal(receipt.ok, true); assert.deepEqual(receipt.results.map(r => [r.id, r.ok]), [[app.id, true], [legacyOffset.id, true]]);
  const pulled = await fetch(`${fixture.origin}/api/notes/pull?after=0`, { headers: { authorization: `Bearer ${FIXTURE_TOKENS.a}` } });
  assert.equal(pulled.status, 200);
  const page = await pulled.json() as { rows: Array<Record<string, unknown>> };
  const byId = new Map(page.rows.map(row => [row.id, row]));
  assert.deepEqual(byId.get(app.id)?.items, [{ text: 'Synthetic task', done: false }]);
  assert.equal(byId.get(app.id)?.created_at, new Date(app.created_at).toISOString());
  assert.equal(byId.get(legacyOffset.id)?.created_at, new Date(legacyOffset.created_at).toISOString());
  assert.equal(Object.hasOwn(byId.get(app.id)!, 'user_id'), false);
});
