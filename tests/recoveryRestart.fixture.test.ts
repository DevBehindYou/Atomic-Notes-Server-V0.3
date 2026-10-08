import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import type { DriveAdapter } from '../src/routes/notes.js';
import { migrateAtomicFile, type AtomicFileV1 } from '../src/types/atomicFile.js';
import { startClientFixture, FIXTURE_TOKENS } from './clientFixture.js';
import { assertFixtureCleanup } from './clientFixtureSafety.js';

test('inactive journal survives killed workers at prepare, verify, commit and settlement without another charge or generation', { timeout: 90000 }, async (t) => {
  let phase = 'setup', passed = false, writes = 0;
  t.after(() => writeFileSync('ci-recovery-restart-proof.json', JSON.stringify({ version: 1,
    scope: 'disposable inactive killed worker and restart checkpoints', phase, outcome: passed ? 'pass' : 'fail' })));
  assert.equal(process.platform, 'linux');
  const files = new Map<string, AtomicFileV1>(), workers = new Set<ChildProcess>();
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
  const driveServer = createServer((request, response) => {
    void (async () => {
      const url = new URL(request.url!, 'http://127.0.0.1'), id = decodeURIComponent(url.pathname.slice('/files/'.length));
      if (!url.pathname.startsWith('/files/') || !id) { response.writeHead(404).end(); return; }
      if (request.method === 'POST') {
        if (files.has(id)) { response.writeHead(409).end(); return; }
        let raw = ''; for await (const part of request) {
          raw += String(part); if (raw.length > 4096) throw new Error('synthetic_body_bound');
        }
        files.set(id, migrateAtomicFile(JSON.parse(raw))); writes++;
        response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ id })); return;
      }
      if (request.method !== 'GET' || !files.has(id)) { response.writeHead(404).end(); return; }
      response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(url.searchParams.has('media') ? files.get(id) :
        { id, parents: ['synthetic-parent'], mimeType: 'application/json', trashed: false }));
    })().catch(() => { response.writeHead(500).end(); });
  });
  t.after(async () => {
    await Promise.all([...workers].map(async (worker) => {
      const exited = once(worker, 'exit').catch(() => undefined);
      worker.kill('SIGKILL'); await exited;
    }));
    try {
      driveServer.closeAllConnections();
      await new Promise<void>((resolve) => driveServer.close(() => resolve()));
    } finally { await fixture.close(); }
  });
  driveServer.listen(0, '127.0.0.1'); await once(driveServer, 'listening');
  const address = driveServer.address(); assert.ok(address && typeof address !== 'string');
  const driveOrigin = `http://127.0.0.1:${address.port}`;
  const { getDb } = await import('../src/db/mongo.js');
  const { collections } = await import('../src/db/collections.js');
  const { syncOperations } = await import('../src/lib/syncOperation.js');
  const db = await getDb(); assertFixtureCleanup(db.databaseName, fixture.database);
  await collections.googleAccounts(db).updateOne({ userId: fixture.owner }, { $set: { driveRootFolderId: 'synthetic-parent' } });
  const requestId = randomUUID(), noteIds = [randomUUID(), randomUUID()], createdAt = new Date().toISOString();
  const operationId = `${fixture.owner}:${requestId}`;
  const journal = db.collection<{ _id: string; operationId: string; state: string; stagedFileId: string }>('note_write_intents');
  const counters = db.collection<{ _id: string; value: number }>('sync_counters');
  const initialLedger = await collections.energyLedger(db).countDocuments({ userId: fixture.owner });
  const invoke = async (selected: 'prepared' | 'verified' | 'committed' | 'settled' | 'replayed', terminate = true) => {
    const worker = spawn(process.execPath, ['--import', 'tsx', fileURLToPath(new URL('./recoveryRestart.worker.ts', import.meta.url))], {
      cwd: process.cwd(), stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
      env: { PATH: process.env.PATH, MONGODB_URI: process.env.MONGODB_URI, MONGODB_DB_NAME: fixture.database },
    });
    workers.add(worker);
    const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
      worker.once('exit', (code, signal) => { workers.delete(worker); resolve({ code, signal }); });
    });
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { worker.kill('SIGKILL'); reject(new Error('synthetic_worker_deadline')); }, 15000);
      worker.once('error', () => { clearTimeout(timer); reject(new Error('synthetic_worker_start')); });
      worker.once('exit', () => { clearTimeout(timer); reject(new Error('synthetic_worker_early_exit')); });
      worker.once('message', (message: unknown) => {
        clearTimeout(timer);
        if (typeof message !== 'object' || message === null || !('phase' in message) || message.phase !== selected) {
          worker.kill('SIGKILL'); reject(new Error('synthetic_worker_phase')); return;
        }
        resolve();
      });
      worker.send({ phase: selected, database: fixture.database, owner: fixture.owner, requestId, noteIds, createdAt, driveOrigin });
    });
    if (terminate) assert.equal(worker.kill('SIGKILL'), true);
    const result = await exited;
    assert.equal(result.code, terminate ? null : 0); assert.equal(result.signal, terminate ? 'SIGKILL' : null);
  };
  phase = 'kill_prepared'; await invoke('prepared');
  assert.equal(writes, 0); assert.equal(files.size, 0);
  assert.equal((await collections.atomicUsers(db).findOne({ _id: fixture.owner }))!.energy, 90);
  const prepared = await journal.find({ operationId }).sort({ _id: 1 }).toArray();
  assert.equal(prepared.length, 2); assert.equal(prepared.every((row) => row.state === 'prepared'), true);
  const retainedIds = prepared.map((row) => row.stagedFileId);
  phase = 'kill_verified'; await invoke('verified');
  const verified = await journal.find({ operationId }).sort({ _id: 1 }).toArray();
  assert.equal(verified.every((row) => row.state === 'verified'), true);
  assert.deepEqual(verified.map((row) => row.stagedFileId), retainedIds); assert.equal(writes, 2);
  assert.equal(await collections.notes(db).countDocuments({ userId: fixture.owner }), 0);
  phase = 'kill_committed'; await invoke('committed');
  const committed = await journal.find({ operationId }).sort({ _id: 1 }).toArray();
  assert.equal(committed.every((row) => row.state === 'committed'), true);
  assert.deepEqual(committed.map((row) => row.stagedFileId), retainedIds);
  assert.equal((await counters.findOne({ _id: fixture.owner }))!.value, 2);
  assert.equal((await syncOperations(db).findOne({ _id: operationId }))!.status, 'pending');
  assert.equal((await syncOperations(db).findOne({ _id: operationId }))!.results.length, 2);
  phase = 'kill_settled'; await invoke('settled');
  const completed = (await syncOperations(db).findOne({ _id: operationId }))!;
  assert.equal(completed.status, 'complete'); assert.equal(completed.charged, 10); assert.equal(completed.refunded, 0);
  assert.equal(writes, 2); assert.equal(files.size, 2);
  phase = 'restart_replay'; await invoke('replayed', false);
  assert.deepEqual(await syncOperations(db).findOne({ _id: operationId }), completed);
  assert.equal((await collections.atomicUsers(db).findOne({ _id: fixture.owner }))!.energy, 90);
  assert.equal(await collections.energyLedger(db).countDocuments({ userId: fixture.owner }), initialLedger + 1);
  assert.equal((await counters.findOne({ _id: fixture.owner }))!.value, 2);
  phase = 'actual_pull_replay';
  const auth = { authorization: `Bearer ${FIXTURE_TOKENS.a}`, 'content-type': 'application/json' };
  const response = await fetch(`${fixture.origin}/api/notes/pull?after=0`, { headers: auth }); assert.equal(response.status, 200);
  const page = await response.json() as { rows: { id: string; body: string; version: number }[]; nextCursor: number };
  assert.equal(page.rows.length, 2); assert.equal(page.nextCursor, 2);
  for (let i = 0; i < noteIds.length; i++) {
    const row = page.rows.find((item) => item.id === noteIds[i])!; assert.ok(row);
    assert.equal(row.body, `Public synthetic restart body ${i}`); assert.equal(row.version, i + 1);
  }
  const finalNotes = await collections.notes(db).find({ userId: fixture.owner }).sort({ _id: 1 }).toArray();
  const replay = await fetch(`${fixture.origin}/api/notes/push`, { method: 'POST', headers: auth,
    body: JSON.stringify({ requestId, mode: 'instant', rows: noteIds.map((id, i) => ({ id, kind: 'text', title: 'Public synthetic restart',
      body: `Public synthetic restart body ${i}`, items: [], pinned: false, deleted: false, enc_v: 0, payload: null,
      base_version: 0, created_at: createdAt })) }) });
  assert.equal(replay.status, 200);
  const receipt = await replay.json() as { results: unknown[]; charged: number; refunded: number };
  assert.deepEqual(receipt.results, completed.results); assert.equal(receipt.charged, 10); assert.equal(receipt.refunded, 0);
  assert.deepEqual(await collections.notes(db).find({ userId: fixture.owner }).sort({ _id: 1 }).toArray(), finalNotes);
  assert.equal(await collections.energyLedger(db).countDocuments({ userId: fixture.owner }), initialLedger + 1);
  assert.equal((await collections.atomicUsers(db).findOne({ _id: fixture.owner }))!.energy, 90);
  assert.equal(writes, 2); assert.equal(files.size, 2);
  phase = 'complete'; passed = true;
});
