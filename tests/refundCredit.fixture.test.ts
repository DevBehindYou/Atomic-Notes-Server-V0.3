import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { z } from 'zod';
import type { AtomicUserDoc } from '../src/db/collections.js';
import { FIXTURE_TOKENS, startClientFixture } from './clientFixture.js';
import { assertFixtureCleanup } from './clientFixtureSafety.js';

const legacyWalletSchema = z.object({ coins: z.number(), coin_expiry_enabled: z.boolean(),
  energy: z.number(), energy_cap: z.number(), note_limit: z.number(), last_daily_grant_at: z.string().nullable() }).strict();
const getResponseSchema = z.object({ wallet: legacyWalletSchema.extend({ held_refund_energy: z.number() }),
  limits: z.object({ sync_standard_cost: z.number(), sync_instant_cost: z.number(), sync_standard_interval_seconds: z.number() }) });
const mutationResponseSchema = z.object({ wallet: legacyWalletSchema });
const legacyKeys = ['coins', 'coin_expiry_enabled', 'energy', 'energy_cap', 'note_limit', 'last_daily_grant_at'].sort();

test('GET energy reads held refund credit without activating it or changing legacy mutation responses',
  { timeout: 120000 }, async t => {
    let phase = 'setup', passed = false;
    t.after(() => writeFileSync('ci-refund-credit-reader-proof.json', JSON.stringify({ version: 1,
      scope: 'disposable refund credit schema and real energy HTTP reader; no activation',
      phase, outcome: passed ? 'pass' : 'fail' })));
    const starting = startClientFixture(process.env.MONGODB_URI, process.env.MONGODB_DB_NAME);
    t.after(async () => { const fixture = await starting.catch(() => undefined); await fixture?.close(); });
    const fixture = await starting;
    t.signal.throwIfAborted();
    const { getDb } = await import('../src/db/mongo.js');
    const db = await getDb(); assertFixtureCleanup(db.databaseName, fixture.database);
    const wallets = db.collection<AtomicUserDoc>('atomic_users');
    const call = (path = '/api/energy', body?: object) => fetch(`${fixture.origin}${path}`, {
      method: body ? 'POST' : 'GET',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${FIXTURE_TOKENS.a}` },
      body: body ? JSON.stringify(body) : undefined,
    });
    const snapshot = async () => ({
      wallet: await wallets.findOne({ _id: fixture.owner }),
      ledger: await db.collection('energy_ledger').find({ userId: fixture.owner }).sort({ _id: 1 }).toArray(),
      operations: await db.collection('sync_operations').find({ userId: fixture.owner }).sort({ _id: 1 }).toArray(),
    });
    const grantAt = new Date();
    await wallets.updateOne({ _id: fixture.owner }, { $set: { lastDailyGrantAt: grantAt } });
    const before = await snapshot();
    assert.ok(before.wallet);
    assert.equal(Object.hasOwn(before.wallet, 'refundCreditFormat'), false);
    assert.equal(Object.hasOwn(before.wallet, 'heldRefundEnergy'), false);
    phase = 'legacy_read';
    const legacyResponse = await call(); assert.equal(legacyResponse.status, 200);
    const legacy = getResponseSchema.parse(await legacyResponse.json());
    assert.deepEqual(legacy.wallet, { coins: 5, coin_expiry_enabled: false, energy: 100,
      energy_cap: 120, note_limit: 30, last_daily_grant_at: grantAt.toISOString(), held_refund_energy: 0 });
    assert.equal(legacy.limits.sync_standard_cost, 5);
    assert.equal(legacy.limits.sync_instant_cost, 10);
    assert.equal(legacy.limits.sync_standard_interval_seconds, 3600);
    assert.deepEqual(await snapshot(), before);

    phase = 'explicit_credit_read';
    for (const held of [0, 121, Number.MAX_SAFE_INTEGER]) {
      await wallets.updateOne({ _id: fixture.owner }, { $set: { refundCreditFormat: 1, heldRefundEnergy: held } });
      const creditBefore = await snapshot();
      // Concurrent reads do not release credits, append events or persist defaults.
      const reads = await Promise.all([call(), call(), call()]);
      for (const response of reads) {
        assert.equal(response.status, 200);
        assert.deepEqual(getResponseSchema.parse(await response.json()).wallet, { ...legacy.wallet, held_refund_energy: held });
      }
      assert.deepEqual(await snapshot(), creditBefore);
    }
    phase = 'invalid_metadata_refused';
    // Bypass the application schema only to simulate corrupt/future stored data
    // inside this generated database. The GET must not silently zero or repair it.
    const rawWallets = db.collection<{ _id: string }>('atomic_users');
    for (const metadata of [
      { refundCreditFormat: 2, heldRefundEnergy: 5 },
      { refundCreditFormat: 1, heldRefundEnergy: null },
      { refundCreditFormat: 1, heldRefundEnergy: -1 },
    ]) {
      await rawWallets.updateOne({ _id: fixture.owner }, { $set: metadata });
      const invalidBefore = await snapshot();
      const invalid = await call();
      assert.equal(invalid.status, 500);
      assert.deepEqual(await invalid.json(), { error: 'internal_error' });
      assert.deepEqual(await snapshot(), invalidBefore);
    }
    await wallets.updateOne({ _id: fixture.owner },
      { $set: { refundCreditFormat: 1, heldRefundEnergy: Number.MAX_SAFE_INTEGER } });

    phase = 'zero_energy_not_spendable';
    await wallets.updateOne({ _id: fixture.owner }, { $set: { energy: 0 } });
    const emptyBefore = await snapshot();
    const denied = await call('/api/notes/push', { requestId: randomUUID(), mode: 'instant', rows: [{
      id: randomUUID(), kind: 'text', title: 'Public synthetic credit test', body: '', items: [],
      pinned: false, deleted: false, enc_v: 0, payload: null, base_version: 0, created_at: new Date().toISOString(),
    }] });
    assert.equal(denied.status, 409);
    assert.deepEqual(await denied.json(), { error: 'insufficient_energy' });
    assert.deepEqual(await snapshot(), emptyBefore);

    phase = 'legacy_conversion_projection';
    const converted = await call('/api/energy/convert', { coins: 1 });
    assert.equal(converted.status, 200);
    const conversion = mutationResponseSchema.parse(await converted.json());
    assert.deepEqual(Object.keys(conversion.wallet).sort(), legacyKeys);
    assert.equal(conversion.wallet.energy, 40); assert.equal(conversion.wallet.coins, 4);
    assert.equal((await snapshot()).wallet!.heldRefundEnergy, Number.MAX_SAFE_INTEGER);

    phase = 'legacy_note_limit_projection';
    // Generated fixture balance only; existing tier still costs 10 Coins.
    await wallets.updateOne({ _id: fixture.owner }, { $set: { coins: 20 } });
    const upgraded = await call('/api/energy/note-limit', { from_limit: 30 });
    assert.equal(upgraded.status, 200);
    const upgrade = mutationResponseSchema.parse(await upgraded.json());
    assert.deepEqual(Object.keys(upgrade.wallet).sort(), legacyKeys);
    assert.equal(upgrade.wallet.note_limit, 40); assert.equal(upgrade.wallet.coins, 10);
    assert.equal(upgrade.wallet.energy, 40);
    assert.equal((await snapshot()).wallet!.heldRefundEnergy, Number.MAX_SAFE_INTEGER);
    assert.equal((await snapshot()).wallet!.refundCreditFormat, 1);
    phase = 'complete'; passed = true;
  });
