import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import type { drive_v3 } from 'googleapis';
import type { DriveAdapter } from '../src/routes/notes.js';
import { createNoteFileWith } from '../src/lib/googleDrive.js';
import { FIXTURE_TOKENS, startClientFixture } from './clientFixture.js';
import { assertFixtureCleanup } from './clientFixtureSafety.js';

// The production lookup-then-create (createNoteFileWith) runs against an
// in-memory Drive whose name lookup sees every committed file. Faults model a
// Drive timeout: the library aborts and the request cannot tell whether Google
// committed. These are synthetic notes in a disposable fixture database.
type Fault = null | 'create_timeout_before_write' | 'create_commit_then_timeout' | 'update_commit_then_timeout';
const aborted = () => Object.assign(new Error('The operation was aborted.'), { name: 'AbortError', type: 'aborted' });

test('Drive timeouts and lost responses cannot duplicate files or charges or erase evidence', { timeout: 60000 }, async (t) => {
  const files = new Map<string, { name: string; content: Record<string, unknown> }>();
  const counts = { creates: 0, updates: 0 };
  let fault: Fault = null, nextId = 0;
  const read = async (body: AsyncIterable<unknown>) => {
    let raw = ''; for await (const part of body) raw += String(part);
    return JSON.parse(raw) as Record<string, unknown>;
  };
  const sdk = { files: {
    async list({ q }: { q: string }) {
      return { data: { files: [...files].filter(([, f]) => q.includes(`name = '${f.name}'`)).map(([id]) => ({ id })) } };
    },
    async create({ requestBody, media }: { requestBody: { name: string }; media: { body: AsyncIterable<unknown> } }) {
      counts.creates++;
      const content = await read(media.body);
      if (fault === 'create_timeout_before_write') { fault = null; throw aborted(); }
      const id = `synthetic-provider-file-${++nextId}`;
      files.set(id, { name: requestBody.name, content });
      if (fault === 'create_commit_then_timeout') { fault = null; throw aborted(); }
      return { data: { id, headRevisionId: 'synthetic-revision' } };
    },
    async update({ fileId, media }: { fileId: string; media: { body: AsyncIterable<unknown> } }) {
      counts.updates++;
      if (!files.has(fileId)) throw { code: 404 };
      files.get(fileId)!.content = await read(media.body);
      if (fault === 'update_commit_then_timeout') { fault = null; throw aborted(); }
      return { data: { id: fileId, headRevisionId: 'synthetic-revision-updated' } };
    },
  } } as unknown as drive_v3.Drive;
  const drive: DriveAdapter = {
    createNoteFile: (_a, _r, parentId, name, content) => createNoteFileWith(sdk, parentId, name, content),
    async updateNoteFile(_a, _r, fileId, content) {
      return (await sdk.files.update({ fileId, requestBody: { trashed: false },
        media: { mimeType: 'application/json', body: Readable.from(JSON.stringify(content)) } })).data;
    },
    async deleteNoteFile() { throw new Error('unexpected_delete'); },
    async getNoteFileContent(_a, _r, id) {
      const file = files.get(id);
      if (!file) throw { code: 404 };
      return structuredClone(file.content);
    },
    async ensureAppFolders() { return { notesId: 'fixture-folder' }; },
  };
  const fixture = await startClientFixture(process.env.MONGODB_URI, process.env.MONGODB_DB_NAME, drive);
  t.after(fixture.close);
  const { getDb } = await import('../src/db/mongo.js');
  const { collections } = await import('../src/db/collections.js');
  const db = await getDb(); assertFixtureCleanup(db.databaseName, fixture.database);
  const energy = async () => (await collections.atomicUsers(db).findOne({ _id: fixture.owner }))!.energy;
  const note = (id: string) => collections.notes(db).findOne({ _id: id });
  const call = (path: string, body?: object) => fetch(`${fixture.origin}${path}`, {
    method: body ? 'POST' : 'GET', headers: { 'content-type': 'application/json', authorization: `Bearer ${FIXTURE_TOKENS.a}` },
    body: body ? JSON.stringify(body) : undefined,
  });
  const row = (id: string, body: string, base = 0) => ({ id, kind: 'text', title: 'Provider retry fixture', body,
    items: [], pinned: false, deleted: false, enc_v: 0, payload: null, base_version: base,
    created_at: '2026-11-07T00:00:00.000Z' });
  const push = async (rows: object[], requestId = randomUUID()) => {
    const response = await call('/api/notes/push', { requestId, mode: 'instant', rows });
    return { requestId, status: response.status, body: await response.json() as {
      charged: number; refunded: number; results: { id: string; ok: boolean; error?: string; version?: number }[] } };
  };
  const start = await energy();

  // 1. Timeout before Google wrote anything: the row fails, the charge is refunded, nothing exists to duplicate.
  const a = randomUUID();
  fault = 'create_timeout_before_write';
  const beforeWrite = await push([row(a, 'Synthetic first body')]);
  assert.equal(beforeWrite.status, 502);
  assert.deepEqual(beforeWrite.body.results.map((r) => r.error), ['note_write_failed']);
  assert.equal(beforeWrite.body.charged, 10); assert.equal(beforeWrite.body.refunded, 10);
  assert.equal(files.size, 0); assert.equal(await note(a), null); assert.equal(await energy(), start);
  const aCreated = await push([row(a, 'Synthetic first body')]);
  assert.equal(aCreated.status, 200);
  assert.equal(files.size, 1); assert.equal(counts.creates, 2); assert.equal(await energy(), start - 10);

  // 2. Google committed a create but the response was lost. The request cannot know, so the row
  // fails and is refunded; the committed file is kept, and the App's retry adopts it by name.
  const b = randomUUID();
  fault = 'create_commit_then_timeout';
  const lostCreate = await push([row(b, 'Synthetic second body')]);
  assert.equal(lostCreate.status, 502);
  assert.deepEqual(lostCreate.body.results.map((r) => r.error), ['note_write_failed']);
  assert.equal(lostCreate.body.refunded, 10);
  assert.equal(await note(b), null); assert.equal(files.size, 2); assert.equal(await energy(), start - 10);
  const orphan = [...files].find(([, f]) => f.name === `${b}.atomic`)![0];
  const adopted = await push([row(b, 'Synthetic second body')]);
  assert.equal(adopted.status, 200);
  assert.equal(counts.creates, 3, 'the retry must not create a second file');
  assert.equal(files.size, 2);
  assert.equal((await note(b))!.driveFileId, orphan);
  assert.equal(await energy(), start - 20);
  // A replay of the delivered request is answered from its record: no new charge or write.
  const replay = await push([row(b, 'Synthetic second body')], adopted.requestId);
  assert.deepEqual(replay.body, adopted.body);
  assert.equal(await energy(), start - 20); assert.equal(counts.creates, 3);

  // 3. Google committed an edit but the response was lost. The metadata keeps the old version,
  // so pull refuses the newer file instead of labelling it with the old version, and the file is kept.
  const updatesBefore = counts.updates;
  fault = 'update_commit_then_timeout';
  const lostUpdate = await push([row(a, 'Synthetic edited body', 1)]);
  assert.equal(lostUpdate.status, 502); assert.equal(lostUpdate.body.refunded, 10);
  assert.equal((await note(a))!.localVersion, 1);
  assert.equal(files.get((await note(a))!.driveFileId)!.content.body, 'Synthetic edited body');
  const refused = await call('/api/notes/pull');
  assert.equal(refused.status, 409);
  assert.equal((await refused.json() as { error: string }).error, 'note_content_mismatch');
  assert.equal(await energy(), start - 20);
  // The App's retry carries the same base version and completes the edit in place.
  const edited = await push([row(a, 'Synthetic edited body', 1)]);
  assert.equal(edited.status, 200);
  assert.equal(edited.body.results[0].version, 2);
  assert.equal(counts.updates, updatesBefore + 2); assert.equal(counts.creates, 3); assert.equal(files.size, 2);
  const pulled = await call('/api/notes/pull');
  assert.equal(pulled.status, 200);
  const rows = (await pulled.json() as { rows: { id: string; body: string }[] }).rows;
  assert.equal(rows.find((r) => r.id === a)!.body, 'Synthetic edited body');
  assert.equal(rows.find((r) => r.id === b)!.body, 'Synthetic second body');
  assert.equal(await energy(), start - 30);
  const ledger = await collections.energyLedger(db).find({ userId: fixture.owner }).toArray();
  // Six charges (one per new request), three refunds (one per all-failed request), nothing else.
  assert.equal(ledger.filter((entry) => entry.energyDelta === -10).length, 6);
  assert.equal(ledger.filter((entry) => entry.energyDelta === 10).length, 3);
});
