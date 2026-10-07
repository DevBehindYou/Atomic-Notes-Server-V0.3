import assert from 'node:assert/strict';
import test from 'node:test';
import { assertFixtureCleanup, fixtureDatabase } from './clientFixtureSafety.js';
import { fixtureFailureIds } from './clientFixtureFaults.js';

test('fixture failure controls accept empty reset and one bounded synthetic ID', () => {
  const id = '00000000-0000-4000-8000-000000000001';
  assert.equal(fixtureFailureIds({ ids: [] }).size, 0);
  assert.ok(fixtureFailureIds({ ids: [id] }).has(id));
});
for (const [name, body] of [
  ['invalid ID', { ids: ['invalid'] }],
  ['duplicate IDs', { ids: Array(2).fill('00000000-0000-4000-8000-000000000001') }],
  ['oversized control', { ids: Array(51).fill('00000000-0000-4000-8000-000000000001') }],
] as const) {
  test(`fixture failure controls refuse ${name}`, () => {
    assert.throws(() => fixtureFailureIds(body), /fixture_invalid_failure_ids/);
  });
}

const local = 'mongodb://127.0.0.1:27017/?replicaSet=rs0&directConnection=true';
for (const [name, uri] of [
  ['absent', undefined], ['remote', 'mongodb://example.test:27017/?replicaSet=rs0&directConnection=true'],
  ['srv', 'mongodb+srv://example.test/'], ['database path', local.replace('/?', '/Atomic-DB?')],
  ['credentials', local.replace('127.0.0.1', 'dummy:dummy@127.0.0.1')],
  ['second seed', local.replace(':27017/', ':27017,example.test:27017/')],
  ['no replica', 'mongodb://127.0.0.1:27017/'], ['not direct', local.replace('=true', '=false')],
  ['duplicate option', `${local}&replicaSet=other`], ['extra option', `${local}&tls=true`],
  ['fragment', `${local}#other`], ['missing port', local.replace(':27017', '')],
  ['zero port', local.replace(':27017', ':0')], ['out-of-range port', local.replace(':27017', ':65536')],
] as const) {
  test(`client fixture refuses ${name} before database setup`, () => {
    assert.throws(() => fixtureDatabase(uri), /fixture_requires_canonical_local_replica_set/);
  });
}
test('client fixture generates distinct bounded database names', () => {
  const first = fixtureDatabase(local), second = fixtureDatabase(local);
  assert.match(first, /^atomic_test_[a-f0-9]{20}$/);
  assert.notEqual(first, second);
  assert.equal(first.length, 32);
});
test('client fixture refuses even a caller-selected test database', () => {
  assert.throws(() => fixtureDatabase(local, 'atomic_test_01234567890123456789'), /fixture_database_must_be_generated/);
  assert.throws(() => fixtureDatabase(local, ''), /fixture_database_must_be_generated/);
});
test('client fixture cleanup requires both the generated pattern and exact identity', () => {
  const name = fixtureDatabase(local);
  assertFixtureCleanup(name, name);
  assert.throws(() => assertFixtureCleanup('Atomic-DB', name), /fixture_cleanup_identity_mismatch/);
  assert.throws(() => assertFixtureCleanup(name, 'Atomic-DB'), /fixture_cleanup_identity_mismatch/);
  assert.throws(() => assertFixtureCleanup(`${name}a`, name), /fixture_cleanup_identity_mismatch/);
});
