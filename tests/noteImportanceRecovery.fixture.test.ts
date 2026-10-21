import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import type { drive_v3 } from 'googleapis';
import { migrateAtomicFile, type AtomicFileV1 } from '../src/types/atomicFile.js';
import { startClientFixture } from './clientFixture.js';

test('recovery generations preserve omitted importance and explicit false, including pending replay', { timeout: 120000 }, async t => {
  const fixture = await startClientFixture(process.env.MONGODB_URI, process.env.MONGODB_DB_NAME);
  const { getDb } = await import('../src/db/mongo.js');
  const { collections } = await import('../src/db/collections.js');
  const { acquireRecoveryLease, releaseRecoveryLease } = await import('../src/lib/recoveryGate.js');
  const { runFreshRecoveryPush } = await import('../src/lib/recoveryWireAdapter.js');
  const { runClassifiedRecoveryPush } = await import('../src/lib/recoveryClassifiedAdapter.js');
  const db = await getDb(), lease = await acquireRecoveryLease(db, fixture.owner);
  t.after(async () => { try { await releaseRecoveryLease(db, lease); } finally { await fixture.close(); } });
  const files = new Map<string, AtomicFileV1>();
  let loseReply = false;
  const drive = { files: {
    async generateIds({ count }: { count: number }) { return { data: { ids: Array.from({ length: count }, () => `synthetic-important-${randomUUID()}`) } }; },
    async create(params: { requestBody: { id: string }; media: { body: AsyncIterable<unknown> } }) {
      let raw = ''; for await (const part of params.media.body) raw += String(part);
      const file = migrateAtomicFile(JSON.parse(raw));
      if (files.has(params.requestBody.id)) { assert.deepEqual(files.get(params.requestBody.id), file); throw { code: 409 }; }
      files.set(params.requestBody.id, file);
      if (loseReply) { loseReply = false; throw new Error('synthetic_reply_lost'); }
      return { data: { id: params.requestBody.id } };
    },
    async get({ fileId, alt }: { fileId: string; alt?: string }) {
      if (!files.has(fileId)) throw { code: 404 };
      return { data: alt === 'media' ? structuredClone(files.get(fileId)) : { id: fileId, parents: ['synthetic-parent'], mimeType: 'application/json', trashed: false } };
    },
  } } as unknown as drive_v3.Drive;
  const row = { id: randomUUID(), kind: 'text', title: 'Public importance', body: 'original', items: [], pinned: false,
    important: true, deleted: false, enc_v: 0, payload: null, created_at: new Date().toISOString(), base_version: 0 };
  const envelope = (rows: object[]) => ({ requestId: randomUUID(), mode: 'instant', rows });
  await runFreshRecoveryPush(db, fixture.owner, lease, envelope([row]), drive, 'synthetic-parent');
  let current = await collections.notes(db).findOne({ _id: row.id });
  assert.equal(current?.important, true);
  assert.equal(files.get(current!.driveFileId)?.important, true);
  const oldClient: Partial<typeof row> = { ...row, body: 'old client edit', base_version: current!.localVersion };
  delete oldClient.important;
  const pending = envelope([oldClient]); loseReply = true;
  await assert.rejects(runClassifiedRecoveryPush(db, fixture.owner, lease, pending, drive, 'synthetic-parent'), /synthetic_reply_lost/);
  await runClassifiedRecoveryPush(db, fixture.owner, lease, pending, drive, 'synthetic-parent');
  current = await collections.notes(db).findOne({ _id: row.id });
  assert.equal(current?.important, true);
  assert.equal(files.get(current!.driveFileId)?.important, true);
  await runClassifiedRecoveryPush(db, fixture.owner, lease, envelope([{ ...oldClient, important: false, base_version: current!.localVersion }]), drive, 'synthetic-parent');
  current = await collections.notes(db).findOne({ _id: row.id });
  assert.equal(current?.important, false);
  assert.equal(files.get(current!.driveFileId)?.important, false);
});
