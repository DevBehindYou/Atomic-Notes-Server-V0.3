import assert from 'node:assert/strict';
import test from 'node:test';
import type { drive_v3 } from 'googleapis';
import { generateNoteFileIdsWith, createNoteGenerationWith } from '../src/lib/driveGeneration.js';

const content = { version: 1, id: '00000000-0000-4000-8000-000000000001', kind: 'text',
  title: 'Public synthetic generation', body: 'Public synthetic content', items: [], pinned: false,
  encV: 0, payload: null, createdAt: '2026-10-07T00:00:00.000Z', updatedAt: '2026-10-07T00:00:00.000Z' };
function fakeDrive({ existing = false, lostReply = false, changed = false, metadata = {} as object, failure = undefined as unknown } = {}) {
  const state = { creates: 0, gets: 0, files: existing ? 1 : 0, stored: changed ? { ...content, body: 'Different synthetic content' } : content };
  const drive = { files: {
    async create(params: { requestBody: { id: string; parents: string[] }; media: { body: AsyncIterable<unknown> } }) {
      state.creates++;
      assert.equal(params.requestBody.id, 'synthetic-generated-id'); assert.deepEqual(params.requestBody.parents, ['synthetic-parent']);
      if (failure) throw failure;
      if (state.files) throw { response: { status: 409 } };
      let body = ''; for await (const part of params.media.body) body += String(part);
      state.stored = JSON.parse(body); state.files++;
      if (lostReply) throw Object.assign(new Error('synthetic_reply_lost'), { code: 'ECONNRESET' });
      return { data: { id: params.requestBody.id } };
    },
    async get(params: { fileId: string; alt?: string }) {
      state.gets++;
      assert.equal(params.fileId, 'synthetic-generated-id');
      return { data: params.alt === 'media' ? state.stored : { id: params.fileId, parents: ['synthetic-parent'],
        mimeType: 'application/json', trashed: false, ...metadata } };
    },
    async update() { throw new Error('generation_must_never_update'); },
    async delete() { throw new Error('generation_must_never_delete'); },
    async list() { throw new Error('generation_must_never_discover_by_name'); },
  } } as unknown as drive_v3.Drive;
  return { drive, state };
}

test('generated IDs use the existing Drive file space and exact bounded count', async () => {
  const drive = { files: { async generateIds(params: object) {
    assert.deepEqual(params, { count: 2, space: 'drive', type: 'files', fields: 'ids' });
    return { data: { ids: ['synthetic-one', 'synthetic-two'] } };
  } } } as unknown as drive_v3.Drive;
  assert.deepEqual(await generateNoteFileIdsWith(drive, 2), ['synthetic-one', 'synthetic-two']);
});
test('invalid counts are refused before a Drive call', async () => {
  const drive = { files: { async generateIds() { throw new Error('unexpected_drive_call'); } } } as unknown as drive_v3.Drive;
  for (const count of [0, -1, 1.5, NaN, 1001]) await assert.rejects(generateNoteFileIdsWith(drive, count), /generation_count_invalid/);
});
test('missing, duplicate, mismatched or empty generated IDs are refused', async () => {
  for (const ids of [undefined, ['one'], ['one', 'one'], ['one', '']]) {
    const drive = { files: { async generateIds() { return { data: { ids } }; } } } as unknown as drive_v3.Drive;
    await assert.rejects(generateNoteFileIdsWith(drive, 2), /generation_ids_invalid/);
  }
});
test('fresh generation is create-only and checks parent and exact content readback', async () => {
  const { drive, state } = fakeDrive();
  assert.deepEqual(await createNoteGenerationWith(drive, 'synthetic-generated-id', 'synthetic-parent', content),
    { id: 'synthetic-generated-id', replayed: false });
  assert.equal(state.files, 1); assert.equal(state.creates, 1); assert.equal(state.gets, 2);
});
test('lost create reply retries the retained ID without a second file or overwrite', async () => {
  const { drive, state } = fakeDrive({ lostReply: true });
  await assert.rejects(createNoteGenerationWith(drive, 'synthetic-generated-id', 'synthetic-parent', content), /synthetic_reply_lost/);
  assert.deepEqual(await createNoteGenerationWith(drive, 'synthetic-generated-id', 'synthetic-parent', content),
    { id: 'synthetic-generated-id', replayed: true });
  assert.equal(state.files, 1); assert.equal(state.creates, 2); assert.equal(state.gets, 2);
});
test('conflicting existing generation is refused without overwriting its content', async () => {
  const { drive, state } = fakeDrive({ existing: true, changed: true });
  await assert.rejects(createNoteGenerationWith(drive, 'synthetic-generated-id', 'synthetic-parent', content), /generation_content_mismatch/);
  assert.equal(state.stored.body, 'Different synthetic content'); assert.equal(state.files, 1);
});
test('wrong parent, identity, MIME or trashed generation is refused before media read', async () => {
  for (const metadata of [{ parents: ['wrong-parent'] }, { id: 'wrong-id' }, { mimeType: 'text/plain' }, { trashed: true }]) {
    const { drive, state } = fakeDrive({ existing: true, metadata });
    await assert.rejects(createNoteGenerationWith(drive, 'synthetic-generated-id', 'synthetic-parent', content), /generation_identity_mismatch/);
    assert.equal(state.gets, 1); assert.equal(state.files, 1);
  }
});
test('non-conflict API failures propagate without treating them as a recovered create', async () => {
  const error = Object.assign(new Error('synthetic_throttle'), { code: 429 });
  const { drive, state } = fakeDrive({ failure: error });
  await assert.rejects(createNoteGenerationWith(drive, 'synthetic-generated-id', 'synthetic-parent', content), (seen) => seen === error);
  assert.equal(state.gets, 0); assert.equal(state.files, 0);
});
test('invalid identity and mixed plaintext/ciphertext are refused before create', async () => {
  const { drive, state } = fakeDrive();
  await assert.rejects(createNoteGenerationWith(drive, '', 'synthetic-parent', content), /generation_identity_invalid/);
  await assert.rejects(createNoteGenerationWith(drive, 'synthetic-generated-id', 'synthetic-parent', { ...content, encV: 1, payload: 'synthetic-cipher' }));
  assert.equal(state.creates, 0); assert.equal(state.files, 0);
});
