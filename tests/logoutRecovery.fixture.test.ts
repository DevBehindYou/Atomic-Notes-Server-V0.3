import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash, randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { startClientFixture, FIXTURE_TOKENS } from './clientFixture.js';
import { assertFixtureCleanup } from './clientFixtureSafety.js';
import { logoutBatchFingerprint } from '../src/lib/logoutContract.js';
import { remoteNoteRowSchema } from '../src/types/noteWire.js';

test('inactive read-only logout recovery refuses uncertain or foreign receipts without mutation',
  { timeout: 60000 }, async t => {
    let phase = 'setup', passed = false;
    t.after(() => writeFileSync('ci-logout-recovery-proof.json', JSON.stringify({ version: 1,
      scope: 'disposable inactive read-only logout recovery preflight', phase, outcome: passed ? 'pass' : 'fail' })));
    const fixture = await startClientFixture(process.env.MONGODB_URI, process.env.MONGODB_DB_NAME);
    t.after(() => fixture.close());
    const { getDb } = await import('../src/db/mongo.js');
    const { collections } = await import('../src/db/collections.js');
    const { admitLogoutAttempt, openLogoutBatch, settleLogoutBatch, logoutAttempts } = await import('../src/lib/logoutAttempt.js');
    const { syncOperations, recordSyncResult } = await import('../src/lib/syncOperation.js');
    const { inspectLogoutRecovery } = await import('../src/lib/logoutRecovery.js');
    const db = await getDb(); assertFixtureCleanup(db.databaseName, fixture.database);
    await db.createCollection('logout_attempts');
    // Only this owned namespace: make explicit expiry/removal proofs independent
    // of the background TTL monitor's timing. Never alter production indexes.
    await collections.sessions(db).dropIndex('expiresAt_1');
    const attemptId = randomUUID();
    const groups = Array.from({ length: 2 }, () => {
      const requestId = randomUUID(), rows = [remoteNoteRowSchema.parse({ id: randomUUID(), kind: 'text',
        title: 'Public synthetic recovery', body: 'Public synthetic fixture only', items: [], pinned: false,
        deleted: false, created_at: new Date().toISOString(), enc_v: 0, payload: null, base_version: 0 })];
      return { requestId, rows, manifest: { requestId, fingerprint: logoutBatchFingerprint(rows), rowIds: rows.map(r => r.id),
        wireBytes: Buffer.byteLength(JSON.stringify({ rows, requestId, mode: 'instant', logoutAttemptId: attemptId })) } };
    });
    const batches = groups.map(group => group.manifest), id = `${fixture.owner}:${attemptId}`;
    const oldHash = createHash('sha256').update(FIXTURE_TOKENS.a).digest('hex');
    const newHash = createHash('sha256').update(FIXTURE_TOKENS.b).digest('hex');
    const snapshot = async () => ({
      wallets: await collections.atomicUsers(db).find({}).sort({ _id: 1 }).toArray(),
      ledger: await collections.energyLedger(db).find({}).sort({ _id: 1 }).toArray(),
      sessions: await collections.sessions(db).find({}).sort({ _id: 1 }).toArray(),
      attempts: await logoutAttempts(db).find({}).sort({ _id: 1 }).toArray(),
      operations: await syncOperations(db).find({}).sort({ _id: 1 }).toArray(),
      notes: await collections.notes(db).find({}).sort({ _id: 1 }).toArray(),
    });
    const inspect = () => inspectLogoutRecovery(db, fixture.owner, FIXTURE_TOKENS.b, attemptId, oldHash, batches);
    const refuse = async (operation: () => Promise<unknown>, code: RegExp) => {
      const before = await snapshot(); await assert.rejects(operation(), code);
      assert.deepEqual(await snapshot(), before);
    };
    await collections.atomicUsers(db).updateOne({ _id: fixture.owner }, { $set: { energy: 0 } });
    await admitLogoutAttempt(db, fixture.owner, FIXTURE_TOKENS.a, attemptId, batches);
    const receipt = async (index: number, ok: boolean) => {
      const group = groups[index];
      const operation = await openLogoutBatch(db, fixture.owner, FIXTURE_TOKENS.a,
        attemptId, group.requestId, group.rows);
      await recordSyncResult(db, operation, ok
        ? { id: group.rows[0].id, ok: true, version: index + 1, updated_at: new Date().toISOString() }
        : { id: group.rows[0].id, ok: false, error: 'drive_error' });
      await settleLogoutBatch(db, fixture.owner, FIXTURE_TOKENS.a, attemptId, group.requestId);
    };
    phase = 'live_and_foreign_refusal';
    await receipt(0, true);
    await refuse(inspect, /logout_recovery_previous_session_active/);
    await refuse(() => inspectLogoutRecovery(db, fixture.owner, FIXTURE_TOKENS.other,
      attemptId, oldHash, batches), /logout_recovery_current_session_invalid/);
    await refuse(() => inspectLogoutRecovery(db, fixture.owner, FIXTURE_TOKENS.a,
      attemptId, oldHash, batches), /logout_recovery_same_session/);
    await refuse(() => inspectLogoutRecovery(db, fixture.other, FIXTURE_TOKENS.other,
      attemptId, oldHash, batches), /logout_recovery_attempt_missing/);
    phase = 'missing_receipt_refusal';
    await collections.sessions(db).updateOne({ _id: oldHash }, { $set: { revoked: true } });
    await refuse(inspect, /logout_recovery_receipt_missing/);
    // Test fixture setup only: restore the synthetic session to settle batch two.
    await collections.sessions(db).updateOne({ _id: oldHash }, { $set: { revoked: false } });
    await receipt(1, false);
    await collections.sessions(db).updateOne({ _id: oldHash },
      { $set: { expiresAt: new Date(Date.now() - 1000) } });
    phase = 'settled_partial_snapshot';
    const before = await snapshot(), result = await inspect();
    assert.deepEqual(result, { attemptId, state: 'prepared', batches: [
      { requestId: groups[0].requestId, charged: 0, refunded: 0, accepted: 1, failed: 0 },
      { requestId: groups[1].requestId, charged: 0, refunded: 0, accepted: 0, failed: 1 },
    ] });
    assert.deepEqual(await snapshot(), before);
    assert.equal(JSON.stringify(result).includes(groups[0].rows[0].body), false);
    assert.equal(JSON.stringify(result).includes(FIXTURE_TOKENS.a), false);
    phase = 'malformed_and_pending_refusal';
    await refuse(() => inspectLogoutRecovery(db, fixture.owner, FIXTURE_TOKENS.b,
      attemptId, oldHash, batches.map((batch, index) => index ? batch : { ...batch, fingerprint: 'b'.repeat(64) })),
    /logout_recovery_manifest_mismatch/);
    const operationId = `${fixture.owner}:${groups[1].requestId}`;
    await syncOperations(db).updateOne({ _id: operationId }, { $set: { status: 'pending' } });
    await refuse(inspect, /logout_recovery_reconciliation_required/);
    await syncOperations(db).updateOne({ _id: operationId }, { $set: { status: 'complete', charged: 10 } });
    await refuse(inspect, /logout_recovery_receipt_invalid/);
    await syncOperations(db).updateOne({ _id: operationId }, { $set: { charged: 0 } });
    await logoutAttempts(db).updateOne({ _id: id }, { $set: { state: 'completed' } });
    await refuse(inspect, /logout_recovery_receipt_invalid/);
    phase = 'completed_and_retired_session_snapshot';
    await syncOperations(db).updateOne({ _id: operationId }, { $set: { results: [{
      id: groups[1].rows[0].id, ok: true, version: 2, updated_at: new Date().toISOString(),
    }] } });
    // Simulate prior-session TTL removal, only in this owned generated DB.
    await collections.sessions(db).deleteOne({ _id: oldHash });
    const retiredBefore = await snapshot();
    assert.equal((await inspect()).state, 'completed');
    assert.deepEqual(await snapshot(), retiredBefore);
    await collections.sessions(db).updateOne({ _id: newHash }, { $set: { revoked: true } });
    await refuse(inspect, /logout_recovery_current_session_invalid/);
    const drive = await (await fetch(`${fixture.origin}/__fixture/state`)).json() as { writes: number };
    assert.equal(drive.writes, 0);
    phase = 'complete'; passed = true;
  });
