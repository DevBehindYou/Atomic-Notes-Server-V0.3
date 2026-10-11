import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import type { drive_v3 } from 'googleapis';
import type { DriveAdapter } from '../src/routes/notes.js';
import type { NoteWriteIntent } from '../src/db/recoveryContract.js';
import { migrateAtomicFile, type AtomicFileV1 } from '../src/types/atomicFile.js';
import { startClientFixture, FIXTURE_TOKENS } from './clientFixture.js';
import { assertFixtureCleanup } from './clientFixtureSafety.js';

test('inactive generation SDK retries preserve saved identity billing and commit fences',
  { timeout: 120000 }, async t => {
    let phase = 'setup', passed = false;
    t.after(() => writeFileSync('ci-recovery-drive-retry-proof.json', JSON.stringify({ version: 1,
      scope: 'disposable inactive SDK retry retained generation and lease commit fence',
      phase, outcome: passed ? 'pass' : 'fail' })));
    const files = new Map<string, AtomicFileV1>(), parent = 'synthetic-drive-retry-parent';
    const notesDrive: DriveAdapter = {
      async createNoteFile() { throw new Error('unexpected_mutable_create'); },
      async updateNoteFile() { throw new Error('unexpected_mutable_update'); },
      async deleteNoteFile() { throw new Error('unexpected_mutable_delete'); },
      async getNoteFileContent(_a, _r, id) {
        if (!files.has(id)) throw { code: 404 };
        return structuredClone(files.get(id)!) as unknown as Record<string, unknown>;
      },
      async ensureAppFolders() { return { notesId: parent }; },
    };
    const fixture = await startClientFixture(process.env.MONGODB_URI, process.env.MONGODB_DB_NAME, notesDrive);
    const { getDb } = await import('../src/db/mongo.js');
    const { collections } = await import('../src/db/collections.js');
    const { acquireRecoveryLease, releaseRecoveryLease } = await import('../src/lib/recoveryGate.js');
    const { runClassifiedRecoveryPush } = await import('../src/lib/recoveryClassifiedAdapter.js');
    const { syncOperations } = await import('../src/lib/syncOperation.js');
    const db = await getDb(); assertFixtureCleanup(db.databaseName, fixture.database);
    let lease = await acquireRecoveryLease(db, fixture.owner);
    t.after(async () => { try { await releaseRecoveryLease(db, lease); } finally { await fixture.close(); } });
    await collections.googleAccounts(db).updateOne({ userId: fixture.owner }, { $set: { driveRootFolderId: parent } });
    const journal = db.collection<NoteWriteIntent>('note_write_intents');
    let allocations = 0, creates = 0, writes = 0, metadataReads = 0, mediaReads = 0;
    const attempts = new Map<string, number>(), streams = new Set<unknown>(), bodies = new Map<string, string[]>();
    let mode: 'success' | 'permanent' | 'clear' | 'auth' | 'handoff' = 'success';
    let handoffDone = false;
    const invalidGrant = { response: { status: 400, data: { error: 'invalid_grant' } } };
    const sdk = { files: {
      async generateIds(params: { count: number }) {
        if (++allocations === 1) throw { code: 503 };
        return { data: { ids: Array.from({ length: params.count }, () => `synthetic-drive-retry-${randomUUID()}`) } };
      },
      async create(params: { requestBody: { id: string; parents: string[] }; media: { body: AsyncIterable<unknown> } }) {
        const id = params.requestBody.id; creates++;
        assert.deepEqual(params.requestBody.parents, [parent]);
        assert.equal(streams.has(params.media.body), false); streams.add(params.media.body);
        let raw = ''; for await (const part of params.media.body) raw += String(part);
        const seen = bodies.get(id) ?? []; if (seen.length) assert.equal(raw, seen[0]); seen.push(raw); bodies.set(id, seen);
        const file = migrateAtomicFile(JSON.parse(raw)), intent = await journal.findOne({ stagedFileId: id });
        assert.ok(intent); assert.equal(intent.noteId, file.id);
        assert.equal((await syncOperations(db).findOne({ _id: intent.operationId }))!.status, 'pending');
        const count = (attempts.get(id) ?? 0) + 1; attempts.set(id, count);
        if (mode === 'permanent') throw { code: 503 };
        if (mode === 'auth') throw invalidGrant;
        if (mode === 'handoff' && !handoffDone) {
          handoffDone = true;
          await releaseRecoveryLease(db, lease); lease = await acquireRecoveryLease(db, fixture.owner);
          throw { code: 503 };
        }
        if (files.has(id)) throw { code: 409 };
        if (mode === 'success' && count === 1 && file.body.endsWith('0')) throw { code: 429 };
        files.set(id, file); writes++;
        if (mode === 'success' && count === 1 && file.body.endsWith('1')) throw { code: 503 };
        return { data: { id } };
      },
      async get(params: { fileId: string; alt?: string }) {
        if (!files.has(params.fileId)) throw { code: 404 };
        if (params.alt === 'media') {
          if (++mediaReads === 1) throw { code: 503 };
          return { data: structuredClone(files.get(params.fileId)) };
        }
        if (++metadataReads === 1) throw { status: 403, errors: [{ reason: 'rateLimitExceeded' }] };
        return { data: { id: params.fileId, parents: [parent], mimeType: 'application/json', trashed: false } };
      },
      async update() { throw new Error('must_not_overwrite'); },
      async delete() { throw new Error('must_not_delete'); },
    } } as unknown as drive_v3.Drive;
    const make = (count: number) => ({ requestId: randomUUID(), mode: 'instant' as const,
      rows: Array.from({ length: count }, (_, i) => ({ id: randomUUID(), kind: 'text' as const,
        title: 'Public synthetic SDK retry', body: `Public synthetic SDK body ${i}`, items: [],
        pinned: false, deleted: false, enc_v: 0 as const, payload: null, base_version: 0,
        created_at: new Date().toISOString() })) });
    const call = (envelope: ReturnType<typeof make>) => runClassifiedRecoveryPush(db, fixture.owner, lease, envelope, sdk, parent);
    const economy = async () => ({ wallet: await collections.atomicUsers(db).findOne({ _id: fixture.owner }),
      ledger: await collections.energyLedger(db).find({ userId: fixture.owner }).sort({ _id: 1 }).toArray() });
    const published = async () => ({ notes: await collections.notes(db).find({ userId: fixture.owner }).sort({ _id: 1 }).toArray(),
      counter: await db.collection<{ _id: string }>('sync_counters').findOne({ _id: fixture.owner }) });

    phase = 'real_default_policy_eventual_success';
    const first = make(2), firstResult = await call(first);
    assert.equal(firstResult.status, 'complete');
    if (firstResult.status !== 'complete') throw new Error('synthetic_expected_complete');
    assert.deepEqual(firstResult.operation.results.map(row => row.seq), [1, 2]);
    assert.equal(firstResult.operation.charged, 10); assert.equal(firstResult.operation.refunded, 0);
    assert.equal(allocations, 2); assert.equal(creates, 4); assert.equal(writes, 2); assert.equal(files.size, 2);
    assert.equal((await economy()).wallet!.energy, 90);

    phase = 'four_attempt_ceiling_keeps_paid_operation_pending';
    mode = 'permanent'; const second = make(1), secondId = `${fixture.owner}:${second.requestId}`;
    const before = await published(), startCreates = creates;
    await assert.rejects(call(second), (error: unknown) => (error as { code?: number }).code === 503);
    assert.equal(creates - startCreates, 4); assert.deepEqual(await published(), before);
    const saved = (await journal.findOne({ operationId: secondId }))!;
    assert.equal(saved.state, 'prepared'); assert.equal(files.has(saved.stagedFileId!), false);
    const pending = await syncOperations(db).findOne({ _id: secondId });
    assert.equal(pending!.status, 'pending'); assert.deepEqual(pending!.results, []); assert.equal(pending!.refunded, 0);
    const paid = await economy(), beforeAlloc = allocations; assert.equal(paid.wallet!.energy, 80);
    mode = 'clear'; const secondResult = await call(second);
    assert.equal(secondResult.status, 'complete'); assert.equal(allocations, beforeAlloc);
    assert.deepEqual(await economy(), paid); assert.equal((await journal.findOne({ operationId: secondId }))!.stagedFileId, saved.stagedFileId);

    phase = 'invalid_grant_is_not_retried_or_settled';
    mode = 'auth'; const third = make(1), thirdId = `${fixture.owner}:${third.requestId}`;
    const beforeAuth = await published(), authCreates = creates;
    await assert.rejects(call(third), seen => seen === invalidGrant);
    assert.equal(creates - authCreates, 1); assert.deepEqual(await published(), beforeAuth);
    const authPaid = await economy(), oldLease = lease, authAlloc = allocations;
    assert.equal(authPaid.wallet!.energy, 70);
    const thirdIntent = (await journal.findOne({ operationId: thirdId }))!;

    phase = 'lease_loss_during_retry_refuses_verification_and_commit';
    mode = 'handoff';
    await assert.rejects(runClassifiedRecoveryPush(db, fixture.owner, oldLease, third, sdk, parent), /recovery_fence_lost/);
    assert.equal(handoffDone, true); assert.deepEqual(await published(), beforeAuth);
    assert.equal((await journal.findOne({ operationId: thirdId }))!.state, 'prepared');
    assert.equal((await syncOperations(db).findOne({ _id: thirdId }))!.status, 'pending');
    assert.deepEqual((await syncOperations(db).findOne({ _id: thirdId }))!.results, []);
    // The old lease may leave an immutable uncommitted file; it cannot publish it.
    assert.equal(files.has(thirdIntent.stagedFileId!), true); assert.equal(files.size, 4);
    assert.deepEqual(await economy(), authPaid); assert.equal(allocations, authAlloc);
    mode = 'clear'; const recovered = await call(third);
    assert.equal(recovered.status, 'complete');
    if (recovered.status !== 'complete') throw new Error('synthetic_expected_complete');
    assert.equal(recovered.operation.results[0].seq, 4); assert.equal(recovered.operation.refunded, 0);
    assert.equal(writes, 4); assert.equal(files.size, 4); assert.equal(creates, 13);
    assert.equal(allocations, authAlloc); assert.deepEqual(await economy(), authPaid);
    assert.equal((await journal.findOne({ operationId: thirdId }))!.stagedFileId, thirdIntent.stagedFileId);

    phase = 'terminal_no_sdk_and_actual_http_pull';
    const none = { files: { async generateIds() { throw new Error('terminal_no_allocate'); },
      async create() { throw new Error('terminal_no_create'); }, async get() { throw new Error('terminal_no_read'); } } } as unknown as drive_v3.Drive;
    assert.deepEqual(await runClassifiedRecoveryPush(db, fixture.owner, lease, third, none, parent), recovered);
    assert.deepEqual(await economy(), authPaid);
    await releaseRecoveryLease(db, lease);
    const auth = { authorization: `Bearer ${FIXTURE_TOKENS.a}` };
    const pull = await fetch(`${fixture.origin}/api/notes/pull?after=0`, { headers: auth }); assert.equal(pull.status, 200);
    const page = await pull.json() as { nextCursor: number; rows: { id: string; body: string }[] };
    assert.equal(page.nextCursor, 4); assert.equal(page.rows.length, 4);
    for (const row of [...first.rows, ...second.rows, ...third.rows]) assert.equal(page.rows.find(remote => remote.id === row.id)!.body, row.body);
    const replay = await fetch(`${fixture.origin}/api/notes/push`, { method: 'POST', headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify(third) }); assert.equal(replay.status, 200);
    const receipt = await replay.json() as { results: unknown[]; charged: number; refunded: number };
    assert.deepEqual(receipt.results, recovered.operation.results); assert.equal(receipt.charged, 10); assert.equal(receipt.refunded, 0);
    assert.deepEqual(await economy(), authPaid); assert.equal(files.size, 4);
    phase = 'complete'; passed = true;
  });
