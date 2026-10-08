import assert from 'node:assert/strict';
import test from 'node:test';
import { logoutAttemptSchema, logoutBatchSchema, logoutBatchFingerprint, logoutReceiptsComplete,
  selectLogoutFunding } from '../src/lib/logoutContract.js';
import type { SyncOperation } from '../src/lib/syncOperation.js';
import { fingerprintOf } from '../src/lib/syncFingerprint.js';
import { remoteNoteRowSchema } from '../src/types/noteWire.js';

const userId = '00000000-0000-4000-8000-000000000001';
const requestId = '00000000-0000-4000-8000-000000000002';
const noteId = '00000000-0000-4000-8000-000000000003';
const attemptId = '00000000-0000-4000-8000-000000000004';
const now = new Date('2026-10-09T00:00:00.000Z');
const row = { id: noteId, kind: 'text', title: 'Public synthetic logout fixture', body: 'Public Ω 😀',
  items: [], pinned: false, deleted: false, created_at: now.toISOString(), enc_v: 0, payload: null, base_version: 3 };
const fingerprint = logoutBatchFingerprint([row]);
const batch = { requestId, fingerprint, rowIds: [noteId], wireBytes: 600 };
const attempt = { _id: `${userId}:${attemptId}`, format: 1, userId, attemptId, sessionHash: 'a'.repeat(64),
  funding: 'emergency', batches: [batch], state: 'prepared', createdAt: now, updatedAt: now };
const operation: SyncOperation = { _id: `${userId}:${requestId}`, userId, fingerprint, mode: 'instant', rowIds: [noteId],
  charged: 0, refunded: 0, previousStandardAt: null, createdAt: now, status: 'complete',
  results: [{ id: noteId, ok: true, version: 4, seq: 1 }] };

test('logout budget considers every batch at the current instant price', () => {
  for (let count = 1; count <= 5; count++) {
    assert.equal(selectLogoutFunding(count * 10, count), 'paid');
    assert.equal(selectLogoutFunding(count * 10 - 1, count), 'emergency');
    assert.equal(selectLogoutFunding(0, count), 'emergency');
  }
});
test('logout budget refuses negative fractional unsafe and out-of-bound inputs', () => {
  for (const energy of [-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) assert.throws(() => selectLogoutFunding(energy, 1));
  for (const count of [0, -1, 1.5, 6, NaN]) assert.throws(() => selectLogoutFunding(0, count));
});
test('strict logout manifest carries only bounded metadata and a hashed session binding', () => {
  assert.deepEqual(logoutAttemptSchema.parse(attempt), attempt);
  for (const key of ['body', 'payload', 'rawToken', 'vaultKey', 'extra']) {
    assert.equal(logoutAttemptSchema.safeParse({ ...attempt, [key]: 'synthetic forbidden field' }).success, false);
    assert.equal(logoutBatchSchema.safeParse({ ...batch, [key]: 'synthetic forbidden field' }).success, false);
  }
});
test('logout manifest refuses mismatched identity dates unsupported formats and raw session strings', () => {
  for (const fields of [{ _id: 'other' }, { format: 2 }, { sessionHash: 'public-raw-test-token' },
    { sessionHash: 'A'.repeat(64) }, { updatedAt: new Date(now.getTime() - 1) }, { createdAt: now.toISOString() }]) {
    assert.equal(logoutAttemptSchema.safeParse({ ...attempt, ...fields }).success, false);
  }
});
test('logout manifest refuses duplicate batches notes and oversized wire records', () => {
  for (const fields of [{ batches: [] }, { batches: [batch, batch] }, { batches: [{ ...batch, rowIds: [noteId, noteId] }] },
    { batches: [{ ...batch, wireBytes: 2_500_001 }] }, { batches: [{ ...batch, wireBytes: 0 }] },
    { batches: [{ ...batch, fingerprint: 'short' }] }]) {
    assert.equal(logoutAttemptSchema.safeParse({ ...attempt, ...fields }).success, false);
  }
});
test('normalized logout digest matches the existing instant operation fingerprint', () => {
  assert.equal(fingerprint, fingerprintOf([remoteNoteRowSchema.parse(row)], 'instant'));
  const shuffled = Object.fromEntries(Object.entries(row).reverse());
  assert.equal(logoutBatchFingerprint([shuffled]), fingerprint);
  assert.equal(logoutBatchFingerprint([{ ...row, base_version: undefined }]),
    fingerprintOf([remoteNoteRowSchema.parse({ ...row, base_version: undefined })], 'instant'));
  const todo = { ...row, kind: 'todo', items: [{ t: 'Public checklist', d: false }] };
  assert.equal(logoutBatchFingerprint([todo]), fingerprintOf([remoteNoteRowSchema.parse(todo)], 'instant'));
});
test('logout digest binds payload versions flags and row order', () => {
  for (const fields of [{ body: row.body + 'edit' }, { base_version: 4 }, { deleted: true }, { pinned: true }]) {
    assert.notEqual(logoutBatchFingerprint([{ ...row, ...fields }]), fingerprint);
  }
  const encrypted = { ...row, title: '', body: '', enc_v: 1, payload: 'synthetic-sealed-envelope' };
  assert.notEqual(logoutBatchFingerprint([encrypted]), logoutBatchFingerprint([{ ...encrypted, payload: 'other-synthetic-envelope' }]));
  const other = { ...row, id: attemptId };
  assert.notEqual(logoutBatchFingerprint([row, other]), logoutBatchFingerprint([other, row]));
  assert.throws(() => logoutBatchFingerprint([row, row]));
});
test('complete emergency receipts permit zero charge only and never mutate inputs', () => {
  const before = JSON.stringify({ attempt, operation });
  assert.equal(logoutReceiptsComplete(attempt, attempt.sessionHash, [operation]), true);
  assert.equal(JSON.stringify({ attempt, operation }), before);
  assert.equal(logoutReceiptsComplete(attempt, attempt.sessionHash, [{ ...operation, charged: 10 }]), false);
});
test('paid completion requires the existing instant charge with no refund', () => {
  const paid = { ...attempt, funding: 'paid' };
  assert.equal(logoutReceiptsComplete(paid, attempt.sessionHash, [{ ...operation, charged: 10 }]), true);
  assert.equal(logoutReceiptsComplete(paid, attempt.sessionHash, [operation]), false);
  assert.equal(logoutReceiptsComplete(paid, attempt.sessionHash, [{ ...operation, charged: 10, refunded: 10 }]), false);
});
test('foreign sessions owners pending and mismatched receipts cannot authorize logout', () => {
  assert.equal(logoutReceiptsComplete(attempt, 'b'.repeat(64), [operation]), false);
  for (const fields of [{ status: 'pending' as const }, { userId: attemptId }, { fingerprint: 'b'.repeat(64) },
    { _id: 'wrong' }, { mode: 'standard' as const }, { rowIds: [] }, { results: [] }]) {
    assert.equal(logoutReceiptsComplete(attempt, attempt.sessionHash, [{ ...operation, ...fields }]), false);
  }
  assert.equal(logoutReceiptsComplete(attempt, attempt.sessionHash, []), false);
  assert.equal(logoutReceiptsComplete(attempt, attempt.sessionHash, [operation, operation]), false);
});
test('failed conflicting unknown or unversioned note results cannot authorize logout', () => {
  for (const result of [{ id: noteId, ok: false, error: 'note_conflict' }, { id: attemptId, ok: true, version: 4 },
    { id: noteId, ok: true }, { id: noteId, ok: true, version: 0 }, { id: noteId, ok: true, version: 1.5 }]) {
    assert.equal(logoutReceiptsComplete(attempt, attempt.sessionHash, [{ ...operation, results: [result] }]), false);
  }
});
test('closed or aborted attempts do not reopen through receipt checks', () => {
  for (const state of ['completed', 'aborted']) {
    assert.equal(logoutReceiptsComplete({ ...attempt, state }, attempt.sessionHash, [operation]), false);
  }
});
