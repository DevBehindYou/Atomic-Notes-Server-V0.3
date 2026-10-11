import assert from 'node:assert/strict';
import test from 'node:test';
import type { drive_v3 } from 'googleapis';
import { createNoteGenerationWith, generateNoteFileIdsWith, readNoteGenerationWith } from '../src/lib/driveGeneration.js';

const content = { version: 1, id: '00000000-0000-4000-8000-000000000002', kind: 'text',
  title: 'Public synthetic retry', body: 'Public synthetic complete stream', items: [], pinned: false,
  encV: 0, payload: null, createdAt: '2026-10-12T00:00:00.000Z', updatedAt: '2026-10-12T00:00:00.000Z' };
const fileId = 'synthetic-retained-retry-id', parent = 'synthetic-retry-parent';
const clock = () => {
  const waits: number[] = [];
  return { waits, options: { sleep: async (ms: number) => { waits.push(ms); } } };
};
const metadata = { id: fileId, parents: [parent], mimeType: 'application/json', trashed: false };

test('inactive ID allocation retries existing policy without accepting malformed IDs', async () => {
  let calls = 0; const timer = clock();
  const sdk = { files: { async generateIds() {
    if (++calls === 1) throw { status: 503 };
    return { data: { ids: [fileId] } };
  } } } as unknown as drive_v3.Drive;
  assert.deepEqual(await generateNoteFileIdsWith(sdk, 1, timer.options), [fileId]);
  assert.equal(calls, 2); assert.equal(timer.waits.length, 1);
  const bad = { files: { async generateIds() { calls++; return { data: { ids: [] } }; } } } as unknown as drive_v3.Drive;
  await assert.rejects(generateNoteFileIdsWith(bad, 1, timer.options), /generation_ids_invalid/);
  assert.equal(calls, 3); assert.equal(timer.waits.length, 1);
});

test('consumed failed create stream is recreated with the same ID body and parent', async () => {
  let creates = 0; const timer = clock(), streams = new Set<unknown>();
  const bodies: unknown[] = [];
  const sdk = { files: {
    async create(params: { requestBody: { id: string; parents: string[] }; media: { body: AsyncIterable<unknown> } }) {
      creates++; assert.equal(params.requestBody.id, fileId); assert.deepEqual(params.requestBody.parents, [parent]);
      assert.equal(streams.has(params.media.body), false); streams.add(params.media.body);
      let raw = ''; for await (const part of params.media.body) raw += String(part);
      bodies.push(JSON.parse(raw));
      if (creates === 1) throw { response: { status: 429 } };
      return { data: { id: fileId } };
    },
    async get(params: { alt?: string }) { return { data: params.alt === 'media' ? content : metadata }; },
  } } as unknown as drive_v3.Drive;
  assert.deepEqual(await createNoteGenerationWith(sdk, fileId, parent, content, timer.options), { id: fileId, replayed: false });
  assert.equal(creates, 2); assert.deepEqual(bodies, [content, content]); assert.equal(timer.waits.length, 1);
});

test('retryable lost create reply accepts one retained file only after 409 exact readback', async () => {
  let creates = 0, files = 0, gets = 0; const timer = clock();
  const sdk = { files: {
    async create(params: { media: { body: AsyncIterable<unknown> } }) {
      creates++; let raw = ''; for await (const part of params.media.body) raw += String(part);
      assert.deepEqual(JSON.parse(raw), content);
      if (files) throw { code: 409 };
      files++; throw { code: 503 };
    },
    async get(params: { alt?: string }) { gets++; return { data: params.alt === 'media' ? content : metadata }; },
  } } as unknown as drive_v3.Drive;
  assert.deepEqual(await createNoteGenerationWith(sdk, fileId, parent, content, timer.options), { id: fileId, replayed: true });
  assert.equal(creates, 2); assert.equal(files, 1); assert.equal(gets, 2); assert.equal(timer.waits.length, 1);
});

test('metadata and media retry separately while retaining exact file identity', async () => {
  let meta = 0, media = 0; const timer = clock();
  const sdk = { files: { async get(params: { fileId: string; alt?: string }) {
    assert.equal(params.fileId, fileId);
    if (params.alt === 'media') {
      if (++media === 1) throw { response: { status: 503 } };
      return { data: content };
    }
    if (++meta === 1) throw { status: 403, errors: [{ reason: 'rateLimitExceeded' }] };
    return { data: metadata };
  } } } as unknown as drive_v3.Drive;
  assert.deepEqual(await readNoteGenerationWith(sdk, fileId, parent, timer.options), content);
  assert.equal(meta, 2); assert.equal(media, 2); assert.equal(timer.waits.length, 2);
});

test('four-attempt ceiling and existing backoff are retained, final and opaque errors are not retried', async () => {
  const permanent = { response: { status: 503 } }; let calls = 0; const timer = clock();
  // Unknown runtime options cannot change the production policy through this
  // sleep-only inactive test seam, even if a JavaScript caller adds properties.
  Object.assign(timer.options, { attempts: 1, baseMs: 1 });
  const sdk = { files: { async create() { calls++; throw permanent; } } } as unknown as drive_v3.Drive;
  await assert.rejects(createNoteGenerationWith(sdk, fileId, parent, content, timer.options), seen => seen === permanent);
  assert.equal(calls, 4); assert.equal(timer.waits.length, 3);
  for (let i = 0; i < 3; i++) assert.ok(timer.waits[i] >= 500 * 2 ** i && timer.waits[i] < 500 * 2 ** i + 500);
  for (const error of [{ code: 400 }, { code: 401 }, { code: 404 },
    { response: { status: 400, data: { error: 'invalid_grant' } } },
    { status: 403, errors: [{ reason: 'insufficientFilePermissions' }] }, { code: 'ECONNRESET' }]) {
    calls = 0; const finalTimer = clock();
    const finalSdk = { files: { async create() { calls++; throw error; } } } as unknown as drive_v3.Drive;
    await assert.rejects(createNoteGenerationWith(finalSdk, fileId, parent, content, finalTimer.options), seen => seen === error);
    assert.equal(calls, 1); assert.deepEqual(finalTimer.waits, []);
  }
});

test('successful SDK response with wrong identity or content is never retried', async () => {
  for (const corrupt of ['created_id', 'parent', 'media']) {
    let creates = 0, gets = 0; const timer = clock();
    const sdk = { files: {
      async create() { creates++; return { data: { id: corrupt === 'created_id' ? 'wrong-id' : fileId } }; },
      async get(params: { alt?: string }) {
        gets++;
        return { data: params.alt === 'media' ? { ...content, body: 'Different public body' } :
          { ...metadata, parents: corrupt === 'parent' ? ['wrong-parent'] : [parent] } };
      },
    } } as unknown as drive_v3.Drive;
    await assert.rejects(createNoteGenerationWith(sdk, fileId, parent, content, timer.options), /generation_(identity|content)_mismatch/);
    assert.equal(creates, 1); assert.equal(gets, corrupt === 'created_id' ? 0 : corrupt === 'parent' ? 1 : 2);
    assert.deepEqual(timer.waits, []);
  }
});
