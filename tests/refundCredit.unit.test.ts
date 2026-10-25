import assert from 'node:assert/strict';
import test from 'node:test';
import { atomicUserSchema } from '../src/db/collections.js';
import { readHeldRefundEnergy } from '../src/lib/refundCredit.js';

const wallet = { _id: '00000000-0000-4000-8000-000000000001', createdAt: new Date('2026-10-25T00:00:00Z') };
const invalidMetadata = [
  { refundCreditFormat: 1 }, { heldRefundEnergy: 0 },
  { refundCreditFormat: null, heldRefundEnergy: 0 },
  { refundCreditFormat: 2, heldRefundEnergy: 0 },
  { refundCreditFormat: '1', heldRefundEnergy: 0 },
  { refundCreditFormat: 1, heldRefundEnergy: null },
  { refundCreditFormat: 1, heldRefundEnergy: -1 },
  { refundCreditFormat: 1, heldRefundEnergy: 0.5 },
  { refundCreditFormat: 1, heldRefundEnergy: Number.MAX_SAFE_INTEGER + 1 },
  { refundCreditFormat: 1, heldRefundEnergy: NaN },
  { refundCreditFormat: 1, heldRefundEnergy: Infinity },
  { refundCreditFormat: 1, heldRefundEnergy: '5' },
  { refundCreditFormat: undefined, heldRefundEnergy: undefined },
];

test('wallet schema keeps legacy metadata absent and preserves valid paired credit boundaries', () => {
  const legacy = atomicUserSchema.parse(wallet);
  assert.equal(Object.hasOwn(legacy, 'refundCreditFormat'), false);
  assert.equal(Object.hasOwn(legacy, 'heldRefundEnergy'), false);
  for (const amount of [0, 1, 120, Number.MAX_SAFE_INTEGER]) {
    const parsed = atomicUserSchema.parse({ ...wallet, refundCreditFormat: 1, heldRefundEnergy: amount });
    assert.equal(Reflect.get(parsed, 'refundCreditFormat'), 1);
    assert.equal(Reflect.get(parsed, 'heldRefundEnergy'), amount);
  }
});

test('wallet schema refuses corrupt, unsupported and incomplete explicit refund metadata', () => {
  for (const metadata of invalidMetadata) {
    assert.equal(atomicUserSchema.safeParse({ ...wallet, ...metadata }).success, false);
  }
});

test('pure reader projects zero for legacy wallets, validates credits and never mutates inputs', () => {
  const read = readHeldRefundEnergy;
  const legacy = Object.freeze({ energy: 17, energyCap: 120 });
  assert.equal(read(legacy), 0);
  assert.deepEqual(legacy, { energy: 17, energyCap: 120 });
  for (const amount of [0, 1, 121, Number.MAX_SAFE_INTEGER]) {
    const current = Object.freeze({ ...legacy, refundCreditFormat: 1, heldRefundEnergy: amount });
    const before = structuredClone(current);
    assert.equal(read(current), amount);
    assert.deepEqual(current, before);
  }
  for (const metadata of invalidMetadata) {
    const current = Object.freeze({ ...legacy, ...metadata });
    assert.throws(() => read(current), { message: 'invalid_refund_credit_metadata' });
    assert.deepEqual(current, { ...legacy, ...metadata });
  }
  for (const invalid of [null, undefined, 0, []]) assert.throws(() => read(invalid));
});
