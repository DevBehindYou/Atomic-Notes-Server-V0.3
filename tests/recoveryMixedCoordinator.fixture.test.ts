import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { MongoBulkWriteError } from 'mongodb';
import type { drive_v3 } from 'googleapis';
import type { DriveAdapter } from '../src/routes/notes.js';
import { noteWriteIntentSchema, type NoteWriteIntent } from '../src/db/recoveryContract.js';
import { noteContentHash } from '../src/lib/contentHash.js';
import { migrateAtomicFile, type AtomicFileV1 } from '../src/types/atomicFile.js';
import { remoteNoteRowSchema } from '../src/types/noteWire.js';
import { startClientFixture, FIXTURE_TOKENS } from './clientFixture.js';
import { assertFixtureCleanup } from './clientFixtureSafety.js';

test('mixed coordinator create, opaque encrypted edit and plaintext tombstone roll back and resume together',
  { timeout: 60000 }, async t => {
    let phase = 'setup', passed = false, writes = 0, creates = 0;
    t.after(() => writeFileSync('ci-recovery-mixed-coordinator-proof.json', JSON.stringify({ version: 1,
      scope: 'disposable inactive mixed create encrypted edit and tombstone coordinator',
      phase, outcome: passed ? 'pass' : 'fail' })));
    const files = new Map<string, AtomicFileV1>();
    const notesDrive: DriveAdapter = {
      async createNoteFile() { throw new Error('unexpected_mutable_create'); },
      async updateNoteFile() { throw new Error('unexpected_mutable_update'); },
      async deleteNoteFile() { throw new Error('unexpected_mutable_delete'); },
      async getNoteFileContent(_a, _r, id) {
        if (!files.has(id)) throw { code: 404 };
        return structuredClone(files.get(id)!) as unknown as Record<string, unknown>;
      },
      async ensureAppFolders() { return { notesId: 'synthetic-parent' }; },
    };
    const fixture = await startClientFixture(process.env.MONGODB_URI, process.env.MONGODB_DB_NAME, notesDrive);
    let cleanupLease: (() => Promise<unknown>) | undefined;
    t.after(async () => { try { await cleanupLease?.(); } finally { await fixture.close(); } });
    const { getDb } = await import('../src/db/mongo.js');
    const { collections } = await import('../src/db/collections.js');
    const { acquireRecoveryLease, releaseRecoveryLease } = await import('../src/lib/recoveryGate.js');
    const { fingerprintOf, syncOperations } = await import('../src/lib/syncOperation.js');
    const { beginRecoverySync } = await import('../src/lib/recoveryAdmission.js');
    const { resumeRecoveryOperation } = await import('../src/lib/recoveryResume.js');
    const db = await getDb(); assertFixtureCleanup(db.databaseName, fixture.database);
    let lease = await acquireRecoveryLease(db, fixture.owner);
    cleanupLease = () => releaseRecoveryLease(db, lease);
    await collections.googleAccounts(db).updateOne({ userId: fixture.owner }, { $set: { driveRootFolderId: 'synthetic-parent' } });
    const journal = db.collection<NoteWriteIntent>('note_write_intents');
    const counters = db.collection<{ _id: string; value: number }>('sync_counters');
    const sdk = { files: {
      async create(params: { requestBody: { id: string }; media: { body: AsyncIterable<unknown> } }) {
        creates++;
        if (files.has(params.requestBody.id)) throw { code: 409 };
        let raw = ''; for await (const part of params.media.body) raw += String(part);
        files.set(params.requestBody.id, migrateAtomicFile(JSON.parse(raw))); writes++;
        return { data: { id: params.requestBody.id } };
      },
      async get(params: { fileId: string; alt?: string }) {
        if (!files.has(params.fileId)) throw { code: 404 };
        return { data: params.alt === 'media' ? structuredClone(files.get(params.fileId)) : {
          id: params.fileId, parents: ['synthetic-parent'], mimeType: 'application/json', trashed: false } };
      },
      async update() { throw new Error('must_not_overwrite'); }, async delete() { throw new Error('must_not_delete'); },
    } } as unknown as drive_v3.Drive;
    const now = new Date();
    const plain = migrateAtomicFile({ version: 1, id: randomUUID(), kind: 'text', title: 'Public mixed original',
      body: 'Public mixed last committed body', items: [], pinned: false, encV: 0, payload: null,
      createdAt: now.toISOString(), updatedAt: now.toISOString() });
    const encrypted = migrateAtomicFile({ version: 1, id: randomUUID(), kind: 'text', title: '',
      body: '', items: [], pinned: true, encV: 1, payload: 'public-opaque-mixed-old-envelope',
      createdAt: now.toISOString(), updatedAt: now.toISOString() });
    const todo = migrateAtomicFile({ version: 1, id: randomUUID(), kind: 'todo', title: 'Public mixed new todo',
      body: '', items: [{ text: 'Public mixed checklist item', done: true }], pinned: false, encV: 0, payload: null,
      createdAt: now.toISOString(), updatedAt: now.toISOString() });
    const encryptedEdit = { ...encrypted, pinned: false, payload: 'public-opaque-mixed-new-envelope' };
    const deletionContent = { ...plain, body: 'Public mixed offline edit before deletion', pinned: true };
    type Target = { file: AtomicFileV1; deleted: boolean };
    const make = async (targets: Target[]) => {
      const requestId = randomUUID();
      const preimages = await Promise.all(targets.map(target => collections.notes(db).findOne({ _id: target.file.id })));
      const rows = targets.map(({ file, deleted }, i) => remoteNoteRowSchema.parse({ id: file.id, kind: file.kind,
        title: file.title, body: file.body, items: file.items, pinned: file.pinned, deleted,
        enc_v: file.encV, payload: file.payload, base_version: preimages[i]?.localVersion ?? 0, created_at: file.createdAt }));
      const intents = rows.map((row, i) => noteWriteIntentSchema.parse({ _id: `${fixture.owner}:${requestId}:${row.id}`,
        format: 1, userId: fixture.owner, noteId: row.id, requestId, operationId: `${fixture.owner}:${requestId}`,
        fingerprint: fingerprintOf(rows, 'instant'), expectedVersion: row.base_version,
        expectedFileId: preimages[i]?.driveFileId ?? null, expectedHash: preimages[i]?.contentHash ?? null,
        stagedFileId: `synthetic-mixed-coordinator-${randomUUID()}`, targetHash: noteContentHash(row),
        targetFlags: { kind: row.kind, encV: row.enc_v, pinned: row.pinned, deleted: row.deleted }, wipeEpoch: lease.wipeEpoch,
        leaseToken: lease.token, state: 'prepared', createdAt: now, updatedAt: now,
        committedVersion: null, committedSequence: null, terminalReason: null }));
      await beginRecoverySync(db, lease, requestId, rows, 'instant', intents);
      return { requestId, rows, intents, operationId: intents[0].operationId };
    };
    const snapshot = async () => ({
      notes: await collections.notes(db).find({ userId: fixture.owner }).sort({ _id: 1 }).toArray(),
      counter: await counters.findOne({ _id: fixture.owner }),
      operations: await syncOperations(db).find({ userId: fixture.owner }).sort({ _id: 1 }).toArray(),
      intents: await journal.find({ userId: fixture.owner }).sort({ _id: 1 }).toArray(),
      wallet: await collections.atomicUsers(db).findOne({ _id: fixture.owner }),
      ledger: await collections.energyLedger(db).find({ userId: fixture.owner }).sort({ _id: 1 }).toArray(),
    });
    const auth = { authorization: `Bearer ${FIXTURE_TOKENS.a}`, 'content-type': 'application/json' };
    const checkPull = async (targets: Target[], versions: number[], cursor: number) => {
      const response = await fetch(`${fixture.origin}/api/notes/pull?after=0`, { headers: auth });
      assert.equal(response.status, 200);
      const page = await response.json() as { rows: { id: string; kind: string; title: string; body: string;
        items: unknown[]; pinned: boolean; deleted: boolean; enc_v: number; payload: string | null; version: number }[];
        nextCursor: number; hasMore: boolean };
      assert.equal(page.rows.length, targets.length); assert.equal(page.nextCursor, cursor); assert.equal(page.hasMore, false);
      for (let i = 0; i < targets.length; i++) {
        const row = page.rows[i], { file, deleted } = targets[i];
        assert.equal(row.id, file.id); assert.equal(row.kind, file.kind); assert.equal(row.title, file.title);
        assert.equal(row.body, file.body); assert.deepEqual(row.items, file.items); assert.equal(row.pinned, file.pinned);
        assert.equal(row.deleted, deleted); assert.equal(row.enc_v, file.encV); assert.equal(row.payload, file.payload);
        assert.equal(row.version, versions[i]);
      }
    };
    const lastUpdateValidation = (error: unknown) => {
      phase = 'metadata_validation_code';
      assert.ok(error instanceof MongoBulkWriteError); assert.equal(error.code, 121);
      phase = 'metadata_prior_insert_observed'; assert.equal(error.result.insertedCount, 1);
      phase = 'metadata_prior_update_observed'; assert.equal(error.result.matchedCount, 1); assert.equal(error.result.modifiedCount, 1);
      phase = 'metadata_last_update_index';
      const errors = error.result.getWriteErrors(); assert.equal(errors.length, 1); assert.equal(errors[0].index, 2);
      return true;
    };
    phase = 'seed_plain_and_opaque_encrypted_notes';
    const initialTargets = [{ file: plain, deleted: false }, { file: encrypted, deleted: false }];
    const baselineLedger = await collections.energyLedger(db).countDocuments({ userId: fixture.owner });
    const initial = await make(initialTargets);
    const seeded = await resumeRecoveryOperation(db, lease, initial.operationId, sdk, 'synthetic-parent', [plain, encrypted]);
    assert.equal(seeded.status, 'complete');
    const oldState = await snapshot(); assert.equal(oldState.counter!.value, 2); assert.equal(oldState.wallet!.energy, 90);
    assert.equal(writes, 2); assert.equal(creates, 2); await checkPull(initialTargets, [1, 2], 2);
    phase = 'mixed_admission_and_final_update_fault';
    const targets = [{ file: todo, deleted: false }, { file: encryptedEdit, deleted: false }, { file: deletionContent, deleted: true }];
    const mixed = await make(targets), paid = await snapshot();
    assert.deepEqual(mixed.rows.map(row => row.base_version), [0, 2, 1]);
    assert.equal(paid.wallet!.energy, 80);
    // Only generated fixture notes: reject the last update, after new insert and encrypted update.
    assertFixtureCleanup(db.databaseName, fixture.database);
    await db.command({ collMod: 'notes', validator: { _id: { $ne: plain.id } }, validationLevel: 'strict', validationAction: 'error' });
    await assert.rejects(resumeRecoveryOperation(db, lease, mixed.operationId, sdk, 'synthetic-parent',
      targets.map(target => target.file)), lastUpdateValidation);
    phase = 'atomic_rollback_preserves_old_cloud_and_receipt';
    const failed = await snapshot();
    assert.deepEqual(failed.notes, oldState.notes); assert.deepEqual(failed.counter, oldState.counter);
    assert.deepEqual(failed.wallet, paid.wallet); assert.deepEqual(failed.ledger, paid.ledger);
    assert.deepEqual(failed.operations, paid.operations);
    assert.equal(await collections.notes(db).findOne({ _id: todo.id }), null);
    assert.equal(failed.notes.every(note => !note.deleted), true);
    const verified = await journal.find({ operationId: mixed.operationId }).toArray();
    assert.equal(verified.length, 3); assert.equal(verified.every(intent => intent.state === 'verified'), true);
    assert.equal(verified.every(intent => intent.committedVersion === null && intent.committedSequence === null), true);
    const savedIds = mixed.intents.map(intent => intent.stagedFileId!);
    assert.deepEqual(verified.map(intent => intent.stagedFileId).sort(), [...savedIds].sort());
    for (let i = 0; i < initialTargets.length; i++) assert.deepEqual(files.get(initial.intents[i].stagedFileId!), initialTargets[i].file);
    for (let i = 0; i < targets.length; i++) assert.deepEqual(files.get(savedIds[i]), targets[i].file);
    assert.equal(writes, 5); assert.equal(creates, 5); assert.equal(files.size, 5);
    await checkPull(initialTargets, [1, 2], 2);
    phase = 'fresh_lease_stale_coordinator_refusal';
    const oldLease = lease;
    await releaseRecoveryLease(db, lease); lease = await acquireRecoveryLease(db, fixture.owner);
    const handoff = await snapshot();
    await assert.rejects(resumeRecoveryOperation(db, oldLease, mixed.operationId, sdk, 'synthetic-parent'), /recovery_fence_lost/);
    assert.deepEqual(await snapshot(), handoff);
    phase = 'fresh_coordinator_retries_same_fault_without_client_content';
    await assert.rejects(resumeRecoveryOperation(db, lease, mixed.operationId, sdk, 'synthetic-parent'), lastUpdateValidation);
    const adopted = await snapshot();
    assert.deepEqual(adopted.notes, oldState.notes); assert.deepEqual(adopted.counter, oldState.counter);
    assert.deepEqual(adopted.wallet, paid.wallet); assert.deepEqual(adopted.ledger, paid.ledger);
    assert.deepEqual(adopted.operations, paid.operations);
    const resumedIntents = await journal.find({ operationId: mixed.operationId }).toArray();
    assert.equal(resumedIntents.every(intent => intent.state === 'verified' && intent.leaseToken === lease.token), true);
    assert.deepEqual(resumedIntents.map(intent => intent.stagedFileId).sort(), [...savedIds].sort());
    assert.equal(writes, 5); assert.equal(creates, 5); await checkPull(initialTargets, [1, 2], 2);
    phase = 'one_ordered_mixed_commit_and_terminal_receipt';
    assertFixtureCleanup(db.databaseName, fixture.database);
    await db.command({ collMod: 'notes', validator: {}, validationLevel: 'strict', validationAction: 'error' });
    const completed = await resumeRecoveryOperation(db, lease, mixed.operationId, sdk, 'synthetic-parent');
    assert.equal(completed.status, 'complete');
    if (completed.status !== 'complete') throw new Error('synthetic_expected_receipt');
    assert.equal(completed.operation.charged, 10); assert.equal(completed.operation.refunded, 0);
    assert.deepEqual(completed.operation.results.map(result => result.id), targets.map(target => target.file.id));
    assert.deepEqual(completed.operation.results.map(result => result.seq), [3, 4, 5]);
    assert.deepEqual(completed.operation.results.map(result => result.version), [3, 3, 2]);
    assert.equal(completed.operation.results.every(result => result.ok), true);
    const committed = await snapshot();
    assert.equal(committed.notes.length, 3); assert.equal(committed.counter!.value, 5);
    assert.equal(committed.notes.filter(note => note.deleted).length, 1); assert.equal(committed.notes.filter(note => !note.deleted).length, 2);
    assert.deepEqual(committed.wallet, paid.wallet); assert.deepEqual(committed.ledger, paid.ledger);
    assert.equal(committed.ledger.length, baselineLedger + 2); assert.equal(committed.wallet!.energy, 80);
    for (let i = 0; i < targets.length; i++) {
      assert.equal(committed.notes.find(note => note._id === targets[i].file.id)!.driveFileId, savedIds[i]);
      assert.equal((await journal.findOne({ _id: mixed.intents[i]._id }))!.state, 'committed');
    }
    for (let i = 0; i < initialTargets.length; i++) assert.deepEqual(files.get(initial.intents[i].stagedFileId!), initialTargets[i].file);
    for (const forbidden of [plain.body, deletionContent.body, encrypted.payload!, encryptedEdit.payload!]) {
      assert.equal(JSON.stringify(committed.intents).includes(forbidden), false);
    }
    assert.equal(writes, 5); assert.equal(creates, 5); assert.equal(files.size, 5);
    await checkPull(targets, [3, 3, 2], 5);
    phase = 'mixed_terminal_coordinator_and_http_replay';
    assert.deepEqual(await resumeRecoveryOperation(db, lease, mixed.operationId, sdk, 'synthetic-parent'), completed);
    assert.deepEqual(await snapshot(), committed);
    await releaseRecoveryLease(db, lease); cleanupLease = undefined;
    const replay = await fetch(`${fixture.origin}/api/notes/push`, { method: 'POST', headers: auth,
      body: JSON.stringify({ requestId: mixed.requestId, mode: 'instant', rows: mixed.rows }) });
    assert.equal(replay.status, 200);
    const receipt = await replay.json() as { results: unknown[]; charged: number; refunded: number };
    assert.deepEqual(receipt.results, completed.operation.results); assert.equal(receipt.charged, 10); assert.equal(receipt.refunded, 0);
    assert.deepEqual(await snapshot(), committed); assert.equal(writes, 5); assert.equal(creates, 5);
    await checkPull(targets, [3, 3, 2], 5);
    phase = 'complete'; passed = true;
  });
