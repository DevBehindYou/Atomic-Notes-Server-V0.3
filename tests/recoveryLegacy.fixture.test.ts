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

test('legacy HTTP writes must not consume a pending recovery operation while completed replay remains available',
  { timeout: 90000 }, async (t) => {
    const codes = ['same_request', 'new_request', 'cloud_wipe', 'completed_receipt'] as const;
    const cases: Record<string, string> = {};
    const httpStatuses: Record<string, number> = {};
    t.after(() => writeFileSync('ci-recovery-legacy-proof.json', JSON.stringify({ version: 1,
      scope: 'disposable legacy HTTP exclusion of pending recovery operations', phase: 'complete',
      cases, httpStatuses, outcome: codes.every((code) => cases[code] === 'pass') ? 'pass' : 'fail' })));
    const files = new Map<string, AtomicFileV1>(); let writes = 0;
    const drive: DriveAdapter = {
      async createNoteFile(_a, _r, _folder, _name, content) {
        const id = randomUUID(); files.set(id, migrateAtomicFile(content)); writes++;
        return { id, headRevisionId: 'synthetic-legacy-revision' };
      },
      async updateNoteFile(_a, _r, id, content) {
        if (!files.has(id)) throw { code: 404 };
        files.set(id, migrateAtomicFile(content)); writes++;
        return { id, headRevisionId: 'synthetic-legacy-revision' };
      },
      async deleteNoteFile(_a, _r, id) { if (!files.delete(id)) throw { code: 404 }; writes++; },
      async getNoteFileContent(_a, _r, id) {
        if (!files.has(id)) throw { code: 404 };
        return structuredClone(files.get(id)!) as unknown as Record<string, unknown>;
      },
      async ensureAppFolders() { return { notesId: 'synthetic-parent' }; },
    };
    const fixture = await startClientFixture(process.env.MONGODB_URI, process.env.MONGODB_DB_NAME, drive);
    t.after(() => fixture.close());
    const { getDb } = await import('../src/db/mongo.js');
    const { collections } = await import('../src/db/collections.js');
    const { acquireRecoveryLease, releaseRecoveryLease } = await import('../src/lib/recoveryGate.js');
    const { beginRecoverySync } = await import('../src/lib/recoveryAdmission.js');
    const { stageRecoveryIntent } = await import('../src/lib/recoveryIntent.js');
    const { commitRecoveryIntents } = await import('../src/lib/recoveryCommit.js');
    const { finishRecoverySync } = await import('../src/lib/recoverySettlement.js');
    const { fingerprintOf, syncOperations } = await import('../src/lib/syncOperation.js');
    const db = await getDb(); assertFixtureCleanup(db.databaseName, fixture.database);
    for (const code of codes) await t.test(code, async (st) => {
      cases[code] = 'fail';
      const userId = code === 'same_request' ? fixture.owner : code === 'new_request' ? fixture.other :
        code === 'cloud_wipe' ? fixture.batchOwner : fixture.encryptedOwner;
      const token = code === 'same_request' ? FIXTURE_TOKENS.a : code === 'new_request' ? FIXTURE_TOKENS.other :
        code === 'cloud_wipe' ? FIXTURE_TOKENS.batch : FIXTURE_TOKENS.encrypted;
      let cleanupLease: (() => Promise<unknown>) | undefined;
      st.after(async () => { await cleanupLease?.(); });
      await collections.googleAccounts(db).updateOne({ userId }, { $set: { driveRootFolderId: 'synthetic-parent' } });
      const lease = await acquireRecoveryLease(db, userId); let released = false;
      cleanupLease = () => released ? Promise.resolve() : releaseRecoveryLease(db, lease);
      const now = new Date(), requestId = randomUUID(), id = randomUUID();
      const content = migrateAtomicFile({ version: 1, id, kind: 'text', title: 'Public synthetic guarded work',
        body: 'Public synthetic immutable body', items: [], pinned: false, encV: 0, payload: null,
        createdAt: now.toISOString(), updatedAt: now.toISOString() });
      const row = remoteNoteRowSchema.parse({ id, kind: 'text', title: content.title, body: content.body,
        items: [], pinned: false, deleted: false, enc_v: 0, payload: null, base_version: 0, created_at: content.createdAt });
      const intent = noteWriteIntentSchema.parse({ _id: `${userId}:${requestId}:${id}`, format: 1,
        userId, noteId: id, requestId, operationId: `${userId}:${requestId}`,
        fingerprint: fingerprintOf([row], 'instant'), expectedVersion: 0, expectedFileId: null, expectedHash: null,
        stagedFileId: `synthetic-legacy-guard-${randomUUID()}`, targetHash: noteContentHash(row),
        targetFlags: { kind: 'text', encV: 0, pinned: false, deleted: false }, wipeEpoch: lease.wipeEpoch,
        leaseToken: lease.token, state: 'prepared', createdAt: now, updatedAt: now,
        committedVersion: null, committedSequence: null, terminalReason: null });
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
      } } as unknown as drive_v3.Drive;
      await beginRecoverySync(db, lease, requestId, [row], 'instant', [intent]);
      await stageRecoveryIntent(db, lease, intent._id, sdk, 'synthetic-parent', content);
      let receipt: Awaited<ReturnType<typeof finishRecoverySync>> | undefined;
      if (code === 'completed_receipt') {
        await commitRecoveryIntents(db, lease, [intent._id], sdk, 'synthetic-parent');
        receipt = await finishRecoverySync(db, lease, intent.operationId);
      }
      await releaseRecoveryLease(db, lease); released = true;
      const snapshot = async () => ({ wallet: await collections.atomicUsers(db).findOne({ _id: userId }),
        ledger: await collections.energyLedger(db).find({ userId: userId }).sort({ _id: 1 }).toArray(),
        operation: await syncOperations(db).findOne({ _id: intent.operationId }),
        operations: await syncOperations(db).find({ userId: userId }).sort({ _id: 1 }).toArray(),
        intent: await db.collection<NoteWriteIntent>('note_write_intents').findOne({ _id: intent._id }),
        notes: await collections.notes(db).find({ userId: userId }).sort({ _id: 1 }).toArray(),
        counter: await db.collection<{ _id: string }>('sync_counters').findOne({ _id: userId }) });
      const before = await snapshot(), beforeFiles = structuredClone(files), beforeWrites = writes;
      const headers = { 'content-type': 'application/json', authorization: `Bearer ${token}` };
      const response = code === 'cloud_wipe'
        ? await fetch(`${fixture.origin}/api/notes`, { method: 'DELETE', headers })
        : await fetch(`${fixture.origin}/api/notes/push`, { method: 'POST', headers,
          body: JSON.stringify({ requestId: code === 'new_request' ? randomUUID() : requestId, mode: 'instant',
            rows: [code === 'new_request' ? { ...row, id: randomUUID() } : row] }) });
      httpStatuses[code] = response.status;
      assert.equal(response.status, code === 'completed_receipt' ? 200 : 409);
      const body = await response.json() as { error?: string; results?: unknown[]; charged?: number; refunded?: number };
      if (code === 'completed_receipt') {
        assert.deepEqual(body.results, receipt!.results); assert.equal(body.charged, 10); assert.equal(body.refunded, 0);
      } else assert.equal(body.error, 'sync_recovery_required');
      assert.deepEqual(await snapshot(), before); assert.deepEqual(files, beforeFiles); assert.equal(writes, beforeWrites);
      // Read-only pulls remain available and cannot settle/refund the operation.
      const pull = await fetch(`${fixture.origin}/api/notes/pull?after=0`, { headers }); assert.equal(pull.status, 200);
      assert.deepEqual(await snapshot(), before); assert.equal(writes, beforeWrites);
      cases[code] = 'pass';
    });
  });
