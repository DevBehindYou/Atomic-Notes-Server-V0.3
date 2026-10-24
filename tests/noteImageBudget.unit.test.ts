import assert from 'node:assert/strict';
import test from 'node:test';
import { NOTE_LIMITS, remoteNoteRowSchema } from '../src/types/noteWire.js';
import { LOGOUT_BOUNDS } from '../src/lib/logoutContract.js';
import { budgetRow, jpegAt60000Bytes, threeImageContent, sealFixtureContent, openFixtureContent, rowAtWireBytes } from './noteImageBudgetFixtures.js';

test('three60000-byte images fit plaintext and actual App-compatible AES-GCM wire envelopes', () => {
  const jpeg = jpegAt60000Bytes();
  assert.equal(jpeg.length, 60000); assert.equal(jpeg.subarray(0, 2).toString('hex'), 'ffd8');
  assert.equal(jpeg.subarray(-2).toString('hex'), 'ffd9');
  const content = threeImageContent(), plain = { ...budgetRow(), ...content };
  assert.ok(plain.body.length > 131072);
  assert.equal(remoteNoteRowSchema.safeParse(plain).success, true);
  const payload = sealFixtureContent(content);
  assert.ok(payload.length > 196608 && payload.length < 393216);
  assert.equal(remoteNoteRowSchema.safeParse({ ...budgetRow(), enc_v: 1, payload }).success, true);
  assert.deepEqual(openFixtureContent(payload), content);
});

test('body and encrypted payload boundaries reject the first byte or character above their bounds', () => {
  assert.deepEqual(NOTE_LIMITS, { title: 300, body: 262144, payload: 393216, wireBytes: 400000 });
  assert.equal(remoteNoteRowSchema.safeParse({ ...budgetRow(), body: 'a'.repeat(262144) }).success, true);
  assert.equal(remoteNoteRowSchema.safeParse({ ...budgetRow(), body: 'a'.repeat(262145) }).success, false);
  assert.equal(remoteNoteRowSchema.safeParse({ ...budgetRow(), enc_v: 1, payload: 'A'.repeat(393216) }).success, true);
  assert.equal(remoteNoteRowSchema.safeParse({ ...budgetRow(), enc_v: 1, payload: 'A'.repeat(393217) }).success, false);
});

test('full serialized UTF8 row cap remains enforced independently of character length', () => {
  const fitting = rowAtWireBytes(400000), oversized = rowAtWireBytes(400001);
  assert.equal(Buffer.byteLength(JSON.stringify({ ...fitting, encV: 0 })), 400000);
  assert.ok(fitting.body.length < 262144);
  assert.equal(remoteNoteRowSchema.safeParse(fitting).success, true);
  const rejected = remoteNoteRowSchema.safeParse(oversized);
  assert.equal(rejected.success, false);
  if (!rejected.success) assert.ok(rejected.error.issues.some(issue => issue.message === 'Note exceeds 400 KB sync limit'));
});

test('larger budgets retain encryption separation and existing batch limits', () => {
  const payload = sealFixtureContent(threeImageContent());
  assert.equal(remoteNoteRowSchema.safeParse({ ...budgetRow(), enc_v: 1, payload, body: 'leak' }).success, false);
  assert.equal(remoteNoteRowSchema.safeParse({ ...budgetRow(), enc_v: 0, payload }).success, false);
  assert.deepEqual(LOGOUT_BOUNDS, { batches: 5, rowsPerBatch: 50, bytesPerBatch: 2500000 });
});

test('ten maximum rows retain headroom under the hosted response cap', () => {
  const payloadRow = { ...budgetRow(), enc_v: 1 as const, payload: 'A'.repeat(393216) };
  assert.equal(remoteNoteRowSchema.safeParse(payloadRow).success, true);
  assert.ok(Buffer.byteLength(JSON.stringify({ ...payloadRow, encV: 1 })) < 400000);
  const page = { rows: Array.from({ length: 10 }, () => ({ ...remoteNoteRowSchema.parse(rowAtWireBytes(400000)),
    updated_at: new Date().toISOString(), version: Number.MAX_SAFE_INTEGER })), cursor: Number.MAX_SAFE_INTEGER,
    nextCursor: Number.MAX_SAFE_INTEGER, hasMore: true, skipped: 0 };
  assert.ok(Buffer.byteLength(JSON.stringify(page)) < 4100000);
});
