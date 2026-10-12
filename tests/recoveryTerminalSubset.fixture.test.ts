import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import type { drive_v3 } from 'googleapis';
import type { DriveAdapter } from '../src/routes/notes.js';
import { noteWriteIntentSchema, type NoteWriteIntent } from '../src/db/recoveryContract.js';
import { noteContentHash } from '../src/lib/contentHash.js';
import { migrateAtomicFile, type AtomicFileV1 } from '../src/types/atomicFile.js';
import { remoteNoteRowSchema } from '../src/types/noteWire.js';
import { startClientFixture, FIXTURE_TOKENS, FIXTURE_ADMIN_KEY } from './clientFixture.js';
import { assertFixtureCleanup } from './clientFixtureSafety.js';

test('inactive trusted terminal partition commits metadata and failures atomically without changing refund policy',
  { timeout: 90000 }, async t => {
    let phase = 'setup', passed = false;
    t.after(() => writeFileSync('ci-recovery-terminal-subset-proof.json', JSON.stringify({ version: 1,
      scope: 'disposable inactive trusted terminal partition and atomic partial settlement',
      phase, outcome: passed ? 'pass' : 'fail' })));
    const parent = 'synthetic-terminal-parent', files = new Map<string, AtomicFileV1>();
    let reads = 0, creates = 0;
    const notesDrive: DriveAdapter = {
      async createNoteFile() { throw new Error('unexpected_mutable_create'); },
      async updateNoteFile() { throw new Error('unexpected_mutable_update'); },
      async deleteNoteFile() { throw new Error('unexpected_mutable_delete'); },
      async getNoteFileContent(_a, _r, id) { if (!files.has(id)) throw { code: 404 };
        return structuredClone(files.get(id)!) as unknown as Record<string, unknown>; },
      async ensureAppFolders() { return { notesId: parent }; },
    };
    const fixture = await startClientFixture(process.env.MONGODB_URI, process.env.MONGODB_DB_NAME, notesDrive);
    const { getDb } = await import('../src/db/mongo.js');
    const { collections } = await import('../src/db/collections.js');
    const { acquireRecoveryLease, releaseRecoveryLease } = await import('../src/lib/recoveryGate.js');
    const { beginRecoverySync } = await import('../src/lib/recoveryAdmission.js');
    const { stageRecoveryIntent } = await import('../src/lib/recoveryIntent.js');
    const { runFreshRecoveryPush } = await import('../src/lib/recoveryWireAdapter.js');
    const { settleRecoverySubset } = await import('../src/lib/recoveryTerminalSubset.js');
    const { commitRecoveryIntents } = await import('../src/lib/recoveryCommit.js');
    const { fingerprintOf, syncOperations } = await import('../src/lib/syncOperation.js');
    const db = await getDb(); assertFixtureCleanup(db.databaseName, fixture.database);
    const lease = await acquireRecoveryLease(db, fixture.owner);
    t.after(async () => { try { await releaseRecoveryLease(db, lease); } finally { await fixture.close(); } });
    await collections.googleAccounts(db).updateOne({ userId: fixture.owner }, { $set: { driveRootFolderId: parent } });
    const journal = db.collection<NoteWriteIntent>('note_write_intents');
    const sdk = { files: {
      async generateIds(params: { count: number }) { return { data: { ids: Array.from({ length: params.count }, () => `synthetic-terminal-${randomUUID()}`) } }; },
      async create(params: { requestBody: { id: string }; media: { body: AsyncIterable<unknown> } }) {
        creates++; if (files.has(params.requestBody.id)) throw { code: 409 };
        let raw = ''; for await (const part of params.media.body) raw += String(part);
        files.set(params.requestBody.id, migrateAtomicFile(JSON.parse(raw)));
        return { data: { id: params.requestBody.id } };
      },
      async get(params: { fileId: string; alt?: string }) {
        reads++; if (!files.has(params.fileId)) throw { code: 404 };
        return { data: params.alt === 'media' ? structuredClone(files.get(params.fileId)) : {
          id: params.fileId, parents: [parent], mimeType: 'application/json', trashed: false } };
      },
      async update() { throw new Error('must_not_overwrite'); }, async delete() { throw new Error('must_not_delete'); },
    } } as unknown as drive_v3.Drive;
    const fresh = () => remoteNoteRowSchema.parse({ id: randomUUID(), kind: 'text', title: 'Public terminal fixture',
      body: 'Public original body', items: [], pinned: false, deleted: false, enc_v: 0, payload: null,
      base_version: 0, created_at: new Date().toISOString() });
    type Row = ReturnType<typeof fresh>;
    const snapshot = async () => ({
      notes: await collections.notes(db).find({ userId: fixture.owner }).sort({ _id: 1 }).toArray(),
      operations: await syncOperations(db).find({ userId: fixture.owner }).sort({ _id: 1 }).toArray(),
      journal: await journal.find({ userId: fixture.owner }).sort({ _id: 1 }).toArray(),
      wallet: await collections.atomicUsers(db).findOne({ _id: fixture.owner }),
      ledger: await collections.energyLedger(db).find({ userId: fixture.owner }).sort({ _id: 1 }).toArray(),
      counter: await db.collection<{ _id: string; value: number }>('sync_counters').findOne({ _id: fixture.owner }),
    });
    const seed = [fresh(), fresh(), fresh(), fresh()];
    await runFreshRecoveryPush(db, fixture.owner, lease, { requestId: randomUUID(), mode: 'instant', rows: seed }, sdk, parent);
    const seeded = await snapshot(), note = (id: string) => seeded.notes.find(row => row._id === id)!;
    // Synthetic assembly uses the existing atomic admission, not a new HTTP
    // classifier. These supplied classifications are revalidated at admission.
    const admit = async (rows: Row[], writes: Row[], mode: 'standard' | 'instant' = 'instant', classified: unknown[] = []) => {
      const requestId = randomUUID(), operationId = `${fixture.owner}:${requestId}`, now = new Date();
      const intents: NoteWriteIntent[] = [];
      for (const row of writes) {
        const old = await collections.notes(db).findOne({ _id: row.id });
        intents.push(noteWriteIntentSchema.parse({ _id: `${operationId}:${row.id}`, format: 1, userId: fixture.owner,
          noteId: row.id, requestId, operationId, fingerprint: fingerprintOf(rows, mode), expectedVersion: row.base_version,
          expectedFileId: old?.driveFileId ?? null, expectedHash: old?.contentHash ?? null,
          stagedFileId: `synthetic-terminal-${randomUUID()}`, targetHash: noteContentHash(row),
          targetFlags: { kind: row.kind, encV: row.enc_v, pinned: row.pinned, deleted: row.deleted },
          wipeEpoch: lease.wipeEpoch, leaseToken: lease.token, state: 'prepared', createdAt: now, updatedAt: now,
          committedVersion: null, committedSequence: null, terminalReason: null }));
      }
      await beginRecoverySync(db, lease, requestId, rows, mode, intents, undefined, classified);
      const stage = async (index: number) => {
        const row = writes[index], intent = intents[index];
        await stageRecoveryIntent(db, lease, intent._id, sdk, parent, migrateAtomicFile({ version: 1, id: row.id,
          kind: row.kind, title: row.title, body: row.body, items: row.items, pinned: row.pinned, encV: row.enc_v,
          payload: row.payload, createdAt: row.created_at, updatedAt: intent.createdAt.toISOString() }));
      };
      const decision = (success: number[]) => ({ operationId, successfulIntentIds: success.map(i => intents[i]._id),
        failedIntentIds: intents.filter((_, i) => !success.includes(i)).map(row => row._id) });
      return { requestId, rows, writes, mode, intents, stage, decision, operationId };
    };
    const a = { ...seed[0], body: 'Public successful edit', base_version: note(seed[0].id).localVersion };
    const b = { ...seed[1], body: 'Public failed edit', base_version: note(seed[1].id).localVersion };
    const unchanged = { ...seed[2], base_version: note(seed[2].id).localVersion }, stale = seed[3];
    const frozen = [{ id: unchanged.id, ok: true, unchanged: true, version: note(unchanged.id).localVersion,
      updated_at: note(unchanged.id).updatedAt.toISOString() }, { id: stale.id, ok: false, error: 'note_conflict', version: note(stale.id).localVersion }];
    const partial = await admit([a, unchanged, b, stale], [a, b], 'instant', frozen);
    await partial.stage(0);
    phase = 'partition_coverage_and_fence_refusal';
    const paid = await snapshot(), sdkBefore = reads;
    for (const decision of [
      { ...partial.decision([0]), failedIntentIds: [] },
      { ...partial.decision([0]), failedIntentIds: [partial.intents[0]._id, partial.intents[1]._id] },
      { ...partial.decision([0]), successfulIntentIds: [partial.intents[0]._id, partial.intents[0]._id] },
      { ...partial.decision([0]), failedIntentIds: [`${fixture.owner}:${randomUUID()}:${randomUUID()}`] },
    ]) await assert.rejects(settleRecoverySubset(db, lease, decision, sdk, parent), /recovery_subset_partition_invalid/);
    await assert.rejects(settleRecoverySubset(db, { ...lease, token: randomUUID() }, partial.decision([0]), sdk, parent), /recovery_fence_lost/);
    await assert.rejects(settleRecoverySubset(db, { ...lease, wipeEpoch: lease.wipeEpoch + 1 }, partial.decision([0]), sdk, parent), /recovery_fence_lost/);
    await assert.rejects(settleRecoverySubset(db, lease, partial.decision([1]), sdk, parent), /recovery_subset_intent_not_ready/);
    const otherLease = await acquireRecoveryLease(db, fixture.other);
    try { await assert.rejects(settleRecoverySubset(db, otherLease, partial.decision([0]), sdk, parent), /recovery_subset_operation_invalid/); }
    finally { await releaseRecoveryLease(db, otherLease); }
    assert.deepEqual(await snapshot(), paid); assert.equal(reads, sdkBefore);
    const removed = await journal.findOne({ _id: partial.intents[1]._id }); assert.ok(removed);
    await journal.deleteOne({ _id: removed._id }); const missing = await snapshot();
    await assert.rejects(settleRecoverySubset(db, lease, partial.decision([0]), sdk, parent), /recovery_coverage_missing/);
    assert.deepEqual(await snapshot(), missing); await journal.insertOne(removed);
    phase = 'real_mongo_failure_after_success_metadata_write';
    assertFixtureCleanup(db.databaseName, fixture.database);
    await db.command({ collMod: 'note_write_intents', validator: { state: { $ne: 'abandoned' } }, validationLevel: 'strict', validationAction: 'error' });
    await assert.rejects(settleRecoverySubset(db, lease, partial.decision([0]), sdk, parent),
      (error: unknown) => typeof error === 'object' && error !== null && 'code' in error && error.code === 121);
    assert.deepEqual(await snapshot(), paid);
    assertFixtureCleanup(db.databaseName, fixture.database);
    await db.command({ collMod: 'note_write_intents', validator: {}, validationLevel: 'strict', validationAction: 'error' });
    phase = 'post_settlement_rollback';
    await assert.rejects(settleRecoverySubset(db, lease, partial.decision([0]), sdk, parent, async session => {
      const local = await collections.notes(db).findOne({ _id: a.id }, { session });
      assert.equal(local!.localVersion, note(a.id).localVersion + 1);
      assert.equal((await syncOperations(db).findOne({ _id: partial.operationId }, { session }))!.status, 'complete');
      throw new Error('synthetic_terminal_barrier');
    }), /synthetic_terminal_barrier/);
    assert.deepEqual(await snapshot(), paid);
    phase = 'corrected_partial_no_refund_and_replay';
    const complete = await settleRecoverySubset(db, lease, partial.decision([0]), sdk, parent);
    assert.equal(complete.status, 'complete'); assert.equal(complete.charged, 10); assert.equal(complete.refunded, 0);
    assert.deepEqual(complete.results.map(row => row.id), partial.rows.map(row => row.id));
    assert.deepEqual(complete.results.map(row => row.ok), [true, true, false, false]);
    assert.deepEqual(complete.results[1], frozen[0]); assert.deepEqual(complete.results[3], frozen[1]);
    assert.equal(complete.results[0].seq, seeded.counter!.value + 1);
    assert.deepEqual(complete.results[2], { id: b.id, ok: false, error: 'note_write_failed' });
    const settled = await snapshot(); assert.equal(settled.wallet!.energy, paid.wallet!.energy);
    assert.equal(settled.ledger.length, paid.ledger.length); assert.equal(settled.counter!.value, seeded.counter!.value + 1);
    assert.equal(settled.notes.find(row => row._id === b.id)!.driveFileId, note(b.id).driveFileId);
    const calls = { reads, creates };
    assert.deepEqual(await settleRecoverySubset(db, lease, partial.decision([0]), sdk, parent), complete);
    assert.deepEqual(await snapshot(), settled); assert.deepEqual({ reads, creates }, calls);
    await assert.rejects(settleRecoverySubset(db, lease, partial.decision([1]), sdk, parent), /recovery_subset_outcome_mismatch/);
    assert.deepEqual(await snapshot(), settled);
    phase = 'already_committed_success_and_classified_success_preserved';
    const priorA = (await collections.notes(db).findOne({ _id: a.id }))!;
    const anotherA = { ...a, body: 'Public previously committed edit', base_version: priorA.localVersion };
    const previous = await admit([anotherA, b], [anotherA, b]); await previous.stage(0);
    await commitRecoveryIntents(db, lease, [previous.intents[0]._id], sdk, parent);
    const previousBefore = await snapshot(), previousReads = reads;
    const previousComplete = await settleRecoverySubset(db, lease, previous.decision([0]), sdk, parent);
    assert.deepEqual(previousComplete.results.map(row => row.ok), [true, false]); assert.equal(previousComplete.refunded, 0);
    assert.equal(reads, previousReads);
    assert.deepEqual((await snapshot()).notes, previousBefore.notes); assert.deepEqual((await snapshot()).counter, previousBefore.counter);
    const classifiedOnly = await admit([b, unchanged], [b], 'instant', [frozen[0]]);
    const classifiedBefore = await snapshot();
    const classifiedComplete = await settleRecoverySubset(db, lease, classifiedOnly.decision([]), sdk, parent);
    assert.deepEqual(classifiedComplete.results, [{ id: b.id, ok: false, error: 'note_write_failed' }, frozen[0]]);
    assert.equal(classifiedComplete.refunded, 0); assert.equal((await snapshot()).wallet!.energy, classifiedBefore.wallet!.energy);
    phase = 'admission_reservation_is_not_repriced';
    const addition = fresh(), failedEdit = { ...seed[1], body: 'Public second failed edit', base_version: note(b.id).localVersion };
    const reserved = await admit([addition, failedEdit], [addition, failedEdit]); await reserved.stage(0);
    await collections.atomicUsers(db).updateOne({ _id: fixture.owner }, { $set: { noteLimit: 0 } });
    const reservedComplete = await settleRecoverySubset(db, lease, reserved.decision([0]), sdk, parent);
    assert.deepEqual(reservedComplete.results.map(row => row.ok), [true, false]); assert.equal(reservedComplete.refunded, 0);
    await collections.atomicUsers(db).updateOne({ _id: fixture.owner }, { $set: { noteLimit: 10 } });
    phase = 'deletion_funded_addition_and_restore_refusal';
    // Out-of-protocol tombstone injection is only a dependency-containment
    // probe, not a claim about supported production Drive repair or admission.
    await collections.notes(db).updateOne({ _id: unchanged.id }, { $set: { deleted: true } });
    const activeA = (await collections.notes(db).findOne({ _id: a.id }))!;
    const deletion = { ...a, deleted: true, base_version: activeA.localVersion };
    const restore = { ...unchanged, body: 'Public restored body', deleted: false }, newAddition = fresh();
    const dependent = await admit([deletion, newAddition, restore], [deletion, newAddition, restore]);
    await dependent.stage(1); await dependent.stage(2);
    const dependencyBefore = await snapshot(), dependencyReads = reads;
    await assert.rejects(settleRecoverySubset(db, lease, dependent.decision([1, 2]), sdk, parent), /recovery_subset_dependency_unsupported/);
    assert.deepEqual(await snapshot(), dependencyBefore); assert.equal(reads, dependencyReads);
    const dependentFailed = await settleRecoverySubset(db, lease, dependent.decision([]), sdk, parent);
    assert.equal(dependentFailed.refunded, 10); assert.ok(dependentFailed.results.every(row => !row.ok));
    assert.equal(await collections.notes(db).findOne({ _id: newAddition.id }), null);
    phase = 'all_failed_capped_refund_and_window_restore';
    const allFailedRow = fresh(), allFailed = await admit([allFailedRow], [allFailedRow], 'standard');
    const grant = await fetch(`${fixture.origin}/api/admin/energy`, { method: 'POST', headers: {
      'content-type': 'application/json', 'x-admin-api-key': FIXTURE_ADMIN_KEY }, body: JSON.stringify({ user_id: fixture.owner, energy_delta: 1000 }) });
    assert.equal(grant.status, 200);
    // Use the real adjustment API to leave two units of headroom at settlement.
    const lower = await fetch(`${fixture.origin}/api/admin/energy`, { method: 'POST', headers: {
      'content-type': 'application/json', 'x-admin-api-key': FIXTURE_ADMIN_KEY }, body: JSON.stringify({ user_id: fixture.owner, energy_delta: -2 }) });
    assert.equal(lower.status, 200);
    const cappedBefore = await snapshot(); assert.equal(cappedBefore.wallet!.energy, 118);
    const failedComplete = await settleRecoverySubset(db, lease, allFailed.decision([]), sdk, parent);
    assert.equal(failedComplete.charged, 5); assert.equal(failedComplete.refunded, 2);
    const capped = await snapshot(); assert.equal(capped.wallet!.energy, 120); assert.equal(capped.wallet!.lastStandardSyncAt, null);
    assert.equal(capped.ledger.length, cappedBefore.ledger.length + 1);
    assert.deepEqual(await settleRecoverySubset(db, lease, allFailed.decision([]), sdk, parent), failedComplete);
    assert.deepEqual(await snapshot(), capped);
    phase = 'actual_http_receipt_replay_and_pull';
    await releaseRecoveryLease(db, lease);
    for (const [request, receipt] of [[partial, complete], [allFailed, failedComplete]] as const) {
      const response = await fetch(`${fixture.origin}/api/notes/push`, { method: 'POST', headers: {
        'content-type': 'application/json', authorization: `Bearer ${FIXTURE_TOKENS.a}` },
        body: JSON.stringify({ requestId: request.requestId, mode: request.mode, rows: request.rows }) });
      assert.equal(response.status, 502);
      const body = await response.json() as { results: unknown[]; charged: number; refunded: number };
      assert.deepEqual(body.results, receipt.results); assert.equal(body.charged, receipt.charged); assert.equal(body.refunded, receipt.refunded);
    }
    const response = await fetch(`${fixture.origin}/api/notes/pull?after=0`, { headers: { authorization: `Bearer ${FIXTURE_TOKENS.a}` } });
    assert.equal(response.status, 200);
    const pulled = await response.json() as { rows: { id: string; body: string }[] };
    assert.equal(pulled.rows.find(row => row.id === a.id)!.body, anotherA.body);
    assert.equal(pulled.rows.find(row => row.id === b.id)!.body, seed[1].body);
    assert.deepEqual(await snapshot(), capped);
    phase = 'complete'; passed = true;
  });
