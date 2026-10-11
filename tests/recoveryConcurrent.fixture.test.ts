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

const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
};

test('inactive recovery bounds eight stages and drains failures before saved-ID resume',
  { timeout: 90000 }, async t => {
    let phase = 'setup', passed = false;
    t.after(() => writeFileSync('ci-recovery-concurrent-proof.json', JSON.stringify({
      version: 1, scope: 'disposable inactive eight-stage drain and saved-generation resume',
      phase, outcome: passed ? 'pass' : 'fail' })));
    const files = new Map<string, AtomicFileV1>();
    const parent = 'synthetic-concurrent-parent';
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
    let active = 0, peak = 0, creates = 0, allocations = 0, calls = 0, settled = false;
    let holds = new Map<string, ReturnType<typeof deferred>>(), eight = deferred();
    let failId: string | undefined, fault = deferred(), holdCreates = true;
    const started: string[] = [];
    const ownedRuns: Promise<unknown>[] = [];
    const drain = () => { holdCreates = false; for (const gate of holds.values()) gate.resolve(); };
    t.after(async () => {
      drain();
      // Owned coordinator futures immediately consume rejection and must drain
      // before closing their lease/database, including assertion-failure paths.
      await Promise.all(ownedRuns);
      try { await releaseRecoveryLease(db, lease); } finally { await fixture.close(); }
    });
    await collections.googleAccounts(db).updateOne({ userId: fixture.owner }, { $set: { driveRootFolderId: parent } });
    const call = async <T>(fn: () => Promise<T>): Promise<T> => {
      calls++; active++; peak = Math.max(peak, active);
      try { return await fn(); } finally { active--; }
    };
    const sdk = { files: {
      async generateIds(params: { count: number }) {
        allocations++;
        return { data: { ids: Array.from({ length: params.count }, () => `synthetic-concurrent-${randomUUID()}`) } };
      },
      async create(params: { requestBody: { id: string }; media: { body: AsyncIterable<unknown> } }) {
        return call(async () => {
          const id = params.requestBody.id; started.push(id); creates++;
          if (holdCreates) {
            const gate = deferred(); holds.set(id, gate);
            if (holds.size === 8) eight.resolve();
            await gate.promise;
          }
          if (id === failId) { fault.resolve(); throw { code: 'ECONNRESET' }; }
          if (files.has(id)) throw { code: 409 };
          let raw = ''; for await (const part of params.media.body) raw += String(part);
          files.set(id, migrateAtomicFile(JSON.parse(raw)));
          return { data: { id } };
        });
      },
      async get(params: { fileId: string; alt?: string }) {
        return call(async () => {
          if (!files.has(params.fileId)) throw { code: 404 };
          return { data: params.alt === 'media' ? structuredClone(files.get(params.fileId)) : {
            id: params.fileId, parents: [parent], mimeType: 'application/json', trashed: false } };
        });
      },
      async update() { throw new Error('must_not_overwrite'); },
      async delete() { throw new Error('must_not_delete'); },
    } } as unknown as drive_v3.Drive;
    const make = () => ({ requestId: randomUUID(), mode: 'instant' as const,
      rows: Array.from({ length: 10 }, (_, i) => ({ id: randomUUID(), kind: 'text' as const,
        title: 'Public synthetic concurrent fixture', body: `Public synthetic body ${i}`,
        items: [], pinned: false, deleted: false, enc_v: 0 as const, payload: null,
        base_version: 0, created_at: new Date().toISOString() })) });
    const journal = db.collection<NoteWriteIntent>('note_write_intents');
    const economic = async () => ({ wallet: await collections.atomicUsers(db).findOne({ _id: fixture.owner }),
      ledger: await collections.energyLedger(db).find({ userId: fixture.owner }).sort({ _id: 1 }).toArray() });
    const notes = () => collections.notes(db).find({ userId: fixture.owner }).sort({ _id: 1 }).toArray();
    const counter = () => db.collection<{ _id: string }>('sync_counters').findOne({ _id: fixture.owner });

    phase = 'eight_stage_ceiling';
    const first = make(), firstId = `${fixture.owner}:${first.requestId}`;
    const firstRun = runClassifiedRecoveryPush(db, fixture.owner, lease, first, sdk, parent)
      .then(result => { settled = true; return { result }; }, error => { settled = true; return { error }; });
    ownedRuns.push(firstRun);
    // Observe actual started SDK calls, rather than elapsed-time assumptions.
    await Promise.race([eight.promise, firstRun.then(finished => {
      if ('error' in finished) throw finished.error;
      throw new Error('synthetic_expected_parked_stages');
    })]);
    assert.equal(active, 8); assert.equal(peak, 8); assert.equal(started.length, 8); assert.equal(settled, false);
    assert.equal((await notes()).length, 0); assert.equal(await counter(), null);
    const firstPending = await syncOperations(db).findOne({ _id: firstId });
    assert.equal(firstPending!.status, 'pending'); assert.deepEqual(firstPending!.results, []);
    assert.equal((await economic()).wallet!.energy, 90);
    assert.equal(await journal.countDocuments({ operationId: firstId, state: 'prepared' }), 10);
    drain();
    const firstFinished = await firstRun;
    if ('error' in firstFinished) throw firstFinished.error;
    const firstComplete = firstFinished.result;
    assert.equal(firstComplete.status, 'complete');
    if (firstComplete.status !== 'complete') throw new Error('synthetic_expected_complete');
    assert.deepEqual(firstComplete.operation.results.map(row => row.id), first.rows.map(row => row.id));
    assert.deepEqual(firstComplete.operation.results.map(row => row.seq), Array.from({ length: 10 }, (_, i) => i + 1));
    assert.equal(firstComplete.operation.refunded, 0); assert.equal(creates, 10); assert.equal(files.size, 10);
    assert.equal(active, 0); assert.equal(peak, 8);

    phase = 'failure_drains_started_calls';
    const second = make(), secondId = `${fixture.owner}:${second.requestId}`;
    holds = new Map(); eight = deferred(); fault = deferred(); holdCreates = true; settled = false;
    started.length = 0;
    const oldNotes = await notes(), oldCounter = await counter();
    const secondRun = runClassifiedRecoveryPush(db, fixture.owner, lease, second, sdk, parent)
      .then(result => { settled = true; return { result }; }, error => { settled = true; return { error }; });
    ownedRuns.push(secondRun);
    await Promise.race([eight.promise, secondRun.then(finished => {
      if ('error' in finished) throw finished.error;
      throw new Error('synthetic_expected_parked_stages');
    })]);
    failId = started[0]; holds.get(failId)!.resolve();
    await fault.promise;
    // Drain already queued continuations without a timing-dependent sleep.
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(settled, false); assert.equal(active, 7); assert.equal(started.length, 8);
    assert.deepEqual(await notes(), oldNotes); assert.deepEqual(await counter(), oldCounter);
    assert.deepEqual((await syncOperations(db).findOne({ _id: secondId }))!.results, []);
    drain();
    const failed = await secondRun;
    if (!('error' in failed)) throw new Error('synthetic_expected_stage_failure');
    assert.equal((failed.error as { code?: string }).code, 'ECONNRESET');
    assert.equal(active, 0); assert.equal(peak, 8); assert.equal(started.length, 8);
    assert.deepEqual(await notes(), oldNotes); assert.deepEqual(await counter(), oldCounter);
    const pending = await syncOperations(db).findOne({ _id: secondId });
    assert.equal(pending!.status, 'pending'); assert.equal(pending!.charged, 10); assert.equal(pending!.refunded, 0);
    assert.deepEqual(pending!.results, []);
    assert.equal(await journal.countDocuments({ operationId: secondId, state: 'verified' }), 7);
    assert.equal(await journal.countDocuments({ operationId: secondId, state: 'prepared' }), 3);
    const savedIds = (await journal.find({ operationId: secondId }).sort({ _id: 1 }).toArray()).map(row => row.stagedFileId);
    const savedEconomy = await economic(), beforeCalls = calls;
    assert.equal(savedEconomy.wallet!.energy, 80); assert.equal(files.size, 17);

    phase = 'stale_lease_then_saved_id_resume';
    const obsolete = lease; await releaseRecoveryLease(db, lease); lease = await acquireRecoveryLease(db, fixture.owner);
    await assert.rejects(runClassifiedRecoveryPush(db, fixture.owner, obsolete, second, sdk, parent), /recovery_fence_lost/);
    assert.equal(calls, beforeCalls); assert.deepEqual(await economic(), savedEconomy);
    failId = undefined;
    const recovered = await runClassifiedRecoveryPush(db, fixture.owner, lease, second, sdk, parent);
    assert.equal(recovered.status, 'complete');
    if (recovered.status !== 'complete') throw new Error('synthetic_expected_complete');
    assert.deepEqual(recovered.operation.results.map(row => row.id), second.rows.map(row => row.id));
    assert.deepEqual(recovered.operation.results.map(row => row.seq), Array.from({ length: 10 }, (_, i) => i + 11));
    assert.equal(recovered.operation.refunded, 0); assert.equal(allocations, 2); assert.equal(creates, 21);
    assert.equal(files.size, 20); assert.equal(active, 0); assert.ok(peak <= 8);
    assert.deepEqual((await journal.find({ operationId: secondId }).sort({ _id: 1 }).toArray()).map(row => row.stagedFileId), savedIds);
    assert.deepEqual(await economic(), savedEconomy);

    phase = 'terminal_replay';
    const noSdk = { files: {
      async generateIds() { throw new Error('terminal_must_not_allocate'); },
      async create() { throw new Error('terminal_must_not_create'); },
      async get() { throw new Error('terminal_must_not_read'); },
    } } as unknown as drive_v3.Drive;
    assert.deepEqual(await runClassifiedRecoveryPush(db, fixture.owner, lease, second, noSdk, parent), recovered);
    assert.deepEqual(await economic(), savedEconomy);
    await releaseRecoveryLease(db, lease);
    const auth = { authorization: `Bearer ${FIXTURE_TOKENS.a}` };
    phase = 'actual_http_paginated_pull';
    const response = await fetch(`${fixture.origin}/api/notes/pull?after=0`, { headers: auth });
    assert.equal(response.status, 200);
    const page = await response.json() as { nextCursor: number; hasMore: boolean; rows: { id: string; body: string }[] };
    assert.equal(page.nextCursor, 10); assert.equal(page.hasMore, true); assert.equal(page.rows.length, 10);
    const nextResponse = await fetch(`${fixture.origin}/api/notes/pull?after=${page.nextCursor}`, { headers: auth });
    assert.equal(nextResponse.status, 200);
    const nextPage = await nextResponse.json() as typeof page;
    assert.equal(nextPage.nextCursor, 20); assert.equal(nextPage.hasMore, false); assert.equal(nextPage.rows.length, 10);
    const pulled = [...page.rows, ...nextPage.rows];
    assert.equal(new Set(pulled.map(row => row.id)).size, 20);
    for (const row of [...first.rows, ...second.rows]) assert.equal(pulled.find(remote => remote.id === row.id)!.body, row.body);
    phase = 'actual_http_push_replay';
    const replay = await fetch(`${fixture.origin}/api/notes/push`, { method: 'POST',
      headers: { ...auth, 'content-type': 'application/json' }, body: JSON.stringify(second) });
    assert.equal(replay.status, 200);
    const receipt = await replay.json() as { results: unknown[]; charged: number; refunded: number };
    assert.deepEqual(receipt.results, recovered.operation.results); assert.equal(receipt.charged, 10); assert.equal(receipt.refunded, 0);
    assert.deepEqual(await economic(), savedEconomy); assert.equal(files.size, 20);
    phase = 'complete'; passed = true;
  });
