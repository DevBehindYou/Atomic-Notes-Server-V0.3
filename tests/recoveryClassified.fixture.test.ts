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

test('classified caller freezes sparse results, protects replacement capacity, and settles zero-intent funding',
  { timeout: 60000 }, async t => {
    let phase = 'setup', passed = false, allocations = 0, creates = 0, writes = 0;
    t.after(() => writeFileSync('ci-recovery-classified-proof.json', JSON.stringify({ version: 1,
      scope: 'disposable inactive classified admission sparse recovery and coupled replacement', phase, outcome: passed ? 'pass' : 'fail' })));
    const files = new Map<string, AtomicFileV1>();
    const notesDrive: DriveAdapter = {
      async createNoteFile() { throw new Error('unexpected_mutable_create'); },
      async updateNoteFile() { throw new Error('unexpected_mutable_update'); },
      async deleteNoteFile() { throw new Error('unexpected_mutable_delete'); },
      async getNoteFileContent(_a, _r, id) { if (!files.has(id)) throw { code: 404 };
        return structuredClone(files.get(id)!) as unknown as Record<string, unknown>; },
      async ensureAppFolders() { return { notesId: 'synthetic-parent' }; },
    };
    const fixture = await startClientFixture(process.env.MONGODB_URI, process.env.MONGODB_DB_NAME, notesDrive);
    let cleanupLease: (() => Promise<unknown>) | undefined;
    t.after(async () => { try { await cleanupLease?.(); } finally { await fixture.close(); } });
    const { getDb } = await import('../src/db/mongo.js');
    const { collections } = await import('../src/db/collections.js');
    const { syncOperations } = await import('../src/lib/syncOperation.js');
    const { acquireRecoveryLease, releaseRecoveryLease } = await import('../src/lib/recoveryGate.js');
    const { runFreshRecoveryPush } = await import('../src/lib/recoveryWireAdapter.js');
    const { runClassifiedRecoveryPush } = await import('../src/lib/recoveryClassifiedAdapter.js');
    const { finishRecoverySync } = await import('../src/lib/recoverySettlement.js');
    const db = await getDb(); assertFixtureCleanup(db.databaseName, fixture.database);
    let lease = await acquireRecoveryLease(db, fixture.owner); cleanupLease = () => releaseRecoveryLease(db, lease);
    await collections.googleAccounts(db).updateOne({ userId: fixture.owner }, { $set: { driveRootFolderId: 'synthetic-parent' } });
    const journal = db.collection<NoteWriteIntent>('note_write_intents');
    let allocationHook: (() => Promise<void>) | undefined, loseReplyFor: string | undefined, failCreateFor: string | undefined;
    const sdk = { files: {
      async generateIds(params: { count: number }) { allocations++; await allocationHook?.();
        return { data: { ids: Array.from({ length: params.count }, () => `synthetic-classified-${randomUUID()}`) } }; },
      async create(params: { requestBody: { id: string }; media: { body: AsyncIterable<unknown> } }) {
        creates++; const intent = await journal.findOne({ stagedFileId: params.requestBody.id }); assert.ok(intent);
        const operation = await syncOperations(db).findOne({ _id: intent.operationId }); assert.ok(operation);
        assert.equal(operation.status, 'pending'); assert.equal(operation.charged, 10);
        let raw = ''; for await (const part of params.media.body) raw += String(part);
        const file = migrateAtomicFile(JSON.parse(raw)); assert.equal(file.updatedAt, intent.createdAt.toISOString());
        if (failCreateFor === file.id) throw new Error('synthetic_uncertain_delete_create');
        if (files.has(params.requestBody.id)) { assert.deepEqual(files.get(params.requestBody.id), file); throw { code: 409 }; }
        files.set(params.requestBody.id, file); writes++;
        if (loseReplyFor === file.id) { loseReplyFor = undefined; throw new Error('synthetic_classified_reply_lost'); }
        return { data: { id: params.requestBody.id } };
      },
      async get(params: { fileId: string; alt?: string }) {
        if (!files.has(params.fileId)) throw { code: 404 };
        return { data: params.alt === 'media' ? structuredClone(files.get(params.fileId)) : {
          id: params.fileId, parents: ['synthetic-parent'], mimeType: 'application/json', trashed: false } };
      },
      async update() { throw new Error('must_not_overwrite'); }, async delete() { throw new Error('must_not_delete'); },
    } } as unknown as drive_v3.Drive;
    const row = (encrypted = false) => remoteNoteRowSchema.parse({ id: randomUUID(), kind: 'text',
      title: encrypted ? '' : 'Public classified note', body: encrypted ? '' : 'Public classified original body',
      items: [], pinned: false, deleted: false, enc_v: encrypted ? 1 : 0, payload: encrypted ? 'public-classified-opaque-old' : null,
      created_at: '2026-09-12T12:00:00+05:30', updated_at: '2026-09-13T12:00:00+05:30', base_version: 0 });
    const a = row(), b = row(true), c = row(), fresh = row();
    const make = (rows: unknown[], mode: 'standard' | 'instant' = 'instant') => ({ requestId: randomUUID(), rows, mode });
    const call = (input: unknown, selected = sdk, parent = 'synthetic-parent') =>
      runClassifiedRecoveryPush(db, fixture.owner, lease, input, selected, parent);
    const snapshot = async () => ({
      notes: await collections.notes(db).find({ userId: fixture.owner }).sort({ _id: 1 }).toArray(),
      intents: await journal.find({ userId: fixture.owner }).sort({ _id: 1 }).toArray(),
      operations: await syncOperations(db).find({ userId: fixture.owner }).sort({ _id: 1 }).toArray(),
      wallet: await collections.atomicUsers(db).findOne({ _id: fixture.owner }),
      ledger: await collections.energyLedger(db).find({ userId: fixture.owner }).sort({ _id: 1 }).toArray(),
      counter: await db.collection<{ _id: string; value: number }>('sync_counters').findOne({ _id: fixture.owner }),
    });
    const pull = async () => {
      const response = await fetch(`${fixture.origin}/api/notes/pull?after=0`, { headers: { authorization: `Bearer ${FIXTURE_TOKENS.a}` } });
      assert.equal(response.status, 200);
      return response.json() as Promise<{ rows: { id: string; body: string; payload: string | null; deleted: boolean; version: number }[]; nextCursor: number }>;
    };
    phase = 'seed_via_existing_fresh_caller';
    await runFreshRecoveryPush(db, fixture.owner, lease, make([a, b, c]), sdk, 'synthetic-parent');
    const seed = await snapshot(), get = (id: string) => seed.notes.find(note => note._id === id)!;
    assert.equal(seed.notes.length, 3); assert.equal(seed.counter!.value, 3);
    const bEdit = { ...b, payload: 'public-classified-opaque-edit', base_version: get(b.id).localVersion };
    const cSame = { ...c, base_version: get(c.id).localVersion };
    phase = 'foreign_missing_and_logout_refusal_before_debit';
    const foreign = row();
    await collections.notes(db).insertOne({ ...get(a.id), _id: foreign.id, userId: fixture.other });
    const pre = await snapshot(), preAlloc = allocations;
    await assert.rejects(call(make([foreign])), /note_id_conflict/);
    await assert.rejects(call(make([{ ...row(), base_version: 2 }])), /recovery_missing_note_unsupported/);
    await assert.rejects(call(make([{ ...row(), deleted: true }])), /recovery_missing_note_unsupported/);
    await assert.rejects(call({ ...make([row()]), logoutAttemptId: randomUUID() }), /recovery_logout_unsupported/);
    assert.deepEqual(await snapshot(), pre); assert.equal(allocations, preAlloc);
    await collections.notes(db).deleteOne({ _id: foreign.id, userId: fixture.other });
    phase = 'unchanged_classification_drift_during_allocation_rolls_back';
    allocationHook = async () => { await collections.notes(db).updateOne({ _id: c.id }, { $set: { updatedAt: new Date(get(c.id).updatedAt.getTime() + 1) } }); };
    await assert.rejects(call(make([row(), cSame])), /recovery_classification_changed/);
    allocationHook = undefined;
    assert.deepEqual((await snapshot()).wallet, seed.wallet); assert.deepEqual((await snapshot()).ledger, seed.ledger);
    assert.equal((await snapshot()).operations.length, 1); assert.equal((await snapshot()).intents.length, 3);
    await collections.notes(db).updateOne({ _id: c.id }, { $set: { updatedAt: get(c.id).updatedAt } });
    const mixed = make([bEdit, a, cSame]), mixedId = `${fixture.owner}:${mixed.requestId}`;
    phase = 'real_mongo_classification_failure_rolls_back_debit_and_manifest';
    const admissionBefore = await snapshot(), admissionCreates = creates;
    assertFixtureCleanup(db.databaseName, fixture.database);
    await db.command({ collMod: 'sync_operations', validator: { 'results.error': { $ne: 'note_conflict' } },
      validationLevel: 'strict', validationAction: 'error' });
    await assert.rejects(call(mixed), (error: unknown) => typeof error === 'object' && error !== null && 'code' in error && error.code === 121);
    assert.deepEqual(await snapshot(), admissionBefore); assert.equal(creates, admissionCreates);
    assertFixtureCleanup(db.databaseName, fixture.database);
    await db.command({ collMod: 'sync_operations', validator: {}, validationLevel: 'strict', validationAction: 'error' });
    phase = 'mixed_sparse_admission_and_lost_create_reply';
    loseReplyFor = b.id; const beforeMixed = await snapshot(), beforeWrites = writes, beforeAlloc = allocations;
    await assert.rejects(call(mixed), /synthetic_classified_reply_lost/);
    const paid = await snapshot(), saved = await journal.findOne({ operationId: mixedId }); assert.ok(saved);
    const frozenResults = [{ id: a.id, ok: false, error: 'note_conflict', version: get(a.id).localVersion },
      { id: c.id, ok: true, unchanged: true, version: get(c.id).localVersion, updated_at: get(c.id).updatedAt.toISOString() }];
    assert.deepEqual((await syncOperations(db).findOne({ _id: mixedId }))!.results, frozenResults);
    assert.equal(await journal.countDocuments({ operationId: mixedId }), 1);
    assert.equal(paid.wallet!.energy, beforeMixed.wallet!.energy - 10); assert.equal(paid.ledger.length, beforeMixed.ledger.length + 1);
    assert.deepEqual(paid.notes, beforeMixed.notes); assert.deepEqual(paid.counter, beforeMixed.counter);
    assert.equal(writes, beforeWrites + 1); assert.equal(allocations, beforeAlloc + 1);
    phase = 'missing_journal_and_overlap_fail_closed_without_settlement';
    await journal.deleteOne({ _id: saved._id }); const missing = await snapshot();
    await assert.rejects(call(mixed), /recovery_coverage_missing/);
    await assert.rejects(finishRecoverySync(db, lease, mixedId), /recovery_coverage_missing/);
    assert.deepEqual(await snapshot(), missing); await journal.insertOne(saved);
    await syncOperations(db).updateOne({ _id: mixedId }, { $push: { results: { id: b.id, ok: true, unchanged: true,
      version: get(b.id).localVersion, updated_at: get(b.id).updatedAt.toISOString() } } });
    const overlap = await snapshot(); await assert.rejects(call(mixed), /recovery_coverage_overlap/);
    assert.deepEqual(await snapshot(), overlap);
    await syncOperations(db).updateOne({ _id: mixedId }, { $set: { results: frozenResults } });
    phase = 'fresh_lease_refuses_valid_write_preimage_drift_and_keeps_frozen_results';
    await releaseRecoveryLease(db, lease); lease = await acquireRecoveryLease(db, fixture.owner);
    await collections.notes(db).updateOne({ _id: b.id }, { $inc: { localVersion: 1 } }); const drift = await snapshot();
    await assert.rejects(call(mixed), /recovery_preimage_changed/); assert.deepEqual(await snapshot(), drift);
    await collections.notes(db).updateOne({ _id: b.id }, { $set: { localVersion: get(b.id).localVersion } });
    // Generated out-of-protocol metadata injection probes immutable decisions;
    // no claim that another HTTP writer bypassed this user's held notes lease.
    await collections.notes(db).updateOne({ _id: a.id }, { $inc: { localVersion: 1 } });
    await collections.notes(db).updateOne({ _id: c.id }, { $set: { updatedAt: new Date(get(c.id).updatedAt.getTime() + 2) } });
    const complete = await call(mixed); assert.equal(complete.status, 'complete');
    if (complete.status !== 'complete') throw new Error('synthetic_expected_complete');
    assert.deepEqual(complete.operation.results.slice(1), frozenResults);
    assert.equal(complete.operation.charged, 10); assert.equal(complete.operation.refunded, 0);
    assert.equal(complete.operation.results[0].ok, true); assert.equal(allocations, beforeAlloc + 1);
    assert.equal(writes, beforeWrites + 1); assert.equal((await journal.findOne({ _id: saved._id }))!.stagedFileId, saved.stagedFileId);
    assert.equal(files.get(saved.stagedFileId!)!.updatedAt, saved.createdAt.toISOString());
    assert.equal((await pull()).rows.find(note => note.id === b.id)!.payload, bEdit.payload);
    assert.equal((await pull()).nextCursor, 4);
    const terminalMixed = await snapshot(); assert.deepEqual(await call(mixed), complete); assert.deepEqual(await snapshot(), terminalMixed);
    phase = 'stale_delete_and_stale_restore_preserve_original_quota_ordering';
    await collections.atomicUsers(db).updateOne({ _id: fixture.owner }, { $set: { noteLimit: 3 } });
    const limit = await snapshot(), quotaAlloc = allocations;
    await assert.rejects(call(make([fresh, { ...a, deleted: true, base_version: 0 }])), /note_limit_reached/);
    assert.deepEqual(await snapshot(), limit); assert.equal(allocations, quotaAlloc);
    // A tombstone-like metadata seed is injected only to probe production's
    // optimistic stale-restore counting; no handcrafted recovery manifest.
    const restore = row(); await collections.notes(db).insertOne({ ...get(a.id), _id: restore.id, deleted: true, localVersion: 2 });
    const restoreBefore = await snapshot(); await assert.rejects(call(make([restore])), /note_limit_reached/);
    assert.deepEqual(await snapshot(), restoreBefore); assert.equal(allocations, quotaAlloc);
    await collections.notes(db).deleteOne({ _id: restore.id });
    phase = 'replacement_unknown_delete_error_cannot_commit_staged_addition';
    const currentA = await collections.notes(db).findOne({ _id: a.id }); assert.ok(currentA);
    const replacement = make([fresh, { ...a, deleted: true, base_version: currentA.localVersion }]);
    const replaceId = `${fixture.owner}:${replacement.requestId}`, beforeReplace = await snapshot(), replaceWrites = writes;
    failCreateFor = a.id; await assert.rejects(call(replacement), /synthetic_uncertain_delete_create/);
    const pendingReplace = await snapshot(), replacementIntents = await journal.find({ operationId: replaceId }).toArray();
    assert.equal(replacementIntents.length, 2); assert.equal(pendingReplace.notes.some(note => note._id === fresh.id), false);
    assert.deepEqual(pendingReplace.notes, beforeReplace.notes); assert.deepEqual(pendingReplace.counter, beforeReplace.counter);
    assert.equal((await syncOperations(db).findOne({ _id: replaceId }))!.status, 'pending');
    assert.deepEqual((await syncOperations(db).findOne({ _id: replaceId }))!.results, []);
    assert.equal(pendingReplace.wallet!.energy, beforeReplace.wallet!.energy - 10); assert.equal(writes, replaceWrites + 1);
    const oldCloud = await pull(); assert.equal(oldCloud.rows.some(note => note.id === fresh.id), false);
    assert.equal(oldCloud.rows.find(note => note.id === a.id)!.deleted, false); assert.equal(oldCloud.nextCursor, 4);
    const replacementAlloc = allocations; failCreateFor = undefined;
    await releaseRecoveryLease(db, lease); lease = await acquireRecoveryLease(db, fixture.owner);
    const replaced = await call(replacement); assert.equal(replaced.status, 'complete');
    if (replaced.status !== 'complete') throw new Error('synthetic_expected_replacement');
    assert.equal(replaced.operation.charged, 10); assert.equal(replaced.operation.refunded, 0);
    assert.deepEqual(replaced.operation.results.map(result => result.seq), [5, 6]);
    assert.equal(await collections.notes(db).countDocuments({ userId: fixture.owner, deleted: false }), 3);
    assert.equal((await collections.notes(db).findOne({ _id: a.id }))!.deleted, true);
    assert.equal(allocations, replacementAlloc); assert.deepEqual((await snapshot()).ledger, pendingReplace.ledger);
    for (const intent of replacementIntents) assert.equal((await journal.findOne({ _id: intent._id }))!.stagedFileId, intent.stagedFileId);
    phase = 'zero_intent_conflicts_pay_refund_once_and_restore_standard_window';
    const currentB = await collections.notes(db).findOne({ _id: b.id }); assert.ok(currentB);
    const allConflict = make([{ ...bEdit, base_version: 0 }], 'standard'), conflictId = `${fixture.owner}:${allConflict.requestId}`;
    const beforeConflict = await snapshot(), zeroAlloc = allocations, zeroCreates = creates;
    const failed = await call(allConflict); assert.equal(failed.status, 'complete');
    if (failed.status !== 'complete') throw new Error('synthetic_expected_conflict');
    assert.equal(failed.operation.charged, 5); assert.equal(failed.operation.refunded, 5);
    assert.deepEqual(failed.operation.results, [{ id: b.id, ok: false, error: 'note_conflict', version: currentB.localVersion }]);
    assert.equal(await journal.countDocuments({ operationId: conflictId }), 0);
    assert.equal((await snapshot()).wallet!.energy, beforeConflict.wallet!.energy);
    assert.equal((await snapshot()).wallet!.lastStandardSyncAt, null);
    assert.equal((await snapshot()).ledger.length, beforeConflict.ledger.length + 2);
    const afterConflict = await snapshot(); assert.deepEqual(await call(allConflict), failed); assert.deepEqual(await snapshot(), afterConflict);
    phase = 'zero_intent_unchanged_is_paid_success_without_refund';
    const currentFresh = await collections.notes(db).findOne({ _id: fresh.id }); assert.ok(currentFresh);
    const allUnchanged = make([{ ...fresh, base_version: currentFresh.localVersion }]);
    const unchanged = await call(allUnchanged); assert.equal(unchanged.status, 'complete');
    if (unchanged.status !== 'complete') throw new Error('synthetic_expected_unchanged');
    assert.equal(unchanged.operation.charged, 10); assert.equal(unchanged.operation.refunded, 0);
    assert.equal(unchanged.operation.results[0].unchanged, true);
    assert.equal(await journal.countDocuments({ operationId: `${fixture.owner}:${allUnchanged.requestId}` }), 0);
    assert.equal((await snapshot()).wallet!.energy, afterConflict.wallet!.energy - 10);
    assert.equal(allocations, zeroAlloc); assert.equal(creates, zeroCreates);
    const unchangedDone = await snapshot(); assert.deepEqual(await call(allUnchanged), unchanged); assert.deepEqual(await snapshot(), unchangedDone);
    phase = 'funding_is_not_bypassed_and_terminal_replay_needs_no_sdk';
    await collections.atomicUsers(db).updateOne({ _id: fixture.owner }, { $set: { energy: 0 } }); const empty = await snapshot();
    await assert.rejects(call(make([{ ...bEdit, base_version: 0 }])), /insufficient_energy/); assert.deepEqual(await snapshot(), empty);
    const forbidden = { files: { async generateIds() { throw new Error('unexpected_terminal_allocation'); },
      async create() { throw new Error('unexpected_terminal_create'); }, async get() { throw new Error('unexpected_terminal_read'); } } } as unknown as drive_v3.Drive;
    assert.deepEqual(await call(allUnchanged, forbidden, ''), unchanged);
    await assert.rejects(call({ ...allUnchanged, rows: [{ ...fresh, base_version: currentFresh.localVersion,
      created_at: '2026-09-14T12:00:00+05:30' }] }, forbidden, ''), /sync_request_mismatch/);
    assert.deepEqual(await snapshot(), empty);
    const allJournal = JSON.stringify(empty.intents);
    assert.equal(allJournal.includes(bEdit.payload), false); assert.equal(allJournal.includes(a.body), false);
    phase = 'complete'; passed = true;
  });
