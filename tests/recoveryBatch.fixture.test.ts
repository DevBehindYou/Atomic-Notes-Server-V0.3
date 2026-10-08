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
import { startClientFixture, FIXTURE_TOKENS } from './clientFixture.js';
import { assertFixtureCleanup } from './clientFixtureSafety.js';

test('inactive fifty-row mixed batch rolls back atomically, commits ordered sequences and replays one charge', { timeout: 60000 }, async (t) => {
  let phase = 'setup', passed = false, writes = 0;
  t.after(() => writeFileSync('ci-recovery-batch-proof.json', JSON.stringify({ version: 1,
    scope: 'disposable inactive fifty row atomic batch and paged pull', phase, outcome: passed ? 'pass' : 'fail' })));
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
  const { stageRecoveryIntent } = await import('../src/lib/recoveryIntent.js');
  const { commitRecoveryIntents } = await import('../src/lib/recoveryCommit.js');
  const { finishRecoverySync } = await import('../src/lib/recoverySettlement.js');
  const db = await getDb(); assertFixtureCleanup(db.databaseName, fixture.database);
  const lease = await acquireRecoveryLease(db, fixture.owner);
  cleanupLease = () => releaseRecoveryLease(db, lease);
  await collections.googleAccounts(db).updateOne({ userId: fixture.owner }, { $set: { driveRootFolderId: 'synthetic-parent' } });
  const journal = db.collection<NoteWriteIntent>('note_write_intents');
  const counters = db.collection<{ _id: string; value: number }>('sync_counters');
  const now = new Date();
  const sdk = { files: {
    async create(params: { requestBody: { id: string }; media: { body: AsyncIterable<unknown> } }) {
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
  const content = (i: number) => migrateAtomicFile({ version: 1, id: randomUUID(),
    kind: i % 3 === 1 ? 'todo' : 'text', title: i % 3 === 2 ? '' : `Public synthetic batch ${i}`,
    body: i % 3 === 0 ? `Public synthetic batch body ${i}` : '',
    items: i % 3 === 1 ? [{ text: `Public synthetic checklist ${i}`, done: i % 2 === 0 }] : [],
    pinned: i % 2 === 0, encV: i % 3 === 2 ? 1 : 0,
    // Opaque schema-valid public test payload, not native encryption proof.
    payload: i % 3 === 2 ? `public-synthetic-envelope-${i}` : null,
    createdAt: now.toISOString(), updatedAt: now.toISOString() });
  const make = async (targets: AtomicFileV1[]) => {
    const requestId = randomUUID();
    const preimages = await Promise.all(targets.map((file) => collections.notes(db).findOne({ _id: file.id })));
    const rows = targets.map((file, i) => remoteNoteRowSchema.parse({ id: file.id, kind: file.kind, title: file.title,
      body: file.body, items: file.items, pinned: file.pinned, deleted: false, enc_v: file.encV, payload: file.payload,
      base_version: preimages[i]?.localVersion ?? 0, created_at: file.createdAt }));
    const intents = rows.map((row, i) => noteWriteIntentSchema.parse({ _id: `${fixture.owner}:${requestId}:${row.id}`,
      format: 1, userId: fixture.owner, noteId: row.id, requestId, operationId: `${fixture.owner}:${requestId}`,
      fingerprint: fingerprintOf(rows, 'instant'), expectedVersion: row.base_version,
      expectedFileId: preimages[i]?.driveFileId ?? null, expectedHash: preimages[i]?.contentHash ?? null,
      stagedFileId: `synthetic-${randomUUID()}`, targetHash: noteContentHash(row),
      targetFlags: { kind: row.kind, encV: row.enc_v, pinned: row.pinned, deleted: false }, wipeEpoch: lease.wipeEpoch,
      leaseToken: lease.token, state: 'prepared', createdAt: now, updatedAt: now,
      committedVersion: null, committedSequence: null, terminalReason: null }));
    return { requestId, targets, rows, intents, operationId: intents[0].operationId };
  };
  const admitAndStage = async (request: Awaited<ReturnType<typeof make>>) => {
    await beginRecoverySync(db, lease, request.requestId, request.rows, 'instant', request.intents);
    for (let i = 0; i < request.intents.length; i++) {
      await stageRecoveryIntent(db, lease, request.intents[i]._id, sdk, 'synthetic-parent', request.targets[i]);
    }
  };
  const snapshot = async () => ({
    notes: await collections.notes(db).find({ userId: fixture.owner }).sort({ _id: 1 }).toArray(),
    counter: await counters.findOne({ _id: fixture.owner }),
    operations: await syncOperations(db).find({ userId: fixture.owner }).sort({ _id: 1 }).toArray(),
    intents: await journal.find({ userId: fixture.owner }).sort({ _id: 1 }).toArray(),
    wallet: await collections.atomicUsers(db).findOne({ _id: fixture.owner }),
    ledger: await collections.energyLedger(db).find({ userId: fixture.owner }).sort({ _id: 1 }).toArray(),
  });
  const originals = Array.from({ length: 15 }, (_, i) => content(i));
  const initial = await make(originals); await admitAndStage(initial);
  await commitRecoveryIntents(db, lease, initial.intents.map((row) => row._id), sdk, 'synthetic-parent');
  const seedReceipt = await finishRecoverySync(db, lease, initial.operationId);
  const changed = originals.map((file) => ({ ...file, pinned: !file.pinned,
    title: file.encV === 1 ? '' : `${file.title} changed`, body: file.kind === 'text' && file.encV === 0 ? `${file.body} changed` : '',
    items: file.kind === 'todo' ? file.items.map((item) => ({ ...item, done: !item.done })) : [],
    payload: file.encV === 1 ? `${file.payload}-changed` : null }));
  const targets = [...changed, ...Array.from({ length: 35 }, (_, i) => content(i + 15))];
  phase = 'bounded_admission';
  const oversized = await make([...targets, content(50)]), beforeInvalid = await snapshot();
  await assert.rejects(beginRecoverySync(db, lease, oversized.requestId, oversized.rows, 'instant', oversized.intents),
    (error: unknown) => error instanceof Error && error.name === 'ZodError');
  assert.deepEqual(await snapshot(), beforeInvalid); assert.equal(writes, 15);
  const request = await make(targets); await admitAndStage(request);
  const before = await snapshot(), beforeFiles = structuredClone([...files]);
  assert.equal(before.wallet!.energy, 80); assert.equal(before.ledger.length, 2); assert.equal(writes, 65);
  assert.equal(before.counter!.value, 15); assert.equal(before.notes.length, 15);
  phase = 'metadata_rejection';
  await db.command({ collMod: 'notes', validator: { _id: { $ne: targets[49].id } }, validationLevel: 'strict', validationAction: 'error' });
  await assert.rejects(commitRecoveryIntents(db, lease, request.intents.map((row) => row._id), sdk, 'synthetic-parent'),
    (error: unknown) => typeof error === 'object' && error !== null && 'code' in error && error.code === 121);
  assert.deepEqual(await snapshot(), before); assert.deepEqual([...files], beforeFiles);
  await db.command({ collMod: 'notes', validator: {}, validationLevel: 'strict', validationAction: 'error' });
  phase = 'post_write_rollback';
  await assert.rejects(commitRecoveryIntents(db, lease, request.intents.map((row) => row._id), sdk, 'synthetic-parent', async () => {
    throw new Error('synthetic_fifty_row_barrier');
  }), /synthetic_fifty_row_barrier/);
  assert.deepEqual(await snapshot(), before); assert.deepEqual([...files], beforeFiles);
  phase = 'ordered_commit';
  const saved = await commitRecoveryIntents(db, lease, request.intents.map((row) => row._id), sdk, 'synthetic-parent');
  assert.equal(saved.size, 50);
  for (let i = 0; i < targets.length; i++) {
    const note = saved.get(targets[i].id)!;
    assert.equal(note.syncSequence, i + 16); assert.equal(note.localVersion, i < 15 ? i + 2 : i + 16);
    const intent = (await journal.findOne({ _id: request.intents[i]._id }))!;
    assert.equal(intent.state, 'committed'); assert.equal(intent.committedVersion, note.localVersion);
    assert.equal(intent.committedSequence, note.syncSequence);
  }
  const receipt = await finishRecoverySync(db, lease, request.operationId);
  assert.equal(receipt.results.length, 50); assert.equal(receipt.charged, 10); assert.equal(receipt.refunded, 0);
  assert.deepEqual(receipt.results.map((row) => row.id), targets.map((file) => file.id));
  const after = await snapshot(); assert.equal(after.wallet!.energy, 80); assert.equal(after.ledger.length, 2);
  assert.equal(after.counter!.value, 65); assert.equal(after.notes.length, 50); assert.equal(writes, 65);
  for (let i = 0; i < originals.length; i++) assert.deepEqual(files.get(initial.intents[i].stagedFileId!), originals[i]);
  await releaseRecoveryLease(db, lease); cleanupLease = undefined;
  phase = 'paged_pull';
  const auth = { authorization: `Bearer ${FIXTURE_TOKENS.a}`, 'content-type': 'application/json' };
  let cursor = 15, pages = 0;
  const received = new Set<string>();
  while (cursor < 65) {
    const response = await fetch(`${fixture.origin}/api/notes/pull?after=${cursor}`, { headers: auth });
    assert.equal(response.status, 200);
    const page = await response.json() as { rows: { id: string; kind: string; title: string; body: string;
      items: unknown[]; pinned: boolean; enc_v: number; payload: string | null; version: number }[]; nextCursor: number; hasMore: boolean };
    assert.equal(page.rows.length, 10); assert.equal(page.nextCursor, cursor + 10);
    assert.equal(page.hasMore, page.nextCursor < 65);
    for (const row of page.rows) {
      const expected = targets.find((file) => file.id === row.id)!; assert.ok(expected); assert.equal(received.has(row.id), false);
      received.add(row.id);
      assert.equal(row.kind, expected.kind); assert.equal(row.title, expected.title); assert.equal(row.body, expected.body);
      assert.deepEqual(row.items, expected.items); assert.equal(row.pinned, expected.pinned); assert.equal(row.enc_v, expected.encV);
      assert.equal(row.payload, expected.payload); assert.equal(row.version, saved.get(row.id)!.localVersion);
    }
    cursor = page.nextCursor; pages++;
  }
  assert.equal(received.size, 50); assert.equal(pages, 5);
  phase = 'actual_replay';
  const final = await snapshot(), finalFiles = structuredClone([...files]);
  for (const [sent, expected] of [[initial, seedReceipt], [request, receipt]] as const) {
    const response = await fetch(`${fixture.origin}/api/notes/push`, { method: 'POST', headers: auth,
      body: JSON.stringify({ requestId: sent.requestId, mode: 'instant', rows: sent.rows }) });
    assert.equal(response.status, 200);
    const body = await response.json() as { results: unknown[]; charged: number; refunded: number };
    assert.deepEqual(body.results, expected.results); assert.equal(body.charged, 10); assert.equal(body.refunded, 0);
  }
  assert.deepEqual(await snapshot(), final); assert.deepEqual([...files], finalFiles); assert.equal(writes, 65);
  phase = 'complete'; passed = true;
});
