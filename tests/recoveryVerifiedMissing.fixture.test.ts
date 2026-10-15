import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import type { drive_v3 } from 'googleapis';
import type { DriveAdapter } from '../src/routes/notes.js';
import { noteWriteIntentSchema, type NoteWriteIntent } from '../src/db/recoveryContract.js';
import { migrateAtomicFile, type AtomicFileV1 } from '../src/types/atomicFile.js';
import { remoteNoteRowSchema } from '../src/types/noteWire.js';
import { noteContentHash } from '../src/lib/contentHash.js';
import { startClientFixture, FIXTURE_TOKENS } from './clientFixture.js';
import { assertFixtureCleanup } from './clientFixtureSafety.js';

test('inactive verified missing generations request retained content and restage only the persisted ID',
  { timeout: 180000 }, async t => {
    let phase = 'setup', passed = false;
    const cases = {
      verified_missing_request: 'not_run', matching_supplied_retry: 'not_run', mixed_resolution_order: 'not_run',
      supplied_and_present_refusal: 'not_run', exact_409_race: 'not_run', mismatched_409_refusal: 'not_run',
      unknown_and_same_id_refusal: 'not_run', final_readback_refusal: 'not_run', encrypted_retry: 'not_run',
      committed_terminal_exclusions: 'not_run', lease_handoff_fence: 'not_run', eight_stage_drain: 'not_run',
      wipe_epoch_fence: 'not_run', owned_cleanup: 'not_run',
    };
    const causal = { missing_request: 'not_run', matching_retry: 'not_run' };
    const parent = 'synthetic-verified-missing-parent', files = new Map<string, AtomicFileV1>();
    const metadata = new Map<string, Record<string, unknown>>();
    let reads = 0, creates = 0, writes = 0;
    const readsById = new Map<string, number>();
    let readFault: { id: string; error: unknown } | undefined;
    let createFault: unknown;
    let onCreate: ((id: string, content: AtomicFileV1) => Promise<void>) | undefined;
    let onRead: ((id: string, media: boolean) => void) | undefined;
    let unblock: (() => void) | undefined, delayedCompletion: Promise<unknown> | undefined;
    const notesDrive: DriveAdapter = {
      async createNoteFile() { throw new Error('unexpected_mutable_create'); },
      async updateNoteFile() { throw new Error('unexpected_mutable_update'); },
      async deleteNoteFile() { throw new Error('unexpected_mutable_delete'); },
      async getNoteFileContent(_a, _r, id) { if (!files.has(id)) throw { code: 404 };
        return structuredClone(files.get(id)!) as unknown as Record<string, unknown>; },
      async ensureAppFolders() { return { notesId: parent }; },
    };
    const fixture = await startClientFixture(process.env.MONGODB_URI, process.env.MONGODB_DB_NAME, notesDrive);
    let cleanupLease: (() => Promise<unknown>) | undefined;
    t.after(async () => {
      unblock?.();
      try {
        try { await delayedCompletion; await cleanupLease?.(); }
        finally { assertFixtureCleanup(fixture.database, fixture.database); await fixture.close(); }
        cases.owned_cleanup = 'pass';
      } catch {
        cases.owned_cleanup = 'fail'; passed = false;
        throw new Error('synthetic_owned_cleanup_failed');
      } finally {
        // Emit only after the actual owned cleanup settles, including either
        // causal early-return path. No raw cleanup exception enters the proof.
        writeFileSync('ci-recovery-verified-missing-proof.json', JSON.stringify({ version: 1,
          scope: 'disposable inactive verified missing generation retained ID recovery', phase,
          outcome: passed ? 'pass' : 'fail', causal, cases }));
      }
    });
    const { getDb } = await import('../src/db/mongo.js');
    const { collections } = await import('../src/db/collections.js');
    const { acquireRecoveryLease, releaseRecoveryLease, withRecoveryWipe } = await import('../src/lib/recoveryGate.js');
    const { beginRecoverySync } = await import('../src/lib/recoveryAdmission.js');
    const { stageRecoveryIntent } = await import('../src/lib/recoveryIntent.js');
    const { commitRecoveryIntents } = await import('../src/lib/recoveryCommit.js');
    const { finishRecoverySync, abandonRecoverySync } = await import('../src/lib/recoverySettlement.js');
    const { resumeRecoveryOperation } = await import('../src/lib/recoveryResume.js');
    const { fingerprintOf, syncOperations } = await import('../src/lib/syncOperation.js');
    const db = await getDb(); assertFixtureCleanup(db.databaseName, fixture.database);
    let lease = await acquireRecoveryLease(db, fixture.owner);
    cleanupLease = () => releaseRecoveryLease(db, lease);
    await collections.googleAccounts(db).updateOne({ userId: fixture.owner }, { $set: { driveRootFolderId: parent } });
    const journal = db.collection<NoteWriteIntent>('note_write_intents');
    const sdk = { files: {
      async generateIds() { throw new Error('must_not_allocate_replacement_id'); },
      async create(params: { requestBody: { id: string }; media: { body: AsyncIterable<unknown> } }) {
        creates++;
        let raw = ''; for await (const part of params.media.body) raw += String(part);
        const content = migrateAtomicFile(JSON.parse(raw)), id = params.requestBody.id;
        if (createFault) throw createFault;
        if (onCreate) await onCreate(id, content);
        if (files.has(id)) throw { code: 409 };
        // Deliberately permissive fake map: this proves orchestration only.
        // It does not establish that real Drive accepts a deleted ID again.
        files.set(id, content); writes++;
        return { data: { id } };
      },
      async get(params: { fileId: string; alt?: string }) {
        reads++; readsById.set(params.fileId, (readsById.get(params.fileId) ?? 0) + 1);
        onRead?.(params.fileId, params.alt === 'media');
        if (readFault?.id === params.fileId) throw readFault.error;
        if (!files.has(params.fileId)) throw { code: 404 };
        return { data: params.alt === 'media' ? structuredClone(files.get(params.fileId)) : {
          id: params.fileId, parents: [parent], mimeType: 'application/json', trashed: false,
          ...metadata.get(params.fileId) } };
      },
      async update() { throw new Error('must_not_overwrite'); },
      async delete() { throw new Error('must_not_delete'); },
    } } as unknown as drive_v3.Drive;
    const now = new Date().toISOString();
    const content = (id = randomUUID(), body = 'Public synthetic retained body'): AtomicFileV1 =>
      migrateAtomicFile({ version: 1, id, kind: 'text', title: 'Public synthetic verified missing', body,
        items: [], pinned: false, encV: 0, payload: null, createdAt: now, updatedAt: now });
    const admit = async (targets: AtomicFileV1[]) => {
      const requestId = randomUUID(), operationId = `${fixture.owner}:${requestId}`, createdAt = new Date();
      const preimages = await Promise.all(targets.map(file => collections.notes(db).findOne({ _id: file.id })));
      const rows = targets.map((file, i) => remoteNoteRowSchema.parse({ id: file.id, kind: file.kind,
        title: file.title, body: file.body, items: file.items, pinned: file.pinned, deleted: false,
        enc_v: file.encV, payload: file.payload, created_at: file.createdAt, base_version: preimages[i]?.localVersion ?? 0 }));
      const intents = rows.map((row, i) => noteWriteIntentSchema.parse({ _id: `${operationId}:${row.id}`,
        format: 1, userId: fixture.owner, noteId: row.id, requestId, operationId,
        fingerprint: fingerprintOf(rows, 'instant'), expectedVersion: row.base_version,
        expectedFileId: preimages[i]?.driveFileId ?? null, expectedHash: preimages[i]?.contentHash ?? null,
        stagedFileId: `synthetic-verified-missing-${randomUUID()}`, targetHash: noteContentHash(row),
        targetFlags: { kind: row.kind, encV: row.enc_v, pinned: row.pinned, deleted: false },
        wipeEpoch: lease.wipeEpoch, leaseToken: lease.token, state: 'prepared', createdAt, updatedAt: createdAt,
        committedVersion: null, committedSequence: null, terminalReason: null }));
      await beginRecoverySync(db, lease, requestId, rows, 'instant', intents);
      return { requestId, operationId, rows, targets, intents };
    };
    type Request = Awaited<ReturnType<typeof admit>>;
    const stage = async (request: Request, index = 0) => stageRecoveryIntent(db, lease,
      request.intents[index]._id, sdk, parent, request.targets[index]);
    const missing = async (request: Request, index = 0) => {
      await stage(request, index); files.delete(request.intents[index].stagedFileId!);
      assert.equal((await journal.findOne({ _id: request.intents[index]._id }))!.state, 'verified');
    };
    const resume = (request: Request, supplied: unknown = []) =>
      resumeRecoveryOperation(db, lease, request.operationId, sdk, parent, supplied);
    // Adoption may change only leaseToken/updatedAt; gate revisions may touch.
    // These explicit protected fields must not change on a refusal.
    const protectedState = async () => ({
      wallet: await collections.atomicUsers(db).findOne({ _id: fixture.owner }),
      ledger: await collections.energyLedger(db).find({ userId: fixture.owner }).sort({ _id: 1 }).toArray(),
      notes: await collections.notes(db).find({ userId: fixture.owner }).sort({ _id: 1 }).toArray(),
      operations: await syncOperations(db).find({ userId: fixture.owner }).sort({ _id: 1 }).toArray(),
      intents: (await journal.find({ userId: fixture.owner }).sort({ _id: 1 }).toArray())
        .map(({ leaseToken: _token, updatedAt: _updated, ...fields }) => fields),
      counter: await db.collection<{ _id: string; value: number }>('sync_counters').findOne({ _id: fixture.owner }),
    });
    const auth = { authorization: `Bearer ${FIXTURE_TOKENS.a}`, 'content-type': 'application/json' };
    const checkPull = async (file: AtomicFileV1, version: number) => {
      const response = await fetch(`${fixture.origin}/api/notes/pull?after=0`, { headers: auth });
      assert.equal(response.status, 200);
      const page = await response.json() as { rows: { id: string; body: string; version: number; enc_v: number; payload: string | null }[] };
      const row = page.rows.find(row => row.id === file.id); assert.ok(row);
      assert.equal(row.body, file.body); assert.equal(row.version, version);
      assert.equal(row.enc_v, file.encV); assert.equal(row.payload, file.payload);
    };
    const checkReplay = async (request: Request, receipt: { results: unknown[]; charged: number; refunded: number }) => {
      await releaseRecoveryLease(db, lease); cleanupLease = undefined;
      const response = await fetch(`${fixture.origin}/api/notes/push`, { method: 'POST', headers: auth,
        body: JSON.stringify({ requestId: request.requestId, mode: 'instant', rows: request.rows }) });
      assert.equal(response.status, 200);
      const body = await response.json() as { results: unknown[]; charged: number; refunded: number };
      assert.deepEqual(body.results, receipt.results); assert.equal(body.charged, receipt.charged); assert.equal(body.refunded, receipt.refunded);
      lease = await acquireRecoveryLease(db, fixture.owner); cleanupLease = () => releaseRecoveryLease(db, lease);
    };

    const old = content(), initial = await admit([old]);
    assert.equal((await resume(initial, [old])).status, 'complete');
    const oldId = initial.intents[0].stagedFileId!, oldBytes = JSON.stringify(files.get(oldId));
    const next = { ...old, body: 'Public synthetic original client edit', pinned: true };
    const edit = await admit([next]); await missing(edit);
    const retainedId = edit.intents[0].stagedFileId!, paid = await protectedState(), beforeCreate = creates;
    phase = 'causal_verified_missing_request';
    let waiting: unknown;
    try { waiting = await resume(edit); causal.missing_request = 'returned'; }
    catch (error) { causal.missing_request = (error as { code?: number })?.code === 404 ? 'raw_404' : 'other_error'; }
    await t.test('verified 404 without content requests the same note', () => {
      const success = JSON.stringify(waiting) === JSON.stringify({ status: 'needs_client_content', noteIds: [next.id] });
      cases.verified_missing_request = success ? 'pass' : 'fail'; assert.equal(success, true);
    });
    assert.deepEqual(await protectedState(), paid); assert.equal(creates, beforeCreate); await checkPull(old, 1);
    phase = 'causal_matching_supplied_retry';
    let completed: Awaited<ReturnType<typeof resume>> | undefined;
    try { completed = await resume(edit, [next]); causal.matching_retry = 'returned'; }
    catch (error) { causal.matching_retry = (error as { code?: number })?.code === 404 ? 'raw_404' : 'other_error'; }
    await t.test('verified 404 with exact original content finishes at the saved ID', () => {
      const success = completed?.status === 'complete'; cases.matching_supplied_retry = success ? 'pass' : 'fail'; assert.equal(success, true);
    });
    // Preserve both before-fix failures in one sanitized artifact. No changed
    // production source or test expectation is needed for the causal run.
    if (cases.verified_missing_request !== 'pass' || completed?.status !== 'complete') return;
    assert.equal(creates, beforeCreate + 1); assert.equal(completed.operation.charged, 10); assert.equal(completed.operation.refunded, 0);
    assert.equal(completed.operation.results[0].version, 2); assert.equal(completed.operation.results[0].seq, 2);
    assert.equal((await journal.findOne({ _id: edit.intents[0]._id }))!.stagedFileId, retainedId);
    assert.deepEqual((await protectedState()).wallet, paid.wallet); assert.deepEqual((await protectedState()).ledger, paid.ledger);
    assert.equal(JSON.stringify(files.get(oldId)), oldBytes); await checkPull(next, 2);
    const settled = await protectedState(), replayCalls = { reads, creates };
    files.delete(retainedId);
    assert.deepEqual(await resume(edit, [next]), completed); assert.deepEqual({ reads, creates }, replayCalls);
    files.set(retainedId, next); await checkReplay(edit, completed.operation); assert.deepEqual(await protectedState(), settled);

    phase = 'mixed_resolution_order';
    const mixedTargets = [content(), content(), content()], mixed = await admit(mixedTargets);
    await missing(mixed, 0); await missing(mixed, 2);
    const mixedPaid = await protectedState(), mixedCreates = creates;
    assert.deepEqual(await resume(mixed), { status: 'needs_client_content', noteIds: mixedTargets.map(file => file.id) });
    assert.deepEqual(await resume(mixed, [mixedTargets[1]]), { status: 'needs_client_content', noteIds: [mixedTargets[0].id, mixedTargets[2].id] });
    assert.equal(creates, mixedCreates); assert.deepEqual(await protectedState(), mixedPaid);
    assert.equal((await resume(mixed, mixedTargets)).status, 'complete'); cases.mixed_resolution_order = 'pass';

    phase = 'supplied_and_present_refusal';
    const raceTarget = { ...next, body: 'Public synthetic race target' }, race = await admit([raceTarget]); await missing(race);
    const raceId = race.intents[0].stagedFileId!, racePaid = await protectedState(), refusalCreates = creates;
    for (const bad of [{ ...raceTarget, body: 'Public wrong body' }, { ...raceTarget, pinned: false },
      { ...raceTarget, encV: 1, title: '', body: '', items: [], payload: 'opaque-wrong' }, { ...raceTarget, kind: 'todo' }]) {
      await assert.rejects(resume(race, [bad]), /recovery_staged_content_mismatch/);
      assert.deepEqual(await protectedState(), racePaid); assert.equal(creates, refusalCreates);
    }
    await assert.rejects(resume(race, [content()]), /recovery_resume_operation_invalid/);
    await assert.rejects(resume(race, [raceTarget, raceTarget]), /recovery_resume_duplicate_content/);
    await assert.rejects(resume(race, Array.from({ length: 51 }, () => raceTarget)));
    files.set(raceId, { ...raceTarget, body: 'Public present mismatched body' });
    await assert.rejects(resume(race, [raceTarget]), /recovery_commit_content_mismatch/);
    assert.equal(creates, refusalCreates); assert.deepEqual(await protectedState(), racePaid); files.delete(raceId);
    cases.supplied_and_present_refusal = 'pass';

    phase = 'mismatched_409_refusal';
    const variants: { file?: AtomicFileV1; meta?: Record<string, unknown> }[] = [
      { file: { ...raceTarget, body: 'Public raced wrong body' } },
      { file: { ...raceTarget, updatedAt: new Date(Date.parse(now) + 1).toISOString() } },
      { meta: { parents: ['synthetic-wrong-parent'] } }, { meta: { mimeType: 'text/plain' } },
      { meta: { trashed: true } }, { meta: { id: 'synthetic-wrong-id' } },
    ];
    for (const variant of variants) {
      onCreate = async id => { files.set(id, variant.file ?? raceTarget); if (variant.meta) metadata.set(id, variant.meta); };
      const before = writes;
      await assert.rejects(resume(race, [raceTarget]), /generation_(content|identity)_mismatch/);
      assert.equal(writes, before); assert.deepEqual(await protectedState(), racePaid);
      files.delete(raceId); metadata.delete(raceId);
    }
    onCreate = undefined; cases.mismatched_409_refusal = 'pass';

    phase = 'unknown_and_same_id_refusal';
    for (const error of [{ code: 401 }, { code: 403 }, { code: 503 }, new Error('synthetic_transport')]) {
      readFault = { id: raceId, error };
      await assert.rejects(resume(race, [raceTarget]), actual => actual === error);
      assert.deepEqual(await protectedState(), racePaid);
    }
    readFault = undefined; createFault = { code: 400 };
    await assert.rejects(resume(race, [raceTarget]), actual => actual === createFault);
    assert.deepEqual(await protectedState(), racePaid); assert.equal(files.has(raceId), false);
    createFault = undefined; cases.unknown_and_same_id_refusal = 'pass';

    phase = 'final_readback_refusal';
    let mediaReads = 0;
    onRead = (id, media) => { if (id === raceId && media && ++mediaReads === 2) files.delete(id); };
    await assert.rejects(resume(race, [raceTarget]), error => (error as { code?: number })?.code === 404);
    onRead = undefined; assert.deepEqual(await protectedState(), racePaid);
    assert.deepEqual(await resume(race), { status: 'needs_client_content', noteIds: [raceTarget.id] });
    cases.final_readback_refusal = 'pass';

    phase = 'exact_409_race';
    onCreate = async id => { files.set(id, raceTarget); };
    const raceWrites = writes; assert.equal((await resume(race, [raceTarget])).status, 'complete');
    onCreate = undefined; assert.equal(writes, raceWrites); assert.deepEqual(files.get(raceId), raceTarget);
    assert.equal(JSON.stringify(files.get(oldId)), oldBytes); cases.exact_409_race = 'pass';

    phase = 'encrypted_retry';
    const encrypted = { ...content(), title: '', body: '', encV: 1, payload: 'opaque-public-synthetic-ciphertext' };
    const encryptedRequest = await admit([encrypted]); await missing(encryptedRequest);
    assert.deepEqual(await resume(encryptedRequest), { status: 'needs_client_content', noteIds: [encrypted.id] });
    const encryptedPaid = await protectedState(), encryptedReceipt = await resume(encryptedRequest, [encrypted]);
    assert.equal(encryptedReceipt.status, 'complete'); if (encryptedReceipt.status !== 'complete') throw new Error('synthetic_expected_complete');
    assert.equal(encryptedReceipt.operation.refunded, 0); assert.deepEqual((await protectedState()).wallet, encryptedPaid.wallet);
    // Fresh-note versions use the existing global monotonic sequence; earlier
    // commits in this same fixture make this value greater than one.
    const encryptedVersion = encryptedPaid.counter!.value + 1;
    assert.equal(encryptedReceipt.operation.results[0].version, encryptedVersion);
    assert.equal(encryptedReceipt.operation.results[0].seq, encryptedVersion);
    await checkPull(encrypted, encryptedVersion); await checkReplay(encryptedRequest, encryptedReceipt.operation); cases.encrypted_retry = 'pass';

    phase = 'committed_terminal_exclusions';
    const partial = await admit([content(), content()]); await stage(partial, 0); await missing(partial, 1);
    await commitRecoveryIntents(db, lease, [partial.intents[0]._id], sdk, parent);
    const partialCommitted = await journal.findOne({ _id: partial.intents[0]._id });
    const committedId = partial.intents[0].stagedFileId!, committedReads = readsById.get(committedId);
    files.delete(committedId);
    assert.equal((await resume(partial, [partial.targets[1]])).status, 'complete');
    assert.equal(readsById.get(committedId), committedReads);
    assert.deepEqual(await journal.findOne({ _id: partial.intents[0]._id }), partialCommitted);
    files.set(committedId, partial.targets[0]);
    const abandoned = await admit([content()]); await missing(abandoned);
    const failed = await abandonRecoverySync(db, lease, abandoned.operationId);
    assert.equal(failed.refunded, 10); assert.equal(failed.results[0].ok, false);
    const abandonedState = await protectedState(), abandonedCalls = { reads, creates };
    const failedReplay = await resume(abandoned, abandoned.targets);
    assert.equal(failedReplay.status, 'complete'); if (failedReplay.status !== 'complete') throw new Error('synthetic_expected_complete');
    assert.deepEqual(failedReplay.operation, failed); assert.deepEqual(await protectedState(), abandonedState);
    assert.deepEqual({ reads, creates }, abandonedCalls); cases.committed_terminal_exclusions = 'pass';

    phase = 'lease_handoff_fence';
    const handoffTarget = { ...raceTarget, body: 'Public synthetic lease handoff body' }, handoff = await admit([handoffTarget]); await missing(handoff);
    const handoffId = handoff.intents[0].stagedFileId!, handoffPaid = await protectedState();
    let announce: (() => void) | undefined;
    const started = new Promise<void>(resolve => { announce = resolve; });
    const paused = new Promise<void>(resolve => { unblock = resolve; });
    onCreate = async (id, file) => { files.set(id, file); announce?.(); await paused; };
    const obsolete = lease;
    const delayed = resume(handoff, [handoffTarget]).then(() => false, error => /recovery_fence_lost/.test(String(error)));
    delayedCompletion = delayed; await started;
    await releaseRecoveryLease(db, lease); lease = await acquireRecoveryLease(db, fixture.owner);
    unblock!(); assert.equal(await delayed, true); onCreate = undefined; unblock = undefined;
    assert.deepEqual(await protectedState(), handoffPaid); assert.equal(files.has(handoffId), true);
    assert.equal((await journal.findOne({ _id: handoff.intents[0]._id }))!.leaseToken, obsolete.token);
    const handoffCreates = creates; assert.equal((await resume(handoff, [handoffTarget])).status, 'complete');
    assert.equal(creates, handoffCreates); cases.lease_handoff_fence = 'pass';

    phase = 'eight_stage_drain';
    // Nine existing notes fit the admitted note limit and exercise the same
    // eight-worker bound for verified restaging. Hold all started replies.
    const active = await collections.notes(db).find({ userId: fixture.owner }).sort({ _id: 1 }).toArray();
    const drainTargets = active.map(note => {
      const file = files.get(note.driveFileId)!;
      return file.encV === 1 ? { ...file, payload: 'opaque-public-synthetic-drain' } : { ...file, body: 'Public synthetic drain body' };
    });
    while (drainTargets.length < 9) drainTargets.push(content());
    const drain = await admit(drainTargets);
    for (let i = 0; i < drain.intents.length; i++) await missing(drain, i);
    let activeStages = 0, maxStages = 0, startedStages = 0, finishedStages = 0;
    let announceEight: (() => void) | undefined;
    const eightStarted = new Promise<void>(resolve => { announceEight = resolve; });
    const stagePause = new Promise<void>(resolve => { unblock = resolve; });
    onCreate = async () => {
      startedStages++; activeStages++; maxStages = Math.max(maxStages, activeStages);
      if (startedStages === 8) announceEight?.();
      await stagePause; activeStages--; finishedStages++;
      throw new Error('synthetic_stage_refusal');
    };
    const drainPaid = await protectedState();
    const drained = resume(drain, drainTargets).then(() => false, error => /synthetic_stage_refusal/.test(String(error)));
    delayedCompletion = drained; await eightStarted; assert.equal(startedStages, 8);
    unblock!(); assert.equal(await drained, true); onCreate = undefined; unblock = undefined;
    assert.equal(maxStages, 8); assert.equal(activeStages, 0); assert.equal(startedStages, finishedStages);
    assert.deepEqual(await protectedState(), drainPaid); cases.eight_stage_drain = 'pass';

    phase = 'wipe_epoch_fence';
    const wipeTarget = { ...handoffTarget, body: 'Public synthetic pre-wipe edit' }, wipe = await admit([wipeTarget]); await missing(wipe);
    let announceWipe: (() => void) | undefined;
    const wipeStarted = new Promise<void>(resolve => { announceWipe = resolve; });
    const wipePaused = new Promise<void>(resolve => { unblock = resolve; });
    onCreate = async (id, file) => { files.set(id, file); announceWipe?.(); await wipePaused; };
    const preWipe = lease;
    const delayedWipe = resume(wipe, [wipeTarget]).then(() => false, error => /recovery_fence_lost/.test(String(error)));
    delayedCompletion = delayedWipe; await wipeStarted;
    assertFixtureCleanup(db.databaseName, fixture.database);
    lease = await withRecoveryWipe(db, lease, async session => { await collections.notes(db).deleteMany({ userId: fixture.owner }, { session }); });
    const wiped = await protectedState(); unblock!(); assert.equal(await delayedWipe, true); onCreate = undefined; unblock = undefined;
    assert.equal(lease.wipeEpoch, preWipe.wipeEpoch + 1); assert.deepEqual(await protectedState(), wiped);
    await assert.rejects(resume(wipe, [wipeTarget]), /recovery_adoption_manifest_invalid/);
    assert.deepEqual(await protectedState(), wiped); cases.wipe_epoch_fence = 'pass';
    const journals = JSON.stringify(wiped.intents);
    assert.equal(journals.includes(next.body), false); assert.equal(journals.includes(encrypted.payload), false);
    assert.equal(JSON.stringify(files.get(oldId)), oldBytes);
    await releaseRecoveryLease(db, lease); cleanupLease = undefined;
    assertFixtureCleanup(db.databaseName, fixture.database);
    phase = 'complete'; passed = true;
  });
