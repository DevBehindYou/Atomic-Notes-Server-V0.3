import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import type { drive_v3 } from 'googleapis';
import type { DriveAdapter } from '../src/routes/notes.js';
import type { NoteWriteIntent } from '../src/db/recoveryContract.js';
import { migrateAtomicFile, type AtomicFileV1 } from '../src/types/atomicFile.js';
import { remoteNoteRowSchema } from '../src/types/noteWire.js';
import { startClientFixture, FIXTURE_TOKENS } from './clientFixture.js';
import { assertFixtureCleanup } from './clientFixtureSafety.js';

test('new unchanged admissions read committed generations without rereading frozen retry receipts',
  { timeout: 60000 }, async t => {
    let phase = 'setup', passed = false, allocations = 0, creates = 0, writes = 0;
    t.after(() => writeFileSync('ci-recovery-unchanged-proof.json', JSON.stringify({ version: 1,
      scope: 'disposable inactive unchanged generation readback and frozen replay', phase, outcome: passed ? 'pass' : 'fail' })));
    const files = new Map<string, AtomicFileV1>();
    const mutable: DriveAdapter = {
      async createNoteFile() { throw new Error('unexpected_mutable_create'); },
      async updateNoteFile() { throw new Error('unexpected_mutable_update'); },
      async deleteNoteFile() { throw new Error('unexpected_mutable_delete'); },
      async getNoteFileContent(_a, _r, id) { if (!files.has(id)) throw { code: 404 };
        return structuredClone(files.get(id)!) as unknown as Record<string, unknown>; },
      async ensureAppFolders() { return { notesId: 'synthetic-parent' }; },
    };
    const fixture = await startClientFixture(process.env.MONGODB_URI, process.env.MONGODB_DB_NAME, mutable);
    let cleanupLease: (() => Promise<unknown>) | undefined;
    t.after(async () => { try { await cleanupLease?.(); } finally { await fixture.close(); } });
    const { getDb } = await import('../src/db/mongo.js');
    const { collections } = await import('../src/db/collections.js');
    const { syncOperations } = await import('../src/lib/syncOperation.js');
    const { acquireRecoveryLease, releaseRecoveryLease } = await import('../src/lib/recoveryGate.js');
    const { runFreshRecoveryPush } = await import('../src/lib/recoveryWireAdapter.js');
    const { runClassifiedRecoveryPush } = await import('../src/lib/recoveryClassifiedAdapter.js');
    const { noteContentHash } = await import('../src/lib/contentHash.js');
    const db = await getDb(); assertFixtureCleanup(db.databaseName, fixture.database);
    let lease = await acquireRecoveryLease(db, fixture.owner); cleanupLease = () => releaseRecoveryLease(db, lease);
    await collections.googleAccounts(db).updateOne({ userId: fixture.owner }, { $set: { driveRootFolderId: 'synthetic-parent' } });
    const journal = db.collection<NoteWriteIntent>('note_write_intents');
    let readHook: (() => Promise<void>) | undefined, loseReply = false;
    let metadataOverride: Record<string, unknown> | undefined, readError: unknown, forbiddenRead: string | undefined;
    const reads: string[] = [];
    const sdk = { files: {
      async generateIds(params: { count: number }) { allocations++;
        return { data: { ids: Array.from({ length: params.count }, () => `synthetic-unchanged-${randomUUID()}`) } }; },
      async create(params: { requestBody: { id: string }; media: { body: AsyncIterable<unknown> } }) {
        creates++; const intent = await journal.findOne({ stagedFileId: params.requestBody.id }); assert.ok(intent);
        assert.equal((await syncOperations(db).findOne({ _id: intent.operationId }))!.status, 'pending');
        let raw = ''; for await (const part of params.media.body) raw += String(part);
        const file = migrateAtomicFile(JSON.parse(raw));
        if (files.has(params.requestBody.id)) { assert.deepEqual(files.get(params.requestBody.id), file); throw { code: 409 }; }
        files.set(params.requestBody.id, file); writes++;
        if (loseReply) { loseReply = false; throw new Error('synthetic_unchanged_reply_lost'); }
        return { data: { id: params.requestBody.id } };
      },
      async get(params: { fileId: string; alt?: string }) {
        reads.push(params.fileId); if (params.fileId === forbiddenRead) throw new Error('unexpected_frozen_read');
        if (readError) throw readError;
        if (!files.has(params.fileId)) throw { code: 404 };
        if (params.alt === 'media') { const content = structuredClone(files.get(params.fileId)); await readHook?.(); return { data: content }; }
        return { data: metadataOverride ?? { id: params.fileId, parents: ['synthetic-parent'], mimeType: 'application/json', trashed: false } };
      },
      async update() { throw new Error('must_not_overwrite'); }, async delete() { throw new Error('must_not_delete'); },
    } } as unknown as drive_v3.Drive;
    const row = (encrypted = false) => remoteNoteRowSchema.parse({ id: randomUUID(), kind: 'text',
      title: encrypted ? '' : 'Public unchanged fixture', body: encrypted ? '' : 'Public unchanged original',
      items: [], pinned: false, deleted: false, enc_v: encrypted ? 1 : 0,
      payload: encrypted ? 'public-unchanged-opaque' : null, created_at: '2026-09-12T12:00:00Z', base_version: 0 });
    const make = (rows: unknown[]) => ({ requestId: randomUUID(), rows, mode: 'instant' as const });
    const call = (input: unknown, drive = sdk, parent = 'synthetic-parent') => runClassifiedRecoveryPush(db, fixture.owner, lease, input, drive, parent);
    const snapshot = async () => ({ notes: await collections.notes(db).find({ userId: fixture.owner }).sort({ _id: 1 }).toArray(),
      intents: await journal.find({ userId: fixture.owner }).sort({ _id: 1 }).toArray(),
      operations: await syncOperations(db).find({ userId: fixture.owner }).sort({ _id: 1 }).toArray(),
      wallet: await collections.atomicUsers(db).findOne({ _id: fixture.owner }),
      ledger: await collections.energyLedger(db).find({ userId: fixture.owner }).sort({ _id: 1 }).toArray(),
      counter: await db.collection<{ _id: string; value: number }>('sync_counters').findOne({ _id: fixture.owner }),
      allocations, creates, writes });
    const plain = row(), encrypted = row(true), deleted = row();
    phase = 'seed_through_real_inactive_callers';
    const seeded = await runFreshRecoveryPush(db, fixture.owner, lease, make([plain, encrypted, deleted]), sdk, 'synthetic-parent');
    assert.equal(seeded.status, 'complete');
    const seededEncrypted = await collections.notes(db).findOne({ _id: encrypted.id });
    const seededDeleted = await collections.notes(db).findOne({ _id: deleted.id });
    assert.ok(seededEncrypted && seededDeleted);
    const tombstone = await call(make([{ ...deleted, deleted: true, base_version: seededDeleted.localVersion }]));
    assert.equal(tombstone.status, 'complete');
    if (tombstone.status !== 'complete') throw new Error('synthetic_expected_tombstone');
    assert.equal(tombstone.operation.results[0].ok, true); assert.notEqual(tombstone.operation.results[0].unchanged, true);
    const committedDeleted = await collections.notes(db).findOne({ _id: deleted.id });
    assert.ok(committedDeleted?.deleted); assert.equal(committedDeleted.localVersion, seededDeleted.localVersion + 1);
    const note = await collections.notes(db).findOne({ _id: plain.id }); assert.ok(note?.driveFileId);
    const pointer = note.driveFileId, original = structuredClone(files.get(pointer)!);
    const samePlain = { ...plain, base_version: note.localVersion }, sameEncrypted = { ...encrypted, base_version: seededEncrypted.localVersion };
    const sameDeleted = { ...deleted, deleted: true, base_version: committedDeleted.localVersion };
    phase = 'metadata_only_live_route_false_unchanged_control';
    // Current mutable route is a control, never changed by this inactive helper.
    files.set(pointer, { ...original, body: 'Public injected corrupt body' });
    await releaseRecoveryLease(db, lease);
    const response = await fetch(`${fixture.origin}/api/notes/push`, { method: 'POST',
      headers: { authorization: `Bearer ${FIXTURE_TOKENS.a}`, 'content-type': 'application/json' }, body: JSON.stringify(make([samePlain])) });
    assert.equal(response.status, 200);
    const control = await response.json() as { results: { unchanged: boolean }[] };
    assert.equal(control.results[0].unchanged, true);
    const brokenPull = await fetch(`${fixture.origin}/api/notes/pull?after=0`, { headers: { authorization: `Bearer ${FIXTURE_TOKENS.a}` } });
    assert.equal(brokenPull.status, 409);
    lease = await acquireRecoveryLease(db, fixture.owner);
    phase = 'corrupt_refusal_before_new_admission';
    const before = await snapshot();
    await assert.rejects(call(make([row(), samePlain])), /recovery_unchanged_content_mismatch/);
    assert.deepEqual(await snapshot(), before); assert.notEqual(noteContentHash({ ...files.get(pointer)!, enc_v: 0 }), note.contentHash);
    files.set(pointer, original);
    phase = 'identity_payload_and_unknown_reads_refuse_without_writes';
    for (const damaged of [{ ...original, id: randomUUID() }, { ...original, pinned: true },
      { ...original, kind: 'todo' as const, body: '', items: [] },
      { ...original, encV: 1 as const, title: '', body: '', payload: 'public-wrong-opaque' }]) {
      files.set(pointer, damaged); await assert.rejects(call(make([samePlain])), /recovery_unchanged_content_mismatch/);
      assert.deepEqual(await snapshot(), before);
    }
    files.set(pointer, original);
    files.set(pointer, { ...original, version: 2 } as unknown as AtomicFileV1);
    await assert.rejects(call(make([samePlain])), /Unrecognized or corrupt/);
    assert.deepEqual(await snapshot(), before); files.set(pointer, original);
    for (const metadata of [{ id: 'synthetic-wrong-id', parents: ['synthetic-parent'], mimeType: 'application/json' },
      { id: pointer, parents: ['synthetic-other-parent'], mimeType: 'application/json' },
      { id: pointer, parents: ['synthetic-parent'], mimeType: 'text/plain' },
      { id: pointer, parents: ['synthetic-parent'], mimeType: 'application/json', trashed: true }]) {
      metadataOverride = metadata; await assert.rejects(call(make([samePlain])), /generation_identity_mismatch/);
      assert.deepEqual(await snapshot(), before);
    }
    metadataOverride = undefined;
    files.delete(pointer); await assert.rejects(call(make([samePlain])), (error: unknown) => !!error && typeof error === 'object' && 'code' in error && error.code === 404);
    assert.deepEqual(await snapshot(), before); files.set(pointer, original);
    readError = new Error('synthetic_unknown_read'); await assert.rejects(call(make([samePlain])), /synthetic_unknown_read/);
    readError = undefined; assert.deepEqual(await snapshot(), before);
    phase = 'legacy_and_inconsistent_flags_are_explicitly_unsupported';
    await collections.notes(db).updateOne({ _id: plain.id }, { $unset: { generationFormat: '' } });
    const legacy = await snapshot(); const priorReads = reads.length;
    await assert.rejects(call(make([samePlain])), /recovery_unchanged_legacy_unsupported/);
    assert.deepEqual(await snapshot(), legacy); assert.equal(reads.length, priorReads);
    await collections.notes(db).updateOne({ _id: plain.id }, { $set: { generationFormat: 1, pinned: true } });
    const badFlags = await snapshot(); await assert.rejects(call(make([samePlain])), /recovery_unchanged_metadata_mismatch/);
    assert.deepEqual(await snapshot(), badFlags);
    await collections.notes(db).updateOne({ _id: plain.id }, { $set: { pinned: false } });
    phase = 'external_read_then_pointer_drift_aborts_atomic_admission';
    const raceBefore = await snapshot();
    readHook = async () => { await collections.notes(db).updateOne({ _id: plain.id }, { $set: { driveFileId: 'synthetic-raced-pointer' } }); };
    await assert.rejects(call(make([samePlain])), /recovery_classification_changed/); readHook = undefined;
    const raced = await snapshot(); assert.deepEqual(raced.wallet, raceBefore.wallet); assert.deepEqual(raced.ledger, raceBefore.ledger);
    assert.deepEqual(raced.operations, raceBefore.operations); assert.deepEqual(raced.intents, raceBefore.intents);
    assert.deepEqual(raced.counter, raceBefore.counter); assert.equal(raced.creates, raceBefore.creates); assert.equal(raced.allocations, raceBefore.allocations);
    await collections.notes(db).updateOne({ _id: plain.id }, { $set: { driveFileId: pointer } });
    phase = 'live_encrypted_and_tombstone_readback_accept_paid_unchanged';
    const validBefore = await snapshot(), valid = make([samePlain, sameEncrypted, sameDeleted]);
    const accepted = await call(valid); phase = 'valid_unchanged_status'; assert.equal(accepted.status, 'complete');
    if (accepted.status !== 'complete') throw new Error('synthetic_expected_complete');
    phase = 'valid_unchanged_charge';
    assert.equal(accepted.operation.charged, 10); assert.equal(accepted.operation.refunded, 0);
    phase = 'valid_unchanged_result_flags';
    assert.ok(accepted.operation.results.every(result => result.ok && result.unchanged));
    phase = 'valid_unchanged_metadata';
    const validAfter = await snapshot(); assert.deepEqual(validAfter.notes, validBefore.notes); assert.deepEqual(validAfter.intents, validBefore.intents);
    phase = 'valid_unchanged_external_counts';
    assert.equal(validAfter.creates, validBefore.creates); assert.equal(validAfter.allocations, validBefore.allocations);
    phase = 'pending_lease_retry_never_rereads_frozen_unchanged';
    const mixed = make([row(), sameEncrypted]); loseReply = true;
    await assert.rejects(call(mixed), /synthetic_unchanged_reply_lost/);
    const paid = await snapshot(), operation = await syncOperations(db).findOne({ _id: `${fixture.owner}:${mixed.requestId}` }); assert.ok(operation);
    const frozen = operation.results.find(result => result.id === encrypted.id); assert.ok(frozen?.unchanged);
    const encryptedNote = await collections.notes(db).findOne({ _id: encrypted.id }); assert.ok(encryptedNote?.driveFileId);
    forbiddenRead = encryptedNote.driveFileId;
    files.set(forbiddenRead, { ...files.get(forbiddenRead)!, payload: 'public-post-admission-external-change' });
    await releaseRecoveryLease(db, lease); lease = await acquireRecoveryLease(db, fixture.owner);
    const resumed = await call(mixed); assert.equal(resumed.status, 'complete');
    if (resumed.status !== 'complete') throw new Error('synthetic_expected_resume');
    assert.deepEqual(resumed.operation.results.find(result => result.id === encrypted.id), frozen);
    assert.deepEqual((await snapshot()).wallet, paid.wallet); assert.deepEqual((await snapshot()).ledger, paid.ledger);
    assert.equal(allocations, paid.allocations); assert.equal(writes, paid.writes);
    phase = 'terminal_receipts_ignore_live_drive_state';
    const throwing = { files: { async generateIds() { throw new Error('unexpected_terminal_allocation'); },
      async create() { throw new Error('unexpected_terminal_create'); }, async get() { throw new Error('unexpected_terminal_read'); } } } as unknown as drive_v3.Drive;
    const terminal = await snapshot(); assert.deepEqual(await call(mixed, throwing, ''), resumed);
    assert.deepEqual(await call(valid, throwing, ''), accepted); assert.deepEqual(await snapshot(), terminal);
    const stored = JSON.stringify(terminal.intents); assert.equal(stored.includes(plain.body), false); assert.equal(stored.includes(encrypted.payload!), false);
    phase = 'complete'; passed = true;
  });
