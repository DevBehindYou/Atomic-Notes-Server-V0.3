import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import test from 'node:test';
import { MongoClient } from 'mongodb';
import type { NoteDoc } from '../src/db/collections.js';
import { remoteNoteRowSchema } from '../src/types/noteWire.js';
import { noteContentHash } from '../src/lib/contentHash.js';
import { fingerprintOf } from '../src/lib/syncFingerprint.js';
import { logoutBatchFingerprint } from '../src/lib/logoutContract.js';
import { atomicFileV1Schema } from '../src/types/atomicFile.js';
import { FIXTURE_TOKENS, startClientFixture } from './clientFixture.js';

const row = () => ({ id: randomUUID(), kind: 'text' as const, title: 'Important note', body: 'body',
  items: [], pinned: false, deleted: false, created_at: new Date().toISOString(),
  enc_v: 0 as const, payload: null, base_version: 0 });

test('optional importance preserves legacy projections and hashes', () => {
  const legacy = remoteNoteRowSchema.parse(row());
  assert.equal(Object.hasOwn(legacy, 'important'), false);
  const oldHash = createHash('sha256').update(JSON.stringify([
    legacy.kind, legacy.title, legacy.body, legacy.items, legacy.pinned, legacy.enc_v, legacy.payload,
  ])).digest('hex');
  assert.equal(noteContentHash(legacy), oldHash);
  assert.equal(noteContentHash({ ...legacy, important: false }), oldHash);
  assert.notEqual(noteContentHash({ ...legacy, important: true }), oldHash);
  const legacyProjection = { id: legacy.id, kind: legacy.kind, title: legacy.title, body: legacy.body,
    items: legacy.items, pinned: legacy.pinned, deleted: legacy.deleted, created_at: legacy.created_at,
    enc_v: legacy.enc_v, payload: legacy.payload, base_version: legacy.base_version };
  const oldFingerprint = createHash('sha256').update(JSON.stringify({ rows: [legacyProjection], mode: 'instant' })).digest('hex');
  assert.equal(fingerprintOf([legacy], 'instant'), oldFingerprint);
  assert.equal(logoutBatchFingerprint([legacy]), oldFingerprint);
  const explicit = remoteNoteRowSchema.parse({ ...legacy, important: true });
  assert.equal(explicit.important, true);
  assert.deepEqual(Object.keys(explicit).slice(5, 8), ['pinned', 'important', 'deleted']);
  assert.equal(remoteNoteRowSchema.safeParse({ ...legacy, important: 'yes' }).success, false);
  const file = atomicFileV1Schema.parse({ ...legacy, version: 1, createdAt: legacy.created_at, updatedAt: legacy.created_at });
  assert.equal(Object.hasOwn(file, 'important'), false);
  assert.notEqual(logoutBatchFingerprint([legacy]), logoutBatchFingerprint([explicit]));
});

test('HTTP push/pull keeps true across omitted old-client update and clears on false, with replay',
  { timeout: 120000 }, async t => {
    const files = new Map<string, Record<string, unknown>>();
    const fixture = await startClientFixture(process.env.MONGODB_URI, process.env.MONGODB_DB_NAME, {
      async createNoteFile(_a, _r, _parent, _name, content) {
        const id = `synthetic-important-${randomUUID()}`; files.set(id, structuredClone(content) as Record<string, unknown>);
        return { id, headRevisionId: 'synthetic-revision' };
      },
      async updateNoteFile(_a, _r, id, content) { files.set(id, structuredClone(content) as Record<string, unknown>); return { id }; },
      async deleteNoteFile() { /* Files remain readable in synthetic Drive trash. */ },
      async getNoteFileContent(_a, _r, id) { if (!files.has(id)) throw { code: 404 }; return structuredClone(files.get(id)!); },
    });
    t.after(fixture.close);
    const call = (path: string, method = 'GET', body?: object) => fetch(`${fixture.origin}${path}`, {
      method, headers: { 'content-type': 'application/json', authorization: `Bearer ${FIXTURE_TOKENS.a}` },
      body: body ? JSON.stringify(body) : undefined,
    });
    const note = { ...row(), important: true };
    const push = (r: object, requestId = randomUUID()) => call('/api/notes/push', 'POST',
      { mode: 'instant', requestId, rows: [r] });
    const firstRequest = randomUUID();
    const first = await push(note, firstRequest);
    assert.equal(first.status, 200);
    const firstReceipt = await first.json();
    assert.deepEqual(await (await push(note, firstRequest)).json(), firstReceipt);
    let pulled = await (await call('/api/notes/pull')).json() as { rows: Array<{ important?: boolean; version: number }> };
    assert.equal(pulled.rows[0].important, true);
    const oldClient = { ...note, body: 'old client edit', base_version: pulled.rows[0].version };
    delete (oldClient as Partial<typeof oldClient>).important;
    assert.equal((await push(oldClient)).status, 200);
    pulled = await (await call('/api/notes/pull')).json() as typeof pulled;
    assert.equal(pulled.rows[0].important, true);
    const unchanged = await (await push({ ...oldClient, base_version: pulled.rows[0].version })).json() as { results: { unchanged?: boolean }[] };
    assert.equal(unchanged.results[0].unchanged, true);
    const stale = await (await push({ ...oldClient, important: false, base_version: 0 })).json() as { results: { error?: string }[] };
    assert.equal(stale.results[0].error, 'note_conflict');
    assert.equal((await push({ ...oldClient, important: false, base_version: pulled.rows[0].version })).status, 200);
    pulled = await (await call('/api/notes/pull')).json() as typeof pulled;
    assert.equal(pulled.rows[0].important, false);
    const inspector = new MongoClient(process.env.MONGODB_URI!);
    try {
      await inspector.connect();
      const saved = await inspector.db(fixture.database).collection<NoteDoc>('notes').findOne({ _id: note.id });
      assert.equal(saved?.important, false);
      assert.equal(files.get(saved!.driveFileId)?.important, false);
      const metadata = await (await call('/api/notes')).json() as { important?: boolean }[];
      assert.equal(metadata[0].important, false);
      const encrypted = { ...row(), kind: 'todo', title: '', body: '', important: true, enc_v: 1, payload: 'public-opaque-fixture' };
      assert.equal((await push(encrypted)).status, 200);
      const encryptedMeta = await inspector.db(fixture.database).collection<NoteDoc>('notes').findOne({ _id: encrypted.id });
      assert.equal(files.get(encryptedMeta!.driveFileId)?.important, true);
      assert.equal((await push({ ...encrypted, deleted: true, base_version: encryptedMeta!.localVersion })).status, 200);
      files.delete(encryptedMeta!.driveFileId);
      const tombstones = await (await call('/api/notes/pull')).json() as { rows: { id: string; important?: boolean }[] };
      assert.equal(tombstones.rows.find((r: { id: string }) => r.id === encrypted.id)!.important, true);
      // Even records without a content hash must reject disagreement between Drive and metadata flags.
      await inspector.db(fixture.database).collection<NoteDoc>('notes').updateOne({ _id: note.id }, { $unset: { contentHash: '' } });
      files.get(saved!.driveFileId)!.important = true;
      assert.equal((await call('/api/notes/pull')).status, 409);
    } finally { await inspector.close(); }
  });
