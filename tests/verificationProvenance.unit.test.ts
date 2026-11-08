import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildVerificationReport, scanForSecrets, secretValues, sha256Hex } from '../src/lib/verificationProvenance.js';

const head = 'a0b78abcf637d477ed0d3b4af5b4b7d90b144ed5';
const canary = 'canary-' + 'c'.repeat(32);
const allGreen = { install: 'success', typecheck: 'success', unit: 'success' };

function report(over: Partial<Parameters<typeof buildVerificationReport>[0]> = {}) {
  return buildVerificationReport({
    sourceHead: head, lockBytes: Buffer.from('{"lockfileVersion":3}'), node: 'v22.11.0', npm: '10.9.0',
    steps: allGreen, artifacts: [{ name: 'ci-a-proof.json', text: '{"outcome":"pass"}' }],
    secrets: [], canary, ...over,
  });
}

test('a clean run records source, lockfile digest, runtime and passes', () => {
  const r = report();
  assert.equal(r.outcome, 'pass');
  assert.equal(r.sourceHead, head);
  assert.equal(r.lockSha256, sha256Hex('{"lockfileVersion":3}'));
  assert.deepEqual(r.runtime, { node: 'v22.11.0', npm: '10.9.0' });
  assert.deepEqual(r.artifacts, { scanned: 1, findings: [] });
  assert.equal(r.canaryDetected, true);
});

test('a missing or partial source head, or any non-success step, fails', () => {
  assert.equal(report({ sourceHead: undefined }).outcome, 'fail');
  assert.equal(report({ sourceHead: head.slice(0, 7) }).sourceHead, null);
  for (const value of ['failure', 'cancelled', 'skipped', undefined, 'weird']) {
    const r = report({ steps: { ...allGreen, unit: value } });
    assert.equal(r.outcome, 'fail', String(value));
    assert.equal(r.steps.unit, value === undefined || value === 'weird' ? 'unavailable' : value);
  }
});

test('without a working canary the scan is not trusted', () => {
  assert.equal(report({ canary: '' }).outcome, 'fail');
  assert.equal(report({ canary: 'short' }).canaryDetected, false);
});

test('a leaked environment secret or canary fails without echoing it', () => {
  const secret = 'S3cretValue-for-the-test-only';
  const r = report({ secrets: [secret], artifacts: [
    { name: 'ci-ok-proof.json', text: '{}' },
    { name: 'ci-leak-proof.json', text: `{"error":"bad ${secret}"}` },
    { name: 'ci-canary-proof.json', text: `{"x":"${canary}"}` },
  ] });
  assert.equal(r.outcome, 'fail');
  assert.deepEqual(r.artifacts.findings, [
    { file: 'ci-leak-proof.json', kind: 'environment_secret' },
    { file: 'ci-canary-proof.json', kind: 'environment_secret' },
  ]);
  const serialized = JSON.stringify(r);
  assert.ok(!serialized.includes(secret) && !serialized.includes(canary), 'report holds no secret');
});

test('credential shapes are found; names and safe URIs are not', () => {
  const shaped = [
    ['private_key', '-----BEGIN PRIVATE KEY-----\nMIIE'],
    ['google_access_token', 'ya29.' + 'a'.repeat(40)],
    ['google_refresh_token', '1//0' + 'b'.repeat(40)],
    ['google_client_secret', 'GOCSPX-' + 'c'.repeat(28)],
    ['google_api_key', 'AIza' + 'd'.repeat(35)],
    ['jwt', 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTYifQ.c2lnbmF0dXJlLXZhbHVl'],
    ['credentialed_uri', 'mongodb+srv://user:pa55word@cluster.example.net/db'],
  ] as const;
  for (const [kind, text] of shaped) {
    assert.deepEqual(scanForSecrets([{ name: 'f', text }], []), [{ file: 'f', kind }], kind);
  }
  const safe = [
    '{"name":"TOKEN_ENCRYPTION_KEY","problem":"not set"}',
    'mongodb://127.0.0.1:27017/?replicaSet=rs0&directConnection=true',
    'https://example.test/api/auth/callback',
    '{"sha256":"' + 'e'.repeat(64) + '"}',
  ];
  for (const text of safe) assert.deepEqual(scanForSecrets([{ name: 'f', text }], []), [], text);
});

test('secret values come from secret-named variables and credentialed URIs only', () => {
  const values = secretValues({
    TOKEN_ENCRYPTION_KEY: 'k'.repeat(44), ADMIN_API_KEY: 'a'.repeat(32), GOOGLE_CLIENT_SECRET: 'g'.repeat(24),
    ATOMIC_CI_CANARY: canary, SHORT_TOKEN: 'abc', MONGODB_URI: 'mongodb://u:p4ssword@host/db',
    PLAIN_URI: 'mongodb://127.0.0.1:27017/', PATH: '/usr/bin', GITHUB_SHA: head,
  });
  assert.deepEqual(values.sort(), ['k'.repeat(44), 'a'.repeat(32), 'g'.repeat(24), canary,
    'mongodb://u:p4ssword@host/db'].sort());
});
