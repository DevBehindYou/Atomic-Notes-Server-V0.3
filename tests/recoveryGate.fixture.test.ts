import assert from 'node:assert/strict';
import test from 'node:test';
import { writeFileSync } from 'node:fs';
import { startClientFixture } from './clientFixture.js';
import { assertFixtureCleanup } from './clientFixtureSafety.js';
import type { RecoveryGate } from '../src/db/recoveryContract.js';

test('inactive gate fences handoff, expiry and wipe and rolls back callback writes', { timeout: 60000 }, async (t) => {
  let phase = 'setup', passed = false;
  t.after(() => writeFileSync('ci-recovery-gate-proof.json', JSON.stringify({ version: 1,
    scope: 'disposable inactive lease and wipe fencing', phase, outcome: passed ? 'pass' : 'fail' })));
  const fixture = await startClientFixture(process.env.MONGODB_URI, process.env.MONGODB_DB_NAME);
  t.after(fixture.close);
  const { getDb } = await import('../src/db/mongo.js');
  const { acquireRecoveryLease, releaseRecoveryLease, withRecoveryFence, withRecoveryWipe } = await import('../src/lib/recoveryGate.js');
  const db = await getDb(); assertFixtureCleanup(db.databaseName, fixture.database);
  const gates = db.collection<RecoveryGate>('note_sync_state');
  const markers = db.collection<{ _id: string; userId: string }>('recovery_test_markers');
  const lock = db.collection<{ _id: string; owner: string; expiresAt: Date }>('operation_locks');
  let now = new Date(), clock = () => new Date(now);
  phase = 'lease_atomicity';
  const first = await acquireRecoveryLease(db, fixture.owner, clock);
  const gateOne = await gates.findOne({ _id: fixture.owner });
  assert.equal(gateOne!.leaseToken, first.token); assert.equal(gateOne!.wipeEpoch, 0);
  assert.equal((await lock.findOne({ _id: `notes:${fixture.owner}` }))!.owner, first.token);
  await assert.rejects(acquireRecoveryLease(db, fixture.owner, clock), /operation_in_progress/);
  assert.deepEqual(await gates.findOne({ _id: fixture.owner }), gateOne);
  phase = 'callback_rollback';
  await assert.rejects(withRecoveryFence(db, first, async (session) => {
    await markers.insertOne({ _id: 'synthetic-rolled-back', userId: fixture.owner }, { session });
    throw new Error('synthetic_callback_failure');
  }, clock), /synthetic_callback_failure/);
  assert.equal(await markers.countDocuments({}), 0);
  assert.deepEqual(await gates.findOne({ _id: fixture.owner }), gateOne);
  phase = 'late_expiry';
  await assert.rejects(withRecoveryFence(db, first, async (session) => {
    await markers.insertOne({ _id: 'synthetic-expired', userId: fixture.owner }, { session });
    now = new Date(first.expiresAt.getTime() + 1);
  }, clock), /recovery_fence_lost/);
  assert.equal(await markers.countDocuments({}), 0);
  assert.deepEqual(await gates.findOne({ _id: fixture.owner }), gateOne);
  phase = 'lease_handoff';
  const second = await acquireRecoveryLease(db, fixture.owner, clock);
  let called = false;
  await assert.rejects(withRecoveryFence(db, first, async () => { called = true; }, clock), /recovery_fence_lost/);
  assert.equal(called, false);
  const gateTwo = await gates.findOne({ _id: fixture.owner });
  assert.notEqual(second.token, first.token); assert.equal(gateTwo!.leaseToken, second.token);
  assert.equal(await releaseRecoveryLease(db, first, clock), false);
  assert.deepEqual(await gates.findOne({ _id: fixture.owner }), gateTwo);
  assert.equal((await lock.findOne({ _id: `notes:${fixture.owner}` }))!.owner, second.token);
  phase = 'owner_isolation';
  await assert.rejects(withRecoveryFence(db, { ...second, userId: fixture.other }, async () => { called = true; }, clock), /recovery_fence_lost/);
  assert.equal(called, false); assert.equal(await gates.findOne({ _id: fixture.other }), null);
  await withRecoveryFence(db, second, async (session) => {
    await markers.insertOne({ _id: 'synthetic-before-wipe', userId: fixture.owner }, { session });
  }, clock);
  phase = 'wipe_rollback';
  const beforeWipe = await gates.findOne({ _id: fixture.owner });
  await assert.rejects(withRecoveryWipe(db, second, async (session) => {
    await markers.deleteMany({ userId: fixture.owner }, { session });
    throw new Error('synthetic_wipe_failure');
  }, clock), /synthetic_wipe_failure/);
  assert.equal(await markers.countDocuments({}), 1);
  assert.deepEqual(await gates.findOne({ _id: fixture.owner }), beforeWipe);
  phase = 'wipe_epoch';
  const afterWipe = await withRecoveryWipe(db, second, async (session) => {
    await markers.deleteMany({ userId: fixture.owner }, { session });
  }, clock);
  assert.equal(afterWipe.wipeEpoch, 1); assert.equal(await markers.countDocuments({}), 0);
  await assert.rejects(withRecoveryFence(db, second, async () => { called = true; }, clock), /recovery_fence_lost/);
  assert.equal(called, false);
  await withRecoveryFence(db, afterWipe, async (session) => {
    await markers.insertOne({ _id: 'synthetic-after-wipe', userId: fixture.owner }, { session });
  }, clock);
  phase = 'ttl_lock_absence';
  // Simulate TTL removal only inside this generated database. The gate persists.
  await lock.deleteOne({ _id: `notes:${fixture.owner}`, owner: second.token });
  assert.equal(await releaseRecoveryLease(db, afterWipe, clock), true);
  const released = await gates.findOne({ _id: fixture.owner });
  assert.equal(released!.leaseToken, null); assert.equal(released!.leaseExpiresAt, null); assert.equal(released!.wipeEpoch, 1);
  const third = await acquireRecoveryLease(db, fixture.owner, clock);
  assert.equal(third.wipeEpoch, 1); assert.equal(await releaseRecoveryLease(db, third, clock), true);
  phase = 'overflow_rollback';
  // Inject only synthetic invalid/exhausted state; a refused acquisition must
  // roll its lock insertion back along with the gate mutation.
  await gates.updateOne({ _id: fixture.owner }, { $set: { gateRevision: Number.MAX_SAFE_INTEGER } });
  await assert.rejects(acquireRecoveryLease(db, fixture.owner, clock), /recovery_revision_exhausted/);
  assert.equal(await lock.findOne({ _id: `notes:${fixture.owner}` }), null);
  assert.equal((await gates.findOne({ _id: fixture.owner }))!.gateRevision, Number.MAX_SAFE_INTEGER);
  phase = 'complete'; passed = true;
});
