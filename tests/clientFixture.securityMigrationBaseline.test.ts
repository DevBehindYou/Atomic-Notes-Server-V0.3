import assert from 'node:assert/strict';
import test from 'node:test';
import { createCipheriv, randomBytes, randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import type { AtomicUserDoc, EnergyLedgerDoc, NoteDoc } from '../src/db/collections.js';
import type { SyncOperation } from '../src/lib/syncOperation.js';
import { FIXTURE_TOKENS, startClientFixture } from './clientFixture.js';
import { assertFixtureCleanup } from './clientFixtureSafety.js';

type Receipt = { charged: number; refunded: number; results: { id: string; ok: boolean; version: number }[] };
type Page = { nextCursor: number; rows: { id: string; title: string; body: string; items: unknown[];
  enc_v: number; payload: string | null; version: number }[] };

test('legacy paid-policy baseline: zero-Energy plaintext-to-encrypted replacement is refused without mutation',
  { timeout: 60000 }, async t => {
    let phase = 'setup', selectedMode = 'none', passed = false;
    t.after(() => writeFileSync('ci-security-migration-baseline-proof.json', JSON.stringify({ version: 1,
      scope: 'disposable legacy paid security migration baseline', phase, mode: selectedMode,
      outcome: passed ? 'pass' : 'fail' })));
    const starting = startClientFixture(process.env.MONGODB_URI, process.env.MONGODB_DB_NAME);
    // Register cleanup before asynchronous setup: a setup timeout must still
    // close the generated fixture if initialization eventually completes.
    t.after(async () => { const opened = await starting.catch(() => undefined); await opened?.close(); });
    const fixture = await starting;
    t.signal.throwIfAborted();
    const { getDb } = await import('../src/db/mongo.js');
    const db = await getDb(); assertFixtureCleanup(db.databaseName, fixture.database);
    const call = (path: string, body?: object) => fetch(`${fixture.origin}${path}`, {
      method: body ? 'POST' : 'GET',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${FIXTURE_TOKENS.a}` },
      body: body ? JSON.stringify(body) : undefined,
    });
    const state = async () => await (await call('/__fixture/state')).json();
    const snapshot = async () => ({
      wallet: await db.collection<AtomicUserDoc>('atomic_users').findOne({ _id: fixture.owner }),
      ledger: await db.collection<EnergyLedgerDoc>('energy_ledger').find({ userId: fixture.owner }).sort({ _id: 1 }).toArray(),
      notes: await db.collection<NoteDoc>('notes').find({ userId: fixture.owner }).sort({ _id: 1 }).toArray(),
      operations: await db.collection<SyncOperation>('sync_operations').find({ userId: fixture.owner }).sort({ _id: 1 }).toArray(),
      counter: await db.collection<{ _id: string; value: number }>('sync_counters').findOne({ _id: fixture.owner }),
    });
    // Fixture-only preconditions in the generated database. A fresh grant
    // timestamp prevents daily refill from disguising zero-Energy admission.
    const setEnergy = async (energy: number) => {
      const changed = await db.collection<AtomicUserDoc>('atomic_users').updateOne({ _id: fixture.owner },
        { $set: { energy, lastDailyGrantAt: new Date(), lastStandardSyncAt: null } });
      assert.equal(changed.matchedCount, 1);
    };
    for (const mode of ['standard', 'instant'] as const) {
      selectedMode = mode;
      const cost = mode === 'standard' ? 5 : 10;
      await setEnergy(100);
      const id = randomUUID();
      const content = { title: 'Public synthetic migration title', body: 'Public synthetic preserved plaintext', items: [] };
      const plain = { id, kind: 'text', ...content, pinned: false, deleted: false, enc_v: 0,
        payload: null, base_version: 0, created_at: new Date().toISOString() };
      phase = 'seed_plaintext';
      const seed = await call('/api/notes/push', { requestId: randomUUID(), mode: 'instant', rows: [plain] });
      assert.equal(seed.status, 200); await seed.arrayBuffer();
      const original = await db.collection<NoteDoc>('notes').findOne({ _id: id });
      assert.ok(original); assert.equal(original.encV, 0); assert.ok(original.localVersion > 0);
      const targetVersion = original.localVersion + 1;

      const nonce = randomBytes(12), key = Buffer.alloc(32, 7);
      const cipher = createCipheriv('aes-256-gcm', key, nonce);
      const ciphertext = Buffer.concat([cipher.update(JSON.stringify(content)), cipher.final()]);
      const payload = Buffer.concat([nonce, ciphertext, cipher.getAuthTag()]).toString('base64');
      const request = { requestId: randomUUID(), mode, rows: [{ ...plain, title: '', body: '', items: [],
        enc_v: 1, payload, base_version: original.localVersion }] };

      await setEnergy(0);
      const before = await snapshot(), driveBefore = await state();
      assert.equal(before.wallet!.energy, 0);
      phase = 'zero_energy_refused';
      for (let retry = 0; retry < 2; retry++) {
        const refused = await call('/api/notes/push', request);
        assert.equal(refused.status, 409);
        assert.deepEqual(await refused.json(), { error: 'insufficient_energy' });
        assert.deepEqual(await snapshot(), before);
        assert.deepEqual(await state(), driveBefore);
      }

      phase = 'free_pull_preserves_plaintext';
      const pull = await call('/api/notes/pull?after=0'); assert.equal(pull.status, 200);
      const page = await pull.json() as Page;
      const remote = page.rows.find(row => row.id === id); assert.ok(remote);
      assert.equal(remote.enc_v, 0); assert.equal(remote.payload, null); assert.equal(remote.version, original.localVersion);
      assert.equal(remote.title, content.title); assert.equal(remote.body, content.body); assert.deepEqual(remote.items, content.items);
      assert.deepEqual(await snapshot(), before);

      phase = 'funded_same_request_control';
      await setEnergy(cost);
      const fundedBefore = await snapshot();
      const funded = await call('/api/notes/push', request); assert.equal(funded.status, 200);
      const receipt = await funded.json() as Receipt;
      assert.equal(receipt.charged, cost); assert.equal(receipt.refunded, 0);
      assert.equal(receipt.results.length, 1); assert.equal(receipt.results[0].id, id);
      assert.equal(receipt.results[0].ok, true); assert.equal(receipt.results[0].version, targetVersion);
      const after = await snapshot();
      assert.equal(after.wallet!.energy, 0);
      assert.equal(after.ledger.length, fundedBefore.ledger.length + 1);
      const spend = after.ledger.find(entry => !fundedBefore.ledger.some(old => old._id === entry._id));
      assert.ok(spend); assert.equal(spend.kind, 'spend'); assert.equal(spend.energyDelta, -cost);
      assert.equal(after.operations.length, fundedBefore.operations.length + 1);
      const operation = after.operations.find(entry => entry._id === `${fixture.owner}:${request.requestId}`);
      assert.ok(operation); assert.equal(operation.status, 'complete'); assert.equal(operation.charged, cost);
      const encrypted = after.notes.find(note => note._id === id); assert.ok(encrypted);
      assert.equal(encrypted.encV, 1); assert.equal(encrypted.localVersion, targetVersion);
      assert.equal(encrypted.driveFileId, original.driveFileId);
      for (const field of ['title', 'body', 'items', 'payload']) assert.equal(Object.hasOwn(encrypted, field), false);

      phase = 'zero_energy_receipt_replay';
      const driveAfter = await state();
      const replay = await call('/api/notes/push', request); assert.equal(replay.status, 200);
      assert.deepEqual(await replay.json(), receipt);
      assert.deepEqual(await snapshot(), after); assert.deepEqual(await state(), driveAfter);
      phase = 'free_pull_reads_encrypted_replacement';
      const encryptedPull = await call('/api/notes/pull?after=0'); assert.equal(encryptedPull.status, 200);
      const encryptedPage = await encryptedPull.json() as Page;
      const readback = encryptedPage.rows.find(row => row.id === id); assert.ok(readback);
      assert.equal(readback.enc_v, 1); assert.equal(readback.version, targetVersion); assert.equal(readback.payload, payload);
      assert.equal(readback.title, ''); assert.equal(readback.body, ''); assert.deepEqual(readback.items, []);
      assert.deepEqual(await snapshot(), after);
    }
    phase = 'complete'; passed = true;
  });
