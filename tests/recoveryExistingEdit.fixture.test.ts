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

test('existing-note coordinator preserves the old generation through Mongo failure and resumes under a fresh lease',
  { timeout: 60000 }, async t => {
    let phase = 'setup', passed = false, writes = 0, creates = 0;
    t.after(() => writeFileSync('ci-recovery-existing-edit-proof.json', JSON.stringify({ version: 1,
      scope: 'disposable inactive existing-note coordinator rollback and lease handoff',
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
    const old = migrateAtomicFile({ version: 1, id: randomUUID(), kind: 'text',
      title: 'Public synthetic existing note', body: 'Public synthetic last committed body', items: [],
      pinned: false, encV: 0, payload: null, createdAt: now.toISOString(), updatedAt: now.toISOString() });
    const next = { ...old, body: 'Public synthetic replacement body', pinned: true };
    const make = async (file: AtomicFileV1) => {
      const requestId = randomUUID(), preimage = await collections.notes(db).findOne({ _id: file.id });
      const rows = [remoteNoteRowSchema.parse({ id: file.id, kind: file.kind, title: file.title, body: file.body,
        items: file.items, pinned: file.pinned, deleted: false, enc_v: file.encV, payload: file.payload,
        base_version: preimage?.localVersion ?? 0, created_at: file.createdAt })];
      const intents = [noteWriteIntentSchema.parse({ _id: `${fixture.owner}:${requestId}:${file.id}`,
        format: 1, userId: fixture.owner, noteId: file.id, requestId, operationId: `${fixture.owner}:${requestId}`,
        fingerprint: fingerprintOf(rows, 'instant'), expectedVersion: rows[0].base_version,
        expectedFileId: preimage?.driveFileId ?? null, expectedHash: preimage?.contentHash ?? null,
        stagedFileId: `synthetic-existing-edit-${randomUUID()}`, targetHash: noteContentHash(rows[0]),
        targetFlags: { kind: file.kind, encV: file.encV, pinned: file.pinned, deleted: false }, wipeEpoch: lease.wipeEpoch,
        leaseToken: lease.token, state: 'prepared', createdAt: now, updatedAt: now,
        committedVersion: null, committedSequence: null, terminalReason: null })];
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
    const checkPull = async (file: AtomicFileV1, version: number) => {
      const response = await fetch(`${fixture.origin}/api/notes/pull?after=0`, { headers: auth });
      assert.equal(response.status, 200);
      const page = await response.json() as { rows: { id: string; body: string; pinned: boolean; version: number }[]; nextCursor: number };
      assert.equal(page.rows.length, 1); assert.equal(page.rows[0].id, file.id);
      assert.equal(page.rows[0].body, file.body); assert.equal(page.rows[0].pinned, file.pinned);
      assert.equal(page.rows[0].version, version); assert.equal(page.nextCursor, version);
    };
    const validationError = (error: unknown) =>
      (typeof error === 'object' && error !== null && 'code' in error && error.code === 121) ||
      (error instanceof MongoBulkWriteError && error.result.getWriteErrors().some(entry => entry.code === 121));
    phase = 'initial_committed_note';
    const baselineLedger = await collections.energyLedger(db).countDocuments({ userId: fixture.owner });
    const initial = await make(old);
    const seeded = await resumeRecoveryOperation(db, lease, initial.operationId, sdk, 'synthetic-parent', [old]);
    assert.equal(seeded.status, 'complete'); assert.equal(writes, 1); assert.equal(creates, 1);
    const initialState = await snapshot();
    assert.equal(initialState.notes[0].localVersion, 1); assert.equal(initialState.counter!.value, 1);
    assert.equal(initialState.notes[0].driveFileId, initial.intents[0].stagedFileId);
    assert.equal(initialState.wallet!.energy, 90); await checkPull(old, 1);
    phase = 'edit_admission_and_metadata_fault';
    const edit = await make(next), paidBeforeCreate = await snapshot();
    assert.equal(edit.intents[0].expectedVersion, 1);
    assert.equal(edit.intents[0].expectedFileId, initial.intents[0].stagedFileId);
    assert.equal(edit.intents[0].expectedHash, initialState.notes[0].contentHash);
    assert.equal(paidBeforeCreate.wallet!.energy, 80);
    // Generated fixture only: reject the attempted update after immutable create.
    assertFixtureCleanup(db.databaseName, fixture.database);
    await db.command({ collMod: 'notes', validator: { localVersion: { $lte: 1 } },
      validationLevel: 'strict', validationAction: 'error' });
    await assert.rejects(resumeRecoveryOperation(db, lease, edit.operationId, sdk, 'synthetic-parent', [next]), validationError);
    phase = 'old_cloud_version_survives_failed_commit';
    const failed = await snapshot();
    assert.deepEqual(failed.notes, initialState.notes); assert.deepEqual(failed.counter, initialState.counter);
    assert.deepEqual(failed.wallet, paidBeforeCreate.wallet); assert.deepEqual(failed.ledger, paidBeforeCreate.ledger);
    assert.deepEqual(failed.operations, paidBeforeCreate.operations);
    const verified = await journal.findOne({ _id: edit.intents[0]._id });
    assert.equal(verified!.state, 'verified'); assert.equal(verified!.stagedFileId, edit.intents[0].stagedFileId);
    assert.equal(verified!.committedVersion, null); assert.equal(verified!.committedSequence, null);
    assert.deepEqual(files.get(initial.intents[0].stagedFileId!), old);
    assert.deepEqual(files.get(edit.intents[0].stagedFileId!), next);
    assert.equal(files.size, 2); assert.equal(writes, 2); assert.equal(creates, 2);
    await checkPull(old, 1);
    phase = 'fresh_lease_and_stale_coordinator_refusal';
    const oldLease = lease;
    await releaseRecoveryLease(db, lease); lease = await acquireRecoveryLease(db, fixture.owner);
    assert.notEqual(lease.token, oldLease.token); assert.equal(lease.wipeEpoch, oldLease.wipeEpoch);
    const handoff = await snapshot();
    await assert.rejects(resumeRecoveryOperation(db, oldLease, edit.operationId, sdk, 'synthetic-parent'), /recovery_fence_lost/);
    assert.deepEqual(await snapshot(), handoff);
    // Restart the coordinator from stored verified intents without client content.
    phase = 'fresh_coordinator_fault_preserves_preimage';
    await assert.rejects(resumeRecoveryOperation(db, lease, edit.operationId, sdk, 'synthetic-parent'), validationError);
    const retried = await snapshot();
    assert.deepEqual(retried.notes, initialState.notes); assert.deepEqual(retried.counter, initialState.counter);
    assert.deepEqual(retried.wallet, paidBeforeCreate.wallet); assert.deepEqual(retried.ledger, paidBeforeCreate.ledger);
    assert.deepEqual(retried.operations, paidBeforeCreate.operations);
    const adopted = await journal.findOne({ _id: edit.intents[0]._id });
    assert.equal(adopted!.state, 'verified'); assert.equal(adopted!.leaseToken, lease.token);
    assert.equal(adopted!.stagedFileId, edit.intents[0].stagedFileId);
    assert.equal(writes, 2); assert.equal(creates, 2); await checkPull(old, 1);
    phase = 'same_saved_generation_commits_once';
    assertFixtureCleanup(db.databaseName, fixture.database);
    await db.command({ collMod: 'notes', validator: {}, validationLevel: 'strict', validationAction: 'error' });
    const completed = await resumeRecoveryOperation(db, lease, edit.operationId, sdk, 'synthetic-parent');
    assert.equal(completed.status, 'complete');
    if (completed.status !== 'complete') throw new Error('synthetic_expected_receipt');
    assert.equal(completed.operation.charged, 10); assert.equal(completed.operation.refunded, 0);
    assert.equal(completed.operation.results.length, 1); assert.equal(completed.operation.results[0].version, 2);
    assert.equal(completed.operation.results[0].seq, 2); assert.equal(completed.operation.results[0].ok, true);
    const committed = await snapshot();
    assert.equal(committed.notes.length, 1); assert.equal(committed.notes[0].localVersion, 2);
    assert.equal(committed.notes[0].driveFileId, edit.intents[0].stagedFileId); assert.equal(committed.counter!.value, 2);
    assert.equal(committed.wallet!.energy, 80); assert.equal(committed.ledger.length, baselineLedger + 2);
    assert.deepEqual(committed.wallet, paidBeforeCreate.wallet); assert.deepEqual(committed.ledger, paidBeforeCreate.ledger);
    assert.equal((await journal.findOne({ _id: edit.intents[0]._id }))!.state, 'committed');
    assert.equal(writes, 2); assert.equal(creates, 2); assert.equal(files.size, 2);
    assert.deepEqual(files.get(initial.intents[0].stagedFileId!), old);
    assert.equal(JSON.stringify(committed.intents).includes(old.body), false);
    assert.equal(JSON.stringify(committed.intents).includes(next.body), false);
    await checkPull(next, 2);
    phase = 'terminal_coordinator_and_http_receipt_replay';
    assert.deepEqual(await resumeRecoveryOperation(db, lease, edit.operationId, sdk, 'synthetic-parent'), completed);
    assert.deepEqual(await snapshot(), committed);
    await releaseRecoveryLease(db, lease); cleanupLease = undefined;
    const replay = await fetch(`${fixture.origin}/api/notes/push`, { method: 'POST', headers: auth,
      body: JSON.stringify({ requestId: edit.requestId, mode: 'instant', rows: edit.rows }) });
    assert.equal(replay.status, 200);
    const receipt = await replay.json() as { results: unknown[]; charged: number; refunded: number };
    assert.deepEqual(receipt.results, completed.operation.results); assert.equal(receipt.charged, 10); assert.equal(receipt.refunded, 0);
    assert.deepEqual(await snapshot(), committed); assert.equal(writes, 2); assert.equal(creates, 2);
    await checkPull(next, 2);
    phase = 'complete'; passed = true;
  });
