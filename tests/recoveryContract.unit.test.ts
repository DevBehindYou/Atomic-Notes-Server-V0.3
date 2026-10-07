import assert from 'node:assert/strict';
import test from 'node:test';
import { noteWriteIntentSchema, recoveryGateSchema, parseRecoveryIntents, nextRecoveryRevision,
  recoveryIndexSpecs } from '../src/db/recoveryContract.js';

const userId = '00000000-0000-4000-8000-000000000001';
const requestId = '00000000-0000-4000-8000-000000000002';
const noteId = '00000000-0000-4000-8000-000000000003';
const leaseToken = '00000000-0000-4000-8000-000000000004';
const now = new Date('2026-10-08T00:00:00.000Z');
const prepared = { _id: `${userId}:${requestId}:${noteId}`, format: 1, userId, requestId, noteId,
  operationId: `${userId}:${requestId}`, fingerprint: 'a'.repeat(64), expectedVersion: 0,
  expectedFileId: null, expectedHash: null, stagedFileId: 'synthetic-generation', targetHash: 'b'.repeat(64),
  targetFlags: { kind: 'text', encV: 1, pinned: false, deleted: false }, wipeEpoch: 0, leaseToken,
  state: 'prepared', createdAt: now, updatedAt: now, committedVersion: null, committedSequence: null, terminalReason: null };

test('strict metadata intent accepts a prepared generation without note content', () => {
  assert.deepEqual(noteWriteIntentSchema.parse(prepared), prepared);
  assert.deepEqual(parseRecoveryIntents([prepared]), [prepared]);
});
test('intent refuses note content, credentials and unknown fields instead of stripping them', () => {
  for (const key of ['title', 'body', 'items', 'payload', 'accessToken', 'vaultKey', 'extra']) {
    assert.equal(noteWriteIntentSchema.safeParse({ ...prepared, [key]: 'public synthetic forbidden value' }).success, false);
  }
  assert.equal(noteWriteIntentSchema.safeParse({ ...prepared, targetFlags: { ...prepared.targetFlags, body: 'synthetic' } }).success, false);
});
test('owner/request/note identities must agree with both deterministic record identities', () => {
  for (const mutation of [{ _id: `${userId}:${requestId}:${leaseToken}` }, { operationId: `${userId}:${noteId}` },
    { userId: leaseToken }, { requestId: leaseToken }, { noteId: leaseToken }]) {
    assert.equal(noteWriteIntentSchema.safeParse({ ...prepared, ...mutation }).success, false);
  }
});
test('fresh intent cannot reference a previous pointer/hash or overwrite its existing generation', () => {
  for (const mutation of [{ expectedFileId: 'synthetic-old' }, { expectedHash: 'c'.repeat(64) },
    { expectedVersion: 1, expectedFileId: prepared.stagedFileId, expectedHash: 'c'.repeat(64) }]) {
    assert.equal(noteWriteIntentSchema.safeParse({ ...prepared, ...mutation }).success, false);
  }
});
test('committed state requires both authoritative numbers and no failure reason', () => {
  const committed = { ...prepared, state: 'committed', committedVersion: 2, committedSequence: 3 };
  assert.equal(noteWriteIntentSchema.safeParse(committed).success, true);
  for (const mutation of [{ committedVersion: null }, { committedSequence: null },
    { terminalReason: 'write_interrupted' }, { state: 'verified' }]) {
    assert.equal(noteWriteIntentSchema.safeParse({ ...committed, ...mutation }).success, false);
  }
});
test('terminal failures require fixed reasons and cannot carry committed fields', () => {
  for (const state of ['abandoned', 'superseded']) {
    assert.equal(noteWriteIntentSchema.safeParse({ ...prepared, state, terminalReason: 'wipe_changed' }).success, true);
    for (const mutation of [{ terminalReason: null }, { terminalReason: 'synthetic free text' },
      { committedVersion: 1, committedSequence: 1 }]) {
      assert.equal(noteWriteIntentSchema.safeParse({ ...prepared, state, terminalReason: 'wipe_changed', ...mutation }).success, false);
    }
  }
});
test('verified content requires a staged identity or a previous pointer eligible for readback', () => {
  assert.equal(noteWriteIntentSchema.safeParse({ ...prepared, state: 'verified', stagedFileId: null }).success, false);
  assert.equal(noteWriteIntentSchema.safeParse({ ...prepared, state: 'verified', expectedVersion: 1,
    expectedFileId: 'synthetic-old', expectedHash: 'c'.repeat(64), stagedFileId: null }).success, true);
});
test('malformed hashes, numbers, dates, identities and flags are refused', () => {
  for (const mutation of [{ fingerprint: 'A'.repeat(64) }, { targetHash: 'short' }, { wipeEpoch: 1.5 },
    { expectedVersion: -1 }, { expectedVersion: Number.MAX_SAFE_INTEGER + 1 }, { stagedFileId: '' },
    { stagedFileId: 'x'.repeat(257) }, { format: 2 }, { updatedAt: new Date(now.getTime() - 1) },
    { createdAt: now.toISOString() }, { targetFlags: { ...prepared.targetFlags, encV: 2 } }]) {
    assert.equal(noteWriteIntentSchema.safeParse({ ...prepared, ...mutation }).success, false);
  }
});
test('batch bounds preserve unique row/generation identity', () => {
  const rows = Array.from({ length: 50 }, (_, i) => {
    const id = `00000000-0000-4000-8000-${String(i + 10).padStart(12, '0')}`;
    return { ...prepared, noteId: id, _id: `${userId}:${requestId}:${id}`, stagedFileId: `synthetic-${i}` };
  });
  assert.equal(parseRecoveryIntents(rows).length, 50);
  assert.throws(() => parseRecoveryIntents([]));
  assert.throws(() => parseRecoveryIntents([...rows, prepared]));
  assert.throws(() => parseRecoveryIntents([prepared, prepared]), /recovery_batch_duplicate_note/);
  assert.throws(() => parseRecoveryIntents([rows[0], { ...rows[1], stagedFileId: rows[0].stagedFileId }]), /recovery_batch_generation_reused/);
  assert.throws(() => parseRecoveryIntents([rows[0], { ...rows[1], expectedVersion: 1,
    expectedFileId: rows[0].stagedFileId, expectedHash: 'c'.repeat(64) }]), /recovery_batch_generation_reused/);
});
test('batch refuses differing operation, owner, envelope, lease and wipe epoch', () => {
  const second = { ...prepared, noteId: leaseToken, _id: `${userId}:${requestId}:${leaseToken}`, stagedFileId: 'synthetic-second' };
  for (const mutation of [{ fingerprint: 'c'.repeat(64) }, { wipeEpoch: 1 }, { leaseToken: requestId },
    { requestId: noteId, operationId: `${userId}:${noteId}`, _id: `${userId}:${noteId}:${leaseToken}` },
    { userId: requestId, operationId: `${requestId}:${requestId}`, _id: `${requestId}:${requestId}:${leaseToken}` }]) {
    assert.throws(() => parseRecoveryIntents([prepared, { ...second, ...mutation }]), /recovery_batch_identity_mismatch/);
  }
});
test('persistent gate strictly pairs lease token/expiry and refuses user content', () => {
  const gate = { _id: userId, format: 1, wipeEpoch: 0, gateRevision: 0, leaseToken: null, leaseExpiresAt: null, updatedAt: now };
  assert.equal(recoveryGateSchema.safeParse(gate).success, true);
  assert.equal(recoveryGateSchema.safeParse({ ...gate, leaseToken, leaseExpiresAt: now }).success, true);
  for (const mutation of [{ leaseToken }, { leaseExpiresAt: now }, { gateRevision: -1 },
    { wipeEpoch: Number.MAX_SAFE_INTEGER + 1 }, { body: 'synthetic forbidden value' }]) {
    assert.equal(recoveryGateSchema.safeParse({ ...gate, ...mutation }).success, false);
  }
});
test('revision increment refuses overflow and malformed prior state', () => {
  assert.equal(nextRecoveryRevision(0), 1);
  assert.equal(nextRecoveryRevision(Number.MAX_SAFE_INTEGER - 1), Number.MAX_SAFE_INTEGER);
  for (const value of [-1, 1.1, '1', NaN, Number.MAX_SAFE_INTEGER + 1]) assert.throws(() => nextRecoveryRevision(value));
  assert.throws(() => nextRecoveryRevision(Number.MAX_SAFE_INTEGER), /recovery_revision_exhausted/);
});
test('index declarations exclude TTL/pruning and constrain non-null generation reuse', () => {
  assert.equal(recoveryIndexSpecs.length, 3);
  assert.deepEqual(recoveryIndexSpecs.map((spec) => spec.name), ['intent_owner_operation', 'intent_owner_state', 'intent_owner_staged_file']);
  const staged = recoveryIndexSpecs[2];
  assert.equal(staged.unique, true);
  assert.deepEqual(staged.key, { userId: 1, stagedFileId: 1 });
  assert.deepEqual(staged.partialFilterExpression, { stagedFileId: { $type: 'string' } });
  for (const spec of recoveryIndexSpecs) assert.equal('expireAfterSeconds' in spec, false);
});
