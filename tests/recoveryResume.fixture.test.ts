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

test('inactive coordinator resumes saved generations or requests missing client content without another charge',
  { timeout: 60000 }, async (t) => {
    let phase = 'setup', passed = false, writes = 0, reads = 0;
    t.after(() => writeFileSync('ci-recovery-resume-proof.json', JSON.stringify({ version: 1,
      scope: 'disposable inactive prepared verified and partial operation coordinator',
      phase, outcome: passed ? 'pass' : 'fail' })));
    const files = new Map<string, AtomicFileV1>();
    let faultId: string | undefined;
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
    const { beginRecoverySync } = await import('../src/lib/recoveryAdmission.js');
    const { stageRecoveryIntent } = await import('../src/lib/recoveryIntent.js');
    const { commitRecoveryIntents } = await import('../src/lib/recoveryCommit.js');
    const { resumeRecoveryOperation } = await import('../src/lib/recoveryResume.js');
    const { fingerprintOf, syncOperations } = await import('../src/lib/syncOperation.js');
    const db = await getDb(); assertFixtureCleanup(db.databaseName, fixture.database);
    let lease = await acquireRecoveryLease(db, fixture.owner), released = false;
    cleanupLease = () => released ? Promise.resolve() : releaseRecoveryLease(db, lease);
    await collections.googleAccounts(db).updateOne({ userId: fixture.owner },
      { $set: { driveRootFolderId: 'synthetic-parent' } });
    const journal = db.collection<NoteWriteIntent>('note_write_intents');
    const sdk = { files: {
      async create(params: { requestBody: { id: string }; media: { body: AsyncIterable<unknown> } }) {
        if (files.has(params.requestBody.id)) throw { code: 409 };
        let raw = ''; for await (const part of params.media.body) raw += String(part);
        files.set(params.requestBody.id, migrateAtomicFile(JSON.parse(raw))); writes++;
        return { data: { id: params.requestBody.id } };
      },
      async get(params: { fileId: string; alt?: string }) {
        reads++;
        if (params.fileId === faultId) throw { code: 503 };
        if (!files.has(params.fileId)) throw { code: 404 };
        return { data: params.alt === 'media' ? structuredClone(files.get(params.fileId)) : {
          id: params.fileId, parents: ['synthetic-parent'], mimeType: 'application/json', trashed: false } };
      },
      async update() { throw new Error('must_not_overwrite'); },
      async delete() { throw new Error('must_not_delete'); },
    } } as unknown as drive_v3.Drive;
    const make = () => {
      const requestId = randomUUID(), now = new Date();
      const targets = Array.from({ length: 2 }, (_, i) => migrateAtomicFile({ version: 1, id: randomUUID(),
        kind: 'text', title: 'Public synthetic coordinator', body: `Public synthetic saved body ${i}`,
        items: [], pinned: false, encV: 0, payload: null, createdAt: now.toISOString(), updatedAt: now.toISOString() }));
      const rows = targets.map((file) => remoteNoteRowSchema.parse({ id: file.id, kind: 'text', title: file.title,
        body: file.body, items: [], pinned: false, deleted: false, enc_v: 0, payload: null,
        base_version: 0, created_at: file.createdAt }));
      const intents = rows.map((row) => noteWriteIntentSchema.parse({ _id: `${fixture.owner}:${requestId}:${row.id}`,
        format: 1, userId: fixture.owner, noteId: row.id, requestId, operationId: `${fixture.owner}:${requestId}`,
        fingerprint: fingerprintOf(rows, 'instant'), expectedVersion: 0, expectedFileId: null, expectedHash: null,
        stagedFileId: `synthetic-resume-${randomUUID()}`, targetHash: noteContentHash(row),
        targetFlags: { kind: 'text', encV: 0, pinned: false, deleted: false }, wipeEpoch: lease.wipeEpoch,
        leaseToken: lease.token, state: 'prepared', createdAt: now, updatedAt: now,
        committedVersion: null, committedSequence: null, terminalReason: null }));
      return { requestId, targets, rows, intents, operationId: intents[0].operationId };
    };
    const snapshot = async () => ({ wallet: await collections.atomicUsers(db).findOne({ _id: fixture.owner }),
      ledger: await collections.energyLedger(db).find({ userId: fixture.owner }).sort({ _id: 1 }).toArray(),
      notes: await collections.notes(db).find({ userId: fixture.owner }).sort({ _id: 1 }).toArray(),
      operations: await syncOperations(db).find({ userId: fixture.owner }).sort({ _id: 1 }).toArray(),
      intents: await journal.find({ userId: fixture.owner }).sort({ _id: 1 }).toArray(),
      counter: await db.collection<{ _id: string }>('sync_counters').findOne({ _id: fixture.owner }) });
    const first = make();
    await beginRecoverySync(db, lease, first.requestId, first.rows, 'instant', first.intents);
    // Simulate a completed Drive create whose journal verification did not land.
    // Mongo never receives this content; the immutable ID was already persisted.
    files.set(first.intents[0].stagedFileId!, first.targets[0]); writes++;
    const initial = await snapshot();
    phase = 'bounded_identity';
    await assert.rejects(resumeRecoveryOperation(db, lease, first.operationId, sdk, 'synthetic-parent',
      Array.from({ length: 51 }, () => first.targets[0])));
    await assert.rejects(resumeRecoveryOperation(db, lease, first.operationId, sdk, 'synthetic-parent',
      [first.targets[0], first.targets[0]]), /recovery_resume_duplicate_content/);
    await assert.rejects(resumeRecoveryOperation(db, lease, `${fixture.other}:${first.requestId}`, sdk,
      'synthetic-parent'), /recovery_resume_operation_invalid/);
    assert.deepEqual(await snapshot(), initial); assert.equal(reads, 0);
    phase = 'waiting_for_client';
    const waiting = await resumeRecoveryOperation(db, lease, first.operationId, sdk, 'synthetic-parent');
    assert.deepEqual(waiting, { status: 'needs_client_content', noteIds: [first.rows[1].id] });
    assert.equal(writes, 1); assert.equal(await collections.notes(db).countDocuments({ userId: fixture.owner }), 0);
    assert.equal((await syncOperations(db).findOne({ _id: first.operationId }))!.status, 'pending');
    assert.equal((await collections.atomicUsers(db).findOne({ _id: fixture.owner }))!.energy, 90);
    assert.equal((await journal.findOne({ _id: first.intents[0]._id }))!.state, 'prepared');
    phase = 'unknown_error_pending';
    faultId = first.intents[0].stagedFileId!;
    await assert.rejects(resumeRecoveryOperation(db, lease, first.operationId, sdk, 'synthetic-parent'),
      (error: unknown) => (error as { code?: number }).code === 503);
    assert.equal((await syncOperations(db).findOne({ _id: first.operationId }))!.status, 'pending');
    assert.equal((await collections.atomicUsers(db).findOne({ _id: fixture.owner }))!.energy, 90);
    assert.equal(writes, 1); faultId = undefined;
    phase = 'prepared_resume';
    const complete = await resumeRecoveryOperation(db, lease, first.operationId, sdk, 'synthetic-parent',
      [first.targets[1]]);
    assert.equal(complete.status, 'complete'); if (complete.status !== 'complete') throw new Error('synthetic_expected_receipt');
    assert.equal(complete.operation.charged, 10); assert.equal(complete.operation.refunded, 0);
    assert.deepEqual(complete.operation.results.map((row) => row.seq), [1, 2]);
    assert.equal(writes, 2); assert.equal(files.size, 2);
    assert.deepEqual((await journal.find({ operationId: first.operationId }).toArray()).map((row) => row.stagedFileId).sort(),
      first.intents.map((row) => row.stagedFileId).sort());
    const second = make();
    await beginRecoverySync(db, lease, second.requestId, second.rows, 'instant', second.intents);
    for (let i = 0; i < 2; i++) await stageRecoveryIntent(db, lease, second.intents[i]._id, sdk,
      'synthetic-parent', second.targets[i]);
    await commitRecoveryIntents(db, lease, [second.intents[0]._id], sdk, 'synthetic-parent');
    const committed = await journal.findOne({ _id: second.intents[0]._id });
    const oldLease = lease; await releaseRecoveryLease(db, lease); lease = await acquireRecoveryLease(db, fixture.owner);
    phase = 'stale_worker_refusal';
    const beforeStale = await snapshot();
    await assert.rejects(resumeRecoveryOperation(db, oldLease, second.operationId, sdk, 'synthetic-parent'), /recovery_fence_lost/);
    assert.deepEqual(await snapshot(), beforeStale);
    phase = 'verified_readback_refusal';
    faultId = second.intents[1].stagedFileId!;
    await assert.rejects(resumeRecoveryOperation(db, lease, second.operationId, sdk, 'synthetic-parent'),
      (error: unknown) => (error as { code?: number }).code === 503);
    assert.equal(await collections.notes(db).countDocuments({ userId: fixture.owner }), 3);
    assert.equal((await syncOperations(db).findOne({ _id: second.operationId }))!.status, 'pending');
    assert.equal((await collections.atomicUsers(db).findOne({ _id: fixture.owner }))!.energy, 80);
    assert.deepEqual(await journal.findOne({ _id: second.intents[0]._id }), committed);
    assert.equal(writes, 4); faultId = undefined;
    phase = 'partial_resume_without_client';
    const finished = await resumeRecoveryOperation(db, lease, second.operationId, sdk, 'synthetic-parent');
    assert.equal(finished.status, 'complete'); if (finished.status !== 'complete') throw new Error('synthetic_expected_receipt');
    assert.deepEqual(finished.operation.results.map((row) => row.seq), [3, 4]);
    assert.equal(finished.operation.refunded, 0); assert.equal(writes, 4);
    const beforeReplay = await snapshot(), beforeReads = reads;
    phase = 'completed_replay';
    const replay = await resumeRecoveryOperation(db, lease, second.operationId, sdk, 'synthetic-parent');
    assert.deepEqual(replay, finished); assert.equal(reads, beforeReads); assert.equal(writes, 4);
    assert.deepEqual(await snapshot(), beforeReplay);
    assert.equal(JSON.stringify(beforeReplay.intents).includes(first.targets[0].body), false);
    await releaseRecoveryLease(db, lease); released = true;
    phase = 'actual_http_pull_replay';
    const auth = { authorization: `Bearer ${FIXTURE_TOKENS.a}` };
    const pull = await fetch(`${fixture.origin}/api/notes/pull?after=0`, { headers: auth });
    assert.equal(pull.status, 200);
    const page = await pull.json() as { nextCursor: number; rows: { id: string; body: string }[] };
    assert.equal(page.nextCursor, 4); assert.equal(page.rows.length, 4);
    for (const file of [...first.targets, ...second.targets]) assert.equal(page.rows.find((row) => row.id === file.id)!.body, file.body);
    const final = await snapshot();
    for (const [request, receipt] of [[first, complete.operation], [second, finished.operation]] as const) {
      const response = await fetch(`${fixture.origin}/api/notes/push`, { method: 'POST',
        headers: { ...auth, 'content-type': 'application/json' },
        body: JSON.stringify({ requestId: request.requestId, mode: 'instant', rows: request.rows }) });
      assert.equal(response.status, 200);
      const body = await response.json() as { results: unknown[]; charged: number; refunded: number };
      assert.deepEqual(body.results, receipt.results); assert.equal(body.charged, 10); assert.equal(body.refunded, 0);
    }
    assert.deepEqual(await snapshot(), final); assert.equal(writes, 4);
    phase = 'complete'; passed = true;
  });
