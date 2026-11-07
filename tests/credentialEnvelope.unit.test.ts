import assert from 'node:assert/strict';
import test from 'node:test';
import crypto from 'node:crypto';
import { Hono } from 'hono';
import {
  CredentialEnvelopeError, credentialEnvIssues, credentialKeyId, credentialKeyringFromEnv, credentialWriteFormat,
  decryptToken, describeCredentialEnvelope, encryptToken, openCredential, sealCredential,
  type CredentialKeyring,
} from '../src/lib/crypto';
import { getEnvIssues } from '../src/lib/env';
import { registerErrorHandler } from '../src/middleware/errorHandler';

// Fixture keys only. None of these values is, or was ever, a deployed secret.
const K1 = Buffer.alloc(32, 0x11);
const K2 = Buffer.alloc(32, 0x22);
const K3 = Buffer.alloc(32, 0x33);
const b64 = (key: Buffer) => key.toString('base64');
const PLAINTEXT = 'fixture-refresh-token';
// Written by the pre-C26 writer with K1 and a fixed IV of twelve 0x22 bytes: `b64(iv).b64(tag).b64(ciphertext)`.
// It stands for every value already stored in googleAccounts.encryptedAccessToken/encryptedRefreshToken.
const GOLDEN_LEGACY = 'IiIiIiIiIiIiIiIi.+mtVpHCINgMG75kdohTw0g==.cZ5/PbW9+nKXWrhOLdWB+Gv8pocE';

/** A verbatim copy of the pre-C26 reader, standing in for a rolled-back Server. */
function preC26Decrypt(payload: string, key: Buffer): string {
  const [ivB64, tagB64, ctB64] = payload.split('.');
  if (!ivB64 || !tagB64 || !ctB64) throw new Error('Malformed encrypted token payload');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(ivB64, 'base64'));
  decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(ctB64, 'base64')), decipher.final()]).toString('utf8');
}

const ring = (current: Buffer, ...previous: Buffer[]): CredentialKeyring =>
  ({ current: { id: credentialKeyId(current), key: current }, previous: previous.map(key => ({ id: credentialKeyId(key), key })) });

const ENV_NAMES = ['TOKEN_ENCRYPTION_KEY', 'TOKEN_ENCRYPTION_PREVIOUS_KEYS', 'TOKEN_ENCRYPTION_WRITE_FORMAT'] as const;
function withEnv(values: Partial<Record<typeof ENV_NAMES[number], string>>, run: () => void) {
  const saved = Object.fromEntries(ENV_NAMES.map(name => [name, process.env[name]]));
  try {
    for (const name of ENV_NAMES) {
      if (values[name] === undefined) delete process.env[name]; else process.env[name] = values[name];
    }
    run();
  } finally {
    for (const name of ENV_NAMES) {
      if (saved[name] === undefined) delete process.env[name]; else process.env[name] = saved[name];
    }
  }
}

function rejects(run: () => unknown, code: CredentialEnvelopeError['code']) {
  assert.throws(run, (error: unknown) => {
    assert.ok(error instanceof CredentialEnvelopeError, 'a typed credential envelope error');
    assert.equal(error.code, code);
    return true;
  });
}

const flip = (segment: string, encoding: 'base64' | 'base64url') => {
  const bytes = Buffer.from(segment, encoding); bytes[0] ^= 1; return bytes.toString(encoding);
};

test('the golden pre-C26 envelope still decrypts byte-for-byte with the single existing key variable', () => {
  assert.equal(openCredential(GOLDEN_LEGACY, ring(K1)), PLAINTEXT);
  assert.deepEqual(describeCredentialEnvelope(GOLDEN_LEGACY), { format: 'legacy' });
  withEnv({ TOKEN_ENCRYPTION_KEY: b64(K1) }, () => assert.equal(decryptToken(GOLDEN_LEGACY), PLAINTEXT));
  // The reference reader agrees, so the golden value really is the old format.
  assert.equal(preC26Decrypt(GOLDEN_LEGACY, K1), PLAINTEXT);
});

test('the default writer still emits the legacy format that a rolled-back Server can read', () => {
  for (const format of [undefined, 'legacy']) {
    withEnv({ TOKEN_ENCRYPTION_KEY: b64(K1), TOKEN_ENCRYPTION_WRITE_FORMAT: format, TOKEN_ENCRYPTION_PREVIOUS_KEYS: b64(K2) }, () => {
      assert.equal(credentialWriteFormat(), 'legacy');
      const sealed = encryptToken(PLAINTEXT);
      assert.match(sealed, /^[A-Za-z0-9+/]{16}\.[A-Za-z0-9+/]{22}==\.[A-Za-z0-9+/=]+$/);
      assert.deepEqual(describeCredentialEnvelope(sealed), { format: 'legacy' });
      assert.equal(preC26Decrypt(sealed, K1), PLAINTEXT);
      assert.equal(decryptToken(sealed), PLAINTEXT);
    });
  }
  assert.deepEqual(describeCredentialEnvelope(sealCredential(PLAINTEXT, ring(K1))), { format: 'legacy' });
});

test('the opt-in v1 writer emits a prefixed, key-identified envelope with the documented layout', () => {
  withEnv({ TOKEN_ENCRYPTION_KEY: b64(K1), TOKEN_ENCRYPTION_WRITE_FORMAT: 'v1' }, () => {
    assert.equal(credentialWriteFormat(), 'v1');
    const sealed = encryptToken(PLAINTEXT);
    const parts = sealed.split(':');
    assert.equal(parts.length, 5);
    const [version, keyId, iv, tag, ciphertext] = parts;
    assert.equal(version, 'ce1');
    assert.equal(keyId, credentialKeyId(K1));
    assert.match(keyId, /^[A-Za-z0-9_-]{11}$/);
    assert.equal(Buffer.from(iv, 'base64url').length, 12);
    assert.equal(Buffer.from(tag, 'base64url').length, 16);
    assert.equal(Buffer.from(ciphertext, 'base64url').length, Buffer.byteLength(PLAINTEXT));
    assert.ok(!sealed.includes('.'), 'never parseable as a legacy envelope');
    assert.deepEqual(describeCredentialEnvelope(sealed), { format: 'v1', keyId });
    assert.equal(decryptToken(sealed), PLAINTEXT);
    assert.notEqual(encryptToken(PLAINTEXT), sealed, 'a fresh random IV per envelope');
    // The documented rollback limit: an old reader cannot read v1, which is why this writer is off by default.
    assert.throws(() => preC26Decrypt(sealed, K1));
  });
  assert.equal(openCredential(sealCredential('', ring(K1), 'v1'), ring(K1)), '', 'empty plaintext round-trips in v1');
  const unicode = 'ya29.é中\u{1F512}';
  assert.equal(openCredential(sealCredential(unicode, ring(K1), 'v1'), ring(K1)), unicode);
});

test('key IDs are stable, distinct per key and reveal no key bytes', () => {
  assert.equal(credentialKeyId(K1), credentialKeyId(Buffer.from(K1)));
  assert.notEqual(credentialKeyId(K1), credentialKeyId(K2));
  for (const key of [K1, K2]) {
    const id = credentialKeyId(key);
    assert.ok(!b64(key).includes(id) && !key.toString('base64url').includes(id) && !key.toString('hex').includes(id));
  }
});

test('every segment of a v1 envelope is tamper-evident with a typed reason', () => {
  const keys = ring(K1, K2);
  const sealed = sealCredential(PLAINTEXT, keys, 'v1');
  const [version, keyId, iv, tag, ciphertext] = sealed.split(':');
  const join = (...parts: string[]) => parts.join(':');
  rejects(() => openCredential(join('ce2', keyId, iv, tag, ciphertext), keys), 'unknown_version');
  rejects(() => openCredential(join('ce10', keyId, iv, tag, ciphertext), keys), 'unknown_version');
  rejects(() => openCredential(join('cx1', keyId, iv, tag, ciphertext), keys), 'malformed');
  rejects(() => openCredential(join(version, 'AAAAAAAAAAA', iv, tag, ciphertext), keys), 'unknown_key_id');
  // Relabelling with another configured key's ID is caught by the authenticated header and by the key itself.
  rejects(() => openCredential(join(version, credentialKeyId(K2), iv, tag, ciphertext), keys), 'authentication_failed');
  rejects(() => openCredential(join(version, keyId, flip(iv, 'base64url'), tag, ciphertext), keys), 'authentication_failed');
  rejects(() => openCredential(join(version, keyId, iv, flip(tag, 'base64url'), ciphertext), keys), 'authentication_failed');
  rejects(() => openCredential(join(version, keyId, iv, tag, flip(ciphertext, 'base64url')), keys), 'authentication_failed');
  rejects(() => openCredential(join(version, keyId, iv, tag.slice(0, 16), ciphertext), keys), 'malformed');
  rejects(() => openCredential(join(version, keyId, iv.slice(0, 12), tag, ciphertext), keys), 'malformed');
  rejects(() => openCredential(join(version, keyId, iv, tag, ciphertext, 'extra'), keys), 'malformed');
  rejects(() => openCredential(join(version, keyId, iv, tag), keys), 'malformed');
  rejects(() => openCredential(join(version, keyId, iv, tag, `${ciphertext}*`), keys), 'malformed');
  rejects(() => openCredential(join(version, keyId, iv, tag, ciphertext) + '=', keys), 'malformed');
  // A header that is not authenticated as written cannot be swapped for an equivalent one.
  const forged = crypto.createCipheriv('aes-256-gcm', K1, Buffer.alloc(12, 5));
  const forgedCt = Buffer.concat([forged.update(PLAINTEXT), forged.final()]);
  rejects(() => openCredential(join(version, keyId, Buffer.alloc(12, 5).toString('base64url'),
    forged.getAuthTag().toString('base64url'), forgedCt.toString('base64url')), keys), 'authentication_failed');
  assert.equal(openCredential(sealed, keys), PLAINTEXT, 'the untouched envelope still opens');
});

test('every segment of a legacy envelope is tamper-evident, and truncated tags are no longer accepted', () => {
  const keys = ring(K1);
  const [iv, tag, ciphertext] = GOLDEN_LEGACY.split('.');
  rejects(() => openCredential([flip(iv, 'base64'), tag, ciphertext].join('.'), keys), 'authentication_failed');
  rejects(() => openCredential([iv, flip(tag, 'base64'), ciphertext].join('.'), keys), 'authentication_failed');
  rejects(() => openCredential([iv, tag, flip(ciphertext, 'base64')].join('.'), keys), 'authentication_failed');
  // A genuine tag truncated to 4 bytes satisfied the old reader (DEP0182), a 2^32 forgery bound. It is refused now.
  const shortTag = Buffer.from(tag, 'base64').subarray(0, 4).toString('base64');
  assert.equal(preC26Decrypt([iv, shortTag, ciphertext].join('.'), K1), PLAINTEXT);
  rejects(() => openCredential([iv, shortTag, ciphertext].join('.'), keys), 'malformed');
  rejects(() => openCredential([Buffer.alloc(16).toString('base64'), tag, ciphertext].join('.'), keys), 'malformed');
  rejects(() => openCredential(`${GOLDEN_LEGACY}.extra`, keys), 'malformed');
  rejects(() => openCredential([iv, tag].join('.'), keys), 'malformed');
  rejects(() => openCredential([iv, tag, ''].join('.'), keys), 'malformed');
  for (const value of ['', 'not-an-envelope', ':', 'ce1', 42, null, undefined]) {
    rejects(() => openCredential(value as unknown as string, keys), 'malformed');
  }
});

test('a wrong key is refused for both formats without revealing which key was tried', () => {
  rejects(() => openCredential(GOLDEN_LEGACY, ring(K2)), 'authentication_failed');
  rejects(() => openCredential(sealCredential(PLAINTEXT, ring(K1), 'v1'), ring(K2)), 'unknown_key_id');
  withEnv({ TOKEN_ENCRYPTION_KEY: b64(K2) }, () => rejects(() => decryptToken(GOLDEN_LEGACY), 'authentication_failed'));
});

test('unknown future versions are refused before any key is used', () => {
  const keyId = credentialKeyId(K1);
  for (const version of ['ce0', 'ce2', 'ce9999']) {
    const envelope = `${version}:${keyId}:AAAAAAAAAAAAAAAA:AAAAAAAAAAAAAAAAAAAAAA:AAAA`;
    rejects(() => openCredential(envelope, ring(K1)), 'unknown_version');
    rejects(() => describeCredentialEnvelope(envelope), 'unknown_version');
  }
});

test('mixed old and new envelopes read during a partial rotation, and retiring a key fails only its envelopes', () => {
  const beforeRotation = ring(K1);
  const legacyK1 = sealCredential('legacy-under-k1', beforeRotation);
  const v1K1 = sealCredential('v1-under-k1', beforeRotation, 'v1');
  const rotating = ring(K2, K1);
  const legacyK2 = sealCredential('legacy-under-k2', rotating);
  const v1K2 = sealCredential('v1-under-k2', rotating, 'v1');
  assert.deepEqual(describeCredentialEnvelope(v1K2), { format: 'v1', keyId: credentialKeyId(K2) });
  for (const [envelope, expected] of [[GOLDEN_LEGACY, PLAINTEXT], [legacyK1, 'legacy-under-k1'], [v1K1, 'v1-under-k1'],
    [legacyK2, 'legacy-under-k2'], [v1K2, 'v1-under-k2']] as const) {
    assert.equal(openCredential(envelope, rotating), expected);
  }
  // The same partial rotation, configured only through the environment.
  withEnv({ TOKEN_ENCRYPTION_KEY: b64(K2), TOKEN_ENCRYPTION_PREVIOUS_KEYS: ` ${b64(K3)} , ${b64(K1)} ` }, () => {
    const configured = credentialKeyringFromEnv();
    assert.equal(configured.current.id, credentialKeyId(K2));
    assert.deepEqual(configured.previous.map(key => key.id), [credentialKeyId(K3), credentialKeyId(K1)]);
    for (const envelope of [GOLDEN_LEGACY, legacyK1, v1K1, legacyK2, v1K2]) assert.doesNotThrow(() => decryptToken(envelope));
    assert.equal(preC26Decrypt(encryptToken('new-write'), K2), 'new-write', 'writes use the current key only');
  });
  // Retiring K1 too early only strands what K1 wrote.
  const retired = ring(K2);
  rejects(() => openCredential(legacyK1, retired), 'authentication_failed');
  rejects(() => openCredential(v1K1, retired), 'unknown_key_id');
  assert.equal(openCredential(legacyK2, retired), 'legacy-under-k2');
  assert.equal(openCredential(v1K2, retired), 'v1-under-k2');
});

test('key configuration stays backward compatible and refuses unsafe keyrings with a typed error', () => {
  withEnv({ TOKEN_ENCRYPTION_KEY: b64(K1) }, () => {
    const configured = credentialKeyringFromEnv();
    assert.equal(configured.current.id, credentialKeyId(K1));
    assert.deepEqual(configured.previous, []);
  });
  withEnv({ TOKEN_ENCRYPTION_KEY: b64(K1), TOKEN_ENCRYPTION_PREVIOUS_KEYS: `${b64(K1)},${b64(K2)},${b64(K2)}` }, () => {
    assert.deepEqual(credentialKeyringFromEnv().previous.map(key => key.id), [credentialKeyId(K2)], 'duplicates are ignored');
  });
  withEnv({}, () => rejects(() => decryptToken(GOLDEN_LEGACY), 'key_config'));
  withEnv({ TOKEN_ENCRYPTION_KEY: Buffer.alloc(16, 1).toString('base64') }, () => rejects(() => encryptToken(PLAINTEXT), 'key_config'));
  withEnv({ TOKEN_ENCRYPTION_KEY: b64(K1), TOKEN_ENCRYPTION_PREVIOUS_KEYS: 'short' }, () => rejects(() => decryptToken(GOLDEN_LEGACY), 'key_config'));
  withEnv({ TOKEN_ENCRYPTION_KEY: b64(K1), TOKEN_ENCRYPTION_PREVIOUS_KEYS: [K2, K3, Buffer.alloc(32, 4), Buffer.alloc(32, 5)].map(b64).join(',') },
    () => rejects(() => decryptToken(GOLDEN_LEGACY), 'key_config'));
  // An unrecognised writer setting fails closed for writes but never blocks reading stored credentials.
  withEnv({ TOKEN_ENCRYPTION_KEY: b64(K1), TOKEN_ENCRYPTION_WRITE_FORMAT: 'V1' }, () => {
    rejects(() => encryptToken(PLAINTEXT), 'key_config');
    assert.equal(decryptToken(GOLDEN_LEGACY), PLAINTEXT);
  });
});

test('configuration issues name variables without values and leave the existing single-key setup valid', () => {
  const base = { MONGODB_URI: 'mongodb://127.0.0.1:27017', TOKEN_ENCRYPTION_KEY: b64(K1), GOOGLE_CLIENT_ID: 'id', GOOGLE_CLIENT_SECRET: 'secret',
    GOOGLE_REDIRECT_URI: 'https://example.test/api/auth/callback', ADMIN_API_KEY: 'a'.repeat(32) } as NodeJS.ProcessEnv;
  assert.deepEqual(getEnvIssues(base), []);
  assert.deepEqual(credentialEnvIssues(base), []);
  assert.deepEqual(getEnvIssues({ ...base, TOKEN_ENCRYPTION_PREVIOUS_KEYS: b64(K2), TOKEN_ENCRYPTION_WRITE_FORMAT: 'v1' }), []);
  const sentinel = 'PRIVATE-SENTINEL-VALUE-c26';
  const issues = getEnvIssues({ ...base, TOKEN_ENCRYPTION_PREVIOUS_KEYS: `${b64(K2)},${sentinel}`, TOKEN_ENCRYPTION_WRITE_FORMAT: sentinel });
  assert.deepEqual(issues.map(issue => issue.name).sort(), ['TOKEN_ENCRYPTION_PREVIOUS_KEYS', 'TOKEN_ENCRYPTION_WRITE_FORMAT']);
  assert.ok(!JSON.stringify(issues).includes(sentinel) && !JSON.stringify(issues).includes(b64(K2)));
});

test('failures never carry key material, plaintext or envelope bytes', () => {
  const sentinelPlaintext = 'ya29.PRIVATE-ACCESS-TOKEN-SENTINEL';
  const v1 = sealCredential(sentinelPlaintext, ring(K1), 'v1');
  const legacy = sealCredential(sentinelPlaintext, ring(K1));
  const secrets = [sentinelPlaintext, b64(K1), b64(K2), K1.toString('hex'), K2.toString('hex'), K1.toString('base64url'),
    v1, legacy, ...v1.split(':').slice(2), ...legacy.split('.')];
  const failures: unknown[] = [];
  const capture = (run: () => unknown) => { try { run(); } catch (error) { failures.push(error); } };
  capture(() => openCredential(legacy, ring(K2)));
  capture(() => openCredential(v1, ring(K2)));
  capture(() => openCredential(v1.replace(/^ce1/, 'ce7'), ring(K1)));
  capture(() => openCredential(`${legacy}.x`, ring(K1)));
  capture(() => openCredential(v1.slice(0, -2) + (v1.endsWith('A') ? 'BB' : 'AA'), ring(K1)));
  withEnv({ TOKEN_ENCRYPTION_KEY: b64(K1).slice(0, 40) }, () => capture(() => decryptToken(legacy)));
  withEnv({ TOKEN_ENCRYPTION_KEY: b64(K1), TOKEN_ENCRYPTION_PREVIOUS_KEYS: b64(K2).slice(0, 20) }, () => capture(() => decryptToken(legacy)));
  withEnv({ TOKEN_ENCRYPTION_KEY: b64(K1), TOKEN_ENCRYPTION_WRITE_FORMAT: b64(K2) }, () => capture(() => encryptToken(sentinelPlaintext)));
  assert.equal(failures.length, 8);
  for (const error of failures) {
    assert.ok(error instanceof CredentialEnvelopeError);
    assert.equal(error.cause, undefined, 'the underlying OpenSSL error is not chained');
    const rendered = [error.message, error.stack ?? '', String(error), JSON.stringify(error), JSON.stringify(Object.entries(error))].join('\n');
    for (const secret of secrets) assert.ok(!rendered.includes(secret), `failure output leaked a ${secret.length}-character value`);
  }
});

test('an envelope failure inside a request still becomes a bare 500 with a redacted log line', async () => {
  const app = new Hono();
  registerErrorHandler(app);
  const tampered = GOLDEN_LEGACY.replace(/^I/, 'J');
  app.get('/', () => { decryptToken(tampered); throw new Error('unreachable'); });
  const logged: string[] = [];
  const original = console.error;
  const savedKey = process.env.TOKEN_ENCRYPTION_KEY;
  console.error = (...args: unknown[]) => { logged.push(args.map(String).join(' ')); };
  process.env.TOKEN_ENCRYPTION_KEY = b64(K1);
  try {
    const response = await app.request('/');
    assert.equal(response.status, 500);
    assert.deepEqual(await response.json(), { error: 'internal_error' });
  } finally {
    console.error = original;
    if (savedKey === undefined) delete process.env.TOKEN_ENCRYPTION_KEY; else process.env.TOKEN_ENCRYPTION_KEY = savedKey;
  }
  assert.equal(logged.length, 1);
  assert.match(logged[0], /credential envelope rejected \(authentication_failed\)/i);
  for (const secret of [tampered, PLAINTEXT, b64(K1), ...tampered.split('.')]) assert.ok(!logged[0].includes(secret));
});
