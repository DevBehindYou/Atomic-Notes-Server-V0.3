import assert from 'node:assert/strict';
import test from 'node:test';
import { createCipheriv, randomBytes, randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { MongoClient } from 'mongodb';
import { FIXTURE_TOKENS, startClientFixture } from './clientFixture.js';

test('isolated encrypted owner persists only payload through actual HTTP and metadata transaction', { timeout: 60000 }, async (t) => {
  let phase = 'setup', passed = false;
  t.after(() => writeFileSync('ci-encrypted-payload-proof.json', JSON.stringify({ version: 1,
    scope: 'disposable encrypted payload HTTP and Mongo', phase, outcome: passed ? 'pass' : 'fail' })));
  const fixture = await startClientFixture(process.env.MONGODB_URI, process.env.MONGODB_DB_NAME);
  t.after(fixture.close);
  const call = (path: string, body?: object) => fetch(`${fixture.origin}${path}`, {
    method: body ? 'POST' : 'GET', headers: { 'content-type': 'application/json', authorization: `Bearer ${FIXTURE_TOKENS.encrypted}` },
    body: body ? JSON.stringify(body) : undefined,
  });
  const inspector = new MongoClient(process.env.MONGODB_URI!);
  try {
    await inspector.connect();
    const db = inspector.db(fixture.database);
    phase = 'isolated_budget';
    const wallet = await db.collection<{ _id: string; energy: number; noteLimit: number }>('atomic_users').findOne({ _id: fixture.encryptedOwner });
    assert.equal(wallet!.energy, 100); assert.equal(wallet!.noteLimit, 50);
    assert.equal(await db.collection('notes').countDocuments({ userId: fixture.encryptedOwner }), 0);
    const nonce = randomBytes(12), key = Buffer.from(Array.from({ length: 32 }, (_, i) => i));
    const cipher = createCipheriv('aes-256-gcm', key, nonce);
    const ciphertext = Buffer.concat([cipher.update(JSON.stringify({ title: 'Synthetic cipher fixture',
      body: 'Synthetic private body', items: [] })), cipher.final()]);
    const payload = Buffer.concat([nonce, ciphertext, cipher.getAuthTag()]).toString('base64');
    const id = randomUUID();
    const request = { requestId: randomUUID(), mode: 'instant', rows: [{ id, kind: 'text', title: '', body: '', items: [],
      pinned: false, deleted: false, enc_v: 1, payload, base_version: 0, created_at: new Date().toISOString() }] };
    phase = 'push';
    const response = await call('/api/notes/push', request);
    assert.equal(response.status, 200);
    const receipt = await response.json() as { charged: number; refunded: number };
    assert.equal(receipt.charged, 10); assert.equal(receipt.refunded, 0);
    phase = 'metadata_only';
    const metadata = await db.collection('notes').findOne({ userId: fixture.encryptedOwner });
    assert.ok(metadata); assert.equal(metadata.encV, 1);
    for (const field of ['title', 'body', 'items', 'payload']) assert.equal(field in metadata, false);
    phase = 'locked_filter';
    const filtered = await (await call('/api/notes/pull?encOnly=true')).json() as { rows: unknown[]; nextCursor: number };
    assert.deepEqual(filtered.rows, []); assert.equal(filtered.nextCursor, 1);
    phase = 'payload_pull';
    const page = await (await call('/api/notes/pull?after=0')).json() as { rows: { id: string; title: string; body: string; items: unknown[]; payload: string; enc_v: number }[] };
    assert.equal(page.rows.length, 1);
    assert.equal(page.rows[0].id, id); assert.equal(page.rows[0].payload, payload);
    assert.equal(page.rows[0].enc_v, 1);
    assert.equal(page.rows[0].title, ''); assert.equal(page.rows[0].body, ''); assert.deepEqual(page.rows[0].items, []);
    phase = 'complete'; passed = true;
  } finally { await inspector.close(); }
});
