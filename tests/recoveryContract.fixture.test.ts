import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { noteWriteIntentSchema, recoveryGateSchema, recoveryIndexSpecs,
  type NoteWriteIntent, type RecoveryGate } from '../src/db/recoveryContract.js';
import { startClientFixture } from './clientFixture.js';
import { assertFixtureCleanup } from './clientFixtureSafety.js';

test('candidate intent indexes enforce staged identity without TTL in a generated database', { timeout: 60000 }, async (t) => {
  let phase = 'setup', passed = false;
  t.after(() => writeFileSync('ci-recovery-contract-proof.json', JSON.stringify({ version: 1,
    scope: 'disposable inactive recovery contract indexes', phase, outcome: passed ? 'pass' : 'fail' })));
  const fixture = await startClientFixture(process.env.MONGODB_URI, process.env.MONGODB_DB_NAME);
  t.after(fixture.close);
  const { getDb } = await import('../src/db/mongo.js');
  const db = await getDb();
  assertFixtureCleanup(db.databaseName, fixture.database);
  const intents = db.collection<NoteWriteIntent>('note_write_intents');
  phase = 'index_catalog';
  for (const spec of recoveryIndexSpecs) {
    await db.collection(spec.collection).createIndex({ ...spec.key }, { name: spec.name,
      ...('unique' in spec ? { unique: spec.unique } : {}),
      ...('partialFilterExpression' in spec ? { partialFilterExpression: spec.partialFilterExpression } : {}) });
  }
  const indexes = await intents.listIndexes().toArray();
  assert.equal(indexes.length, 4);
  for (const spec of recoveryIndexSpecs) {
    const actual = indexes.find((entry) => entry.name === spec.name)!;
    assert.deepEqual(actual.key, spec.key);
    assert.equal(actual.expireAfterSeconds, undefined);
    if ('unique' in spec) assert.equal(actual.unique, true);
    if ('partialFilterExpression' in spec) assert.deepEqual(actual.partialFilterExpression, spec.partialFilterExpression);
  }
  const make = (userId = fixture.owner, stagedFileId: string | null = 'synthetic-generated-file') => {
    const requestId = randomUUID(), noteId = randomUUID(), now = new Date();
    return noteWriteIntentSchema.parse({ _id: `${userId}:${requestId}:${noteId}`, format: 1, userId, requestId, noteId,
      operationId: `${userId}:${requestId}`, fingerprint: 'a'.repeat(64), expectedVersion: stagedFileId ? 0 : 1,
      expectedFileId: stagedFileId ? null : `synthetic-old-${noteId}`, expectedHash: stagedFileId ? null : 'c'.repeat(64),
      stagedFileId, targetHash: 'b'.repeat(64), targetFlags: { kind: 'text', encV: 0, pinned: false, deleted: false },
      wipeEpoch: 0, leaseToken: randomUUID(), state: stagedFileId ? 'prepared' : 'verified',
      createdAt: now, updatedAt: now, committedVersion: null, committedSequence: null, terminalReason: null });
  };
  phase = 'unique_staged_identity';
  const first = make(); await intents.insertOne(first);
  const duplicate = (error: unknown) => (error as { code?: number }).code === 11000;
  await assert.rejects(intents.insertOne(make()), duplicate);
  await assert.rejects(intents.insertOne({ ...first, stagedFileId: 'synthetic-different-file' }), duplicate);
  assert.equal(await intents.countDocuments({ userId: fixture.owner }), 1);
  phase = 'nullable_reuse_scope';
  await intents.insertMany([make(fixture.owner, null), make(fixture.owner, null)]);
  assert.equal(await intents.countDocuments({ userId: fixture.owner }), 3);
  await intents.insertOne(make(fixture.other));
  assert.equal(await intents.countDocuments({ userId: fixture.other }), 1);
  phase = 'persistent_gate';
  const now = new Date();
  const gate = recoveryGateSchema.parse({ _id: fixture.owner, format: 1, wipeEpoch: 0, gateRevision: 0,
    leaseToken: null, leaseExpiresAt: null, updatedAt: now });
  const gates = db.collection<RecoveryGate>('note_sync_state');
  await gates.insertOne(gate); await assert.rejects(gates.insertOne(gate), duplicate);
  const gateIndexes = await gates.listIndexes().toArray();
  assert.equal(gateIndexes.length, 1); assert.equal(gateIndexes[0].name, '_id_');
  assert.equal(gateIndexes[0].expireAfterSeconds, undefined);
  assert.throws(() => assertFixtureCleanup(db.databaseName, `${fixture.database}_other`), /fixture_cleanup_identity_mismatch/);
  phase = 'complete'; passed = true;
});
