import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import type { drive_v3 } from 'googleapis';
import { migrateAtomicFile, type AtomicFileV1 } from '../src/types/atomicFile.js';
import type { NoteWriteIntent } from '../src/db/recoveryContract.js';
import { remoteNoteRowSchema } from '../src/types/noteWire.js';
import { noteContentHash } from '../src/lib/contentHash.js';
import { startClientFixture } from './clientFixture.js';
import { assertFixtureCleanup } from './clientFixtureSafety.js';

test('inactive fresh wire caller binds timestamps, persists before create, and retries without allocating or charging again',
  { timeout: 60000 }, async t => {
    let phase = 'setup', passed = false, allocations = 0, creates = 0, writes = 0, interrupt = true;
    t.after(() => writeFileSync('ci-recovery-wire-adapter-proof.json', JSON.stringify({ version: 1,
      scope: 'disposable inactive fresh wire admission and replay adapter', phase, outcome: passed ? 'pass' : 'fail' })));
    const fixture = await startClientFixture(process.env.MONGODB_URI, process.env.MONGODB_DB_NAME);
    let cleanupLease: (() => Promise<unknown>) | undefined;
    t.after(async () => { try { await cleanupLease?.(); } finally { await fixture.close(); } });
    const { getDb } = await import('../src/db/mongo.js');
    const { collections } = await import('../src/db/collections.js');
    const { syncOperations } = await import('../src/lib/syncOperation.js');
    const { acquireRecoveryLease, releaseRecoveryLease } = await import('../src/lib/recoveryGate.js');
    const { runFreshRecoveryPush } = await import('../src/lib/recoveryWireAdapter.js');
    const db = await getDb(); assertFixtureCleanup(db.databaseName, fixture.database);
    let lease = await acquireRecoveryLease(db, fixture.owner); cleanupLease = () => releaseRecoveryLease(db, lease);
    const journal = db.collection<NoteWriteIntent>('note_write_intents'), files = new Map<string, AtomicFileV1>();
    const rows = [remoteNoteRowSchema.parse({ id: randomUUID(), kind: 'todo', title: 'Public caller checklist', body: '',
      items: [{ text: 'Public caller item', done: false }], pinned: false, deleted: false, enc_v: 0, payload: null,
      created_at: '2026-09-12T12:00:00+05:30', updated_at: '2026-09-13T12:00:00+05:30', base_version: 0 }),
    remoteNoteRowSchema.parse({ id: randomUUID(), kind: 'text', title: '', body: '', items: [], pinned: true,
      deleted: false, enc_v: 1, payload: 'public-opaque-caller-envelope', created_at: '2026-09-12T13:00:00+05:30', base_version: 0 })];
    const envelope = { requestId: randomUUID(), mode: 'instant', rows }, operationId = `${fixture.owner}:${envelope.requestId}`;
    let allocationHook: (() => Promise<void>) | undefined;
    const sdk = { files: {
      async generateIds(params: { count: number; space: string; type: string }) {
        allocations++; assert.equal(params.space, 'drive'); assert.equal(params.type, 'files');
        await allocationHook?.();
        return { data: { ids: Array.from({ length: params.count }, () => `synthetic-caller-${randomUUID()}`) } };
      },
      async create(params: { requestBody: { id: string }; media: { body: AsyncIterable<unknown> } }) {
        creates++;
        const intent = await journal.findOne({ stagedFileId: params.requestBody.id });
        assert.ok(intent); assert.equal(intent.expectedVersion, 0);
        const op = await syncOperations(db).findOne({ _id: intent.operationId });
        assert.ok(op); assert.equal(op.status, 'pending'); assert.equal(op.charged, 10);
        if (creates === 1) assert.equal((await collections.atomicUsers(db).findOne({ _id: fixture.owner }))!.energy, 90);
        if (files.has(params.requestBody.id)) throw { code: 409 };
        let raw = ''; for await (const part of params.media.body) raw += String(part);
        const file = migrateAtomicFile(JSON.parse(raw)); files.set(params.requestBody.id, file); writes++;
        assert.equal(file.updatedAt, intent.createdAt.toISOString());
        assert.equal(file.createdAt, new Date(rows.find(row => row.id === intent.noteId)!.created_at).toISOString());
        if (interrupt) { interrupt = false; throw new Error('synthetic_external_create_reply_lost'); }
        return { data: { id: params.requestBody.id } };
      },
      async get(params: { fileId: string; alt?: string }) {
        if (!files.has(params.fileId)) throw { code: 404 };
        return { data: params.alt === 'media' ? structuredClone(files.get(params.fileId)) : {
          id: params.fileId, parents: ['synthetic-parent'], mimeType: 'application/json', trashed: false } };
      },
      async update() { throw new Error('must_not_overwrite'); }, async delete() { throw new Error('must_not_delete'); },
    } } as unknown as drive_v3.Drive;
    const call = (input: unknown = envelope, owner = fixture.owner, selected = sdk, parent = 'synthetic-parent') =>
      runFreshRecoveryPush(db, owner, lease, input, selected, parent);
    const snapshot = async () => ({
      notes: await collections.notes(db).find({ userId: fixture.owner }).sort({ _id: 1 }).toArray(),
      intents: await journal.find({ userId: fixture.owner }).sort({ _id: 1 }).toArray(),
      operations: await syncOperations(db).find({ userId: fixture.owner }).sort({ _id: 1 }).toArray(),
      wallet: await collections.atomicUsers(db).findOne({ _id: fixture.owner }),
      ledger: await collections.energyLedger(db).find({ userId: fixture.owner }).sort({ _id: 1 }).toArray(),
      counter: await db.collection('sync_counters').findOne({ _id: fixture.owner }),
    });
    phase = 'unsupported_owner_envelopes_and_capacity_before_allocation';
    const baseline = await snapshot();
    await assert.rejects(call(envelope, fixture.other), /recovery_owner_mismatch/);
    for (const unsupported of [ { ...envelope, logoutAttemptId: randomUUID() },
      { ...envelope, rows: [{ ...rows[0], deleted: true }] }, { ...envelope, rows: [{ ...rows[0], base_version: 1 }] } ]) {
      await assert.rejects(call(unsupported), /recovery_fresh_only/);
    }
    await assert.rejects(call({ ...envelope, rows: [rows[0], rows[0]] }), /duplicate_note_ids/);
    await assert.rejects(call({ ...envelope, rows: Array.from({ length: 51 }, () => rows[0]) }));
    await assert.rejects(call({ ...envelope, rows: [{ ...rows[0], body: 'x'.repeat(250001) }] }));
    await assert.rejects(call({ ...envelope, ignored: 'x'.repeat(4 * 1024 * 1024) }), /request_too_large/);
    assert.deepEqual(await snapshot(), baseline); assert.equal(allocations, 0);
    await collections.atomicUsers(db).updateOne({ _id: fixture.owner }, { $set: { noteLimit: 1 } });
    await assert.rejects(call(), /note_limit_reached/); assert.equal(allocations, 0);
    await collections.atomicUsers(db).updateOne({ _id: fixture.owner }, { $set: { noteLimit: 30 } });
    // Global note IDs must be absent, including another owner's metadata.
    await collections.notes(db).insertOne({ _id: rows[0].id, userId: fixture.other, folderId: null,
      kind: 'todo', pinned: false, deleted: false, encV: 0, driveFileId: 'synthetic-other-file', driveRevisionId: null,
      localVersion: 1, syncStatus: 'synced', createdAt: new Date(), updatedAt: new Date(), lastSyncedAt: new Date() });
    await assert.rejects(call(), /note_id_conflict/); assert.equal(allocations, 0);
    await collections.notes(db).deleteOne({ _id: rows[0].id, userId: fixture.other });
    phase = 'capacity_change_during_id_allocation_rolls_back_admission';
    allocationHook = async () => { await collections.atomicUsers(db).updateOne({ _id: fixture.owner }, { $set: { noteLimit: 1 } }); };
    await assert.rejects(call(), /note_limit_reached/);
    assert.equal(allocations, 1); assert.equal(creates, 0); assert.equal(await journal.countDocuments({ userId: fixture.owner }), 0);
    assert.equal(await syncOperations(db).countDocuments({ userId: fixture.owner }), 0);
    assert.equal((await snapshot()).wallet!.energy, baseline.wallet!.energy);
    assert.deepEqual((await snapshot()).ledger, baseline.ledger);
    allocationHook = undefined;
    await collections.atomicUsers(db).updateOne({ _id: fixture.owner }, { $set: { noteLimit: 30 } });
    phase = 'durable_admission_before_interrupted_external_create';
    await assert.rejects(call(), /synthetic_external_create_reply_lost/);
    const paid = await snapshot(); assert.equal(allocations, 2); assert.equal(creates, 1); assert.equal(writes, 1);
    assert.equal(paid.wallet!.energy, 90); assert.equal(paid.ledger.length, baseline.ledger.length + 1);
    assert.equal(paid.notes.length, 0); assert.equal(paid.intents.length, 2); assert.equal(paid.operations[0].status, 'pending');
    const savedIds = rows.map(row => paid.intents.find(intent => intent.noteId === row.id)!.stagedFileId!);
    const persistedTimes = rows.map(row => paid.intents.find(intent => intent.noteId === row.id)!.createdAt);
    phase = 'timestamp_only_pending_mismatch_before_allocation';
    for (const field of ['created_at', 'updated_at'] as const) {
      const changed = { ...rows[0], [field]: '2026-09-14T12:00:00+05:30' };
      assert.equal(noteContentHash(changed), noteContentHash(rows[0]));
      await assert.rejects(call({ ...envelope, rows: [changed, rows[1]] }), /sync_request_mismatch/);
    }
    assert.deepEqual(await snapshot(), paid); assert.equal(allocations, 2); assert.equal(creates, 1);
    phase = 'fresh_lease_same_envelope_stable_ids_and_timestamps';
    const oldLease = lease; await releaseRecoveryLease(db, lease); lease = await acquireRecoveryLease(db, fixture.owner);
    await assert.rejects(runFreshRecoveryPush(db, fixture.owner, oldLease, envelope, sdk, 'synthetic-parent'), /recovery_fence_lost/);
    // Pending recovery must precede today's wallet/capacity checks.
    await collections.atomicUsers(db).updateOne({ _id: fixture.owner }, { $set: { noteLimit: 0, energy: 0 } });
    const completed = await call(); assert.equal(completed.status, 'complete');
    if (completed.status !== 'complete') throw new Error('synthetic_expected_complete');
    assert.equal(completed.operation._id, operationId); assert.equal(completed.operation.charged, 10); assert.equal(completed.operation.refunded, 0);
    assert.deepEqual(completed.operation.results.map(result => result.id), rows.map(row => row.id));
    assert.equal(completed.operation.results.every(result => result.ok), true);
    const final = await snapshot(); assert.equal(final.notes.length, 2); assert.equal(final.counter!.value, 2);
    assert.deepEqual(final.ledger, paid.ledger); assert.equal(final.wallet!.energy, 0);
    assert.equal(allocations, 2); assert.equal(creates, 3); assert.equal(writes, 2); assert.equal(files.size, 2);
    for (let i = 0; i < rows.length; i++) {
      assert.equal(final.notes.find(note => note._id === rows[i].id)!.driveFileId, savedIds[i]);
      assert.equal(final.intents.find(intent => intent.noteId === rows[i].id)!.createdAt.getTime(), persistedTimes[i].getTime());
      assert.equal(files.get(savedIds[i])!.updatedAt, persistedTimes[i].toISOString());
      assert.equal(files.get(savedIds[i])!.payload, rows[i].payload);
    }
    assert.equal(JSON.stringify(final.intents).includes(rows[1].payload!), false);
    assert.equal(JSON.stringify(final.intents).includes(rows[0].title), false);
    phase = 'terminal_replay_without_drive_wallet_or_capacity';
    await collections.atomicUsers(db).updateOne({ _id: fixture.owner }, { $set: { energy: 0, lastDailyGrantAt: new Date(0) } });
    const terminal = await snapshot();
    const forbidden = { files: { async generateIds() { throw new Error('unexpected_terminal_allocation'); },
      async create() { throw new Error('unexpected_terminal_create'); }, async get() { throw new Error('unexpected_terminal_read'); } } } as unknown as drive_v3.Drive;
    assert.deepEqual(await call(envelope, fixture.owner, forbidden, ''), completed);
    await assert.rejects(call({ ...envelope, rows: [{ ...rows[0], created_at: '2026-09-15T12:00:00+05:30' }, rows[1]] },
      fixture.owner, forbidden, ''), /sync_request_mismatch/);
    assert.deepEqual(await snapshot(), terminal); assert.equal(allocations, 2); assert.equal(creates, 3);
    phase = 'complete'; passed = true;
  });
