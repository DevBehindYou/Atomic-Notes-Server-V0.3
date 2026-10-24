import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import test from 'node:test';
import { MongoClient } from 'mongodb';
import type { NoteDoc } from '../src/db/collections.js';
import { FIXTURE_TOKENS, startClientFixture } from './clientFixture.js';
import { budgetRow, threeImageContent, sealFixtureContent, openFixtureContent, rowAtWireBytes } from './noteImageBudgetFixtures.js';

const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

test('actual HTTP roundtrip preserves three60KB images, real AES-GCM payload and legacy notes', { timeout: 120000 }, async t => {
  const fixture = await startClientFixture(process.env.MONGODB_URI, process.env.MONGODB_DB_NAME);
  t.after(fixture.close);
  const call = (path: string, body?: object) => fetch(`${fixture.origin}${path}`, {
    method: body ? 'POST' : 'GET', headers: { 'content-type': 'application/json', authorization: `Bearer ${FIXTURE_TOKENS.a}` },
    body: body ? JSON.stringify(body) : undefined,
  });
  const content = threeImageContent();
  const plain = { ...budgetRow(), ...content };
  const sealed = { ...budgetRow(), enc_v: 1 as const, payload: sealFixtureContent(content) };
  const legacy = { ...budgetRow(), title: 'Legacy synthetic note', body: 'Legacy plaintext remains unchanged' };
  const request = { mode: 'instant', requestId: randomUUID(), rows: [plain, sealed, legacy] };
  assert.ok(Buffer.byteLength(JSON.stringify(request)) < 2500000);
  const pushed = await call('/api/notes/push', request);
  assert.equal(pushed.status, 200);
  const receipt = await pushed.json() as { results: Array<{ ok: boolean }> };
  assert.equal(receipt.results.length, 3); assert.ok(receipt.results.every(row => row.ok));
  const inspector = new MongoClient(process.env.MONGODB_URI!);
  try {
    await inspector.connect();
    const db = inspector.db(fixture.database);
    const firstPull = await call('/api/notes/pull?after=0'); assert.equal(firstPull.status, 200);
    const page = await firstPull.json() as { rows: Array<{ id: string; title: string; body: string; items: unknown[]; enc_v: number; payload: string | null }>; hasMore: boolean };
    assert.equal(page.rows.length, 3); assert.equal(page.hasMore, false);
    const readPlain = page.rows.find(row => row.id === plain.id)!;
    assert.equal(digest({ title: readPlain.title, body: readPlain.body, items: readPlain.items }), digest(content));
    assert.equal(readPlain.enc_v, 0); assert.equal(readPlain.payload, null);
    const blocks = JSON.parse(readPlain.body).blocks as Array<{ image?: string }>;
    assert.deepEqual(blocks.filter(block => block.image).map(block => Buffer.from(block.image!, 'base64').length), [60000, 60000, 60000]);
    const readSealed = page.rows.find(row => row.id === sealed.id)!;
    assert.equal(readSealed.enc_v, 1); assert.equal(digest(readSealed.payload), digest(sealed.payload));
    assert.equal(readSealed.title, ''); assert.equal(readSealed.body, ''); assert.deepEqual(readSealed.items, []);
    assert.equal(digest(openFixtureContent(readSealed.payload!)), digest(content));
    const readLegacy = page.rows.find(row => row.id === legacy.id)!;
    assert.equal(readLegacy.title, legacy.title); assert.equal(readLegacy.body, legacy.body);
    const encryptedMetadata = await db.collection<NoteDoc>('notes').findOne({ _id: sealed.id });
    assert.ok(encryptedMetadata);
    for (const key of ['title', 'body', 'items', 'payload']) assert.equal(Object.hasOwn(encryptedMetadata, key), false);
    const rejectedRows = [
      { ...budgetRow(), body: 'a'.repeat(262145) },
      { ...budgetRow(), enc_v: 1, payload: 'A'.repeat(393217) },
      rowAtWireBytes(400001),
      { ...sealed, id: randomUUID(), body: 'plaintext must not leak' },
    ];
    for (const row of rejectedRows) {
      const rejected = await call('/api/notes/push', { mode: 'instant', requestId: randomUUID(), rows: [row] });
      assert.equal(rejected.status, 400); await rejected.arrayBuffer();
    }
    assert.equal(await db.collection('notes').countDocuments({ userId: fixture.owner }), 3);
    const afterRejected = await (await call('/api/notes/pull?after=0')).json() as typeof page;
    assert.equal(digest(afterRejected.rows), digest(page.rows));
  } finally { await inspector.close(); }
});
