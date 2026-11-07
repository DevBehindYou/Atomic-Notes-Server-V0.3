import crypto from 'node:crypto';

// Credential envelopes for the Google access/refresh tokens stored in MongoDB
// (googleAccounts.encryptedAccessToken / encryptedRefreshToken). Two formats:
//
//   legacy  b64(iv12).b64(tag16).b64(ciphertext)        standard base64, '.'-separated, no key ID
//   v1      ce1:<keyId11>:b64u(iv12):b64u(tag16):b64u(ciphertext)
//
// Both are AES-256-GCM. v1 authenticates its `ce1:<keyId>` header as AAD. Neither
// base64 alphabet contains ':', so a v1 value can never parse as legacy and a legacy
// value can never parse as v1. The writer emits legacy unless
// TOKEN_ENCRYPTION_WRITE_FORMAT=v1 opts in (see docs/CREDENTIAL_ENVELOPE.md).

const ALGO = 'aes-256-gcm';
const IV_BYTES = 12;
const TAG_BYTES = 16;
const V1 = 'ce1';
const MAX_PREVIOUS_KEYS = 3;
const KEY_ID_LABEL = 'atomic-notes/credential-envelope/key-id/v1';
const B64URL = /^[A-Za-z0-9_-]*$/;
const KEY_ID = /^[A-Za-z0-9_-]{11}$/;

export type CredentialEnvelopeFailure =
  | 'key_config' | 'malformed' | 'unknown_version' | 'unknown_key_id' | 'authentication_failed';

/**
 * A refused envelope or key configuration. The message is a fixed string per code
 * (plus a variable name for key_config): never key material, plaintext or envelope
 * bytes, and the underlying OpenSSL error is not chained. It has no `status`, so the
 * error handler keeps answering 500 internal_error as before.
 */
export class CredentialEnvelopeError extends Error {
  constructor(readonly code: CredentialEnvelopeFailure, detail?: string) {
    super(code === 'key_config' ? `Credential key configuration invalid (${detail})` : `Credential envelope rejected (${code})`);
    this.name = 'CredentialEnvelopeError';
  }
}

export type CredentialKey = { id: string; key: Buffer };
/** `current` writes and reads; `previous` keys only read, during a rotation. */
export type CredentialKeyring = { current: CredentialKey; previous: CredentialKey[] };
export type CredentialWriteFormat = 'legacy' | 'v1';
export type CredentialEnvelopeInfo = { format: 'legacy' } | { format: 'v1'; keyId: string };

/** A stable, non-secret identifier: the first 8 bytes of HMAC-SHA256(key, label), base64url. */
export function credentialKeyId(key: Buffer): string {
  return crypto.createHmac('sha256', key).update(KEY_ID_LABEL).digest().subarray(0, 8).toString('base64url');
}

function decodeKey(value: string, name: string): Buffer {
  const key = Buffer.from(value.trim(), 'base64');
  if (key.length !== 32) throw new CredentialEnvelopeError('key_config', `${name} must decode to exactly 32 bytes (base64)`);
  return key;
}

function previousKeyValues(env: NodeJS.ProcessEnv): string[] {
  return (env.TOKEN_ENCRYPTION_PREVIOUS_KEYS ?? '').split(',').map(value => value.trim()).filter(Boolean);
}

/**
 * TOKEN_ENCRYPTION_KEY (unchanged, required) is the current key. The optional
 * TOKEN_ENCRYPTION_PREVIOUS_KEYS is a comma-separated list of at most three base64
 * keys that still read envelopes written before a rotation.
 */
export function credentialKeyringFromEnv(env: NodeJS.ProcessEnv = process.env): CredentialKeyring {
  const raw = env.TOKEN_ENCRYPTION_KEY;
  if (!raw?.trim()) throw new CredentialEnvelopeError('key_config', 'TOKEN_ENCRYPTION_KEY is not set');
  const key = decodeKey(raw, 'TOKEN_ENCRYPTION_KEY');
  const current = { id: credentialKeyId(key), key };
  const values = previousKeyValues(env);
  if (values.length > MAX_PREVIOUS_KEYS) {
    throw new CredentialEnvelopeError('key_config', `TOKEN_ENCRYPTION_PREVIOUS_KEYS allows at most ${MAX_PREVIOUS_KEYS} keys`);
  }
  const previous: CredentialKey[] = [];
  for (const value of values) {
    const previousKey = decodeKey(value, 'TOKEN_ENCRYPTION_PREVIOUS_KEYS');
    const id = credentialKeyId(previousKey);
    const known = [current, ...previous].find(entry => entry.id === id);
    if (known && !known.key.equals(previousKey)) {
      throw new CredentialEnvelopeError('key_config', 'TOKEN_ENCRYPTION_PREVIOUS_KEYS has a key ID collision');
    }
    if (!known) previous.push({ id, key: previousKey });
  }
  return { current, previous };
}

/** Unset or `legacy` keeps the existing format. `v1` is an explicit, reviewed opt-in. */
export function credentialWriteFormat(env: NodeJS.ProcessEnv = process.env): CredentialWriteFormat {
  const value = env.TOKEN_ENCRYPTION_WRITE_FORMAT;
  if (value === undefined || value === '' || value === 'legacy') return 'legacy';
  if (value === 'v1') return 'v1';
  throw new CredentialEnvelopeError('key_config', 'TOKEN_ENCRYPTION_WRITE_FORMAT must be legacy, v1, or unset');
}

/** Problems with the optional rotation variables, by name only. */
export function credentialEnvIssues(env: NodeJS.ProcessEnv): { name: string; problem: string }[] {
  const issues: { name: string; problem: string }[] = [];
  const values = previousKeyValues(env);
  if (values.length > MAX_PREVIOUS_KEYS || values.some(value => Buffer.from(value, 'base64').length !== 32)) {
    issues.push({ name: 'TOKEN_ENCRYPTION_PREVIOUS_KEYS',
      problem: `must be at most ${MAX_PREVIOUS_KEYS} comma-separated base64 values that each decode to exactly 32 bytes` });
  }
  if (![undefined, '', 'legacy', 'v1'].includes(env.TOKEN_ENCRYPTION_WRITE_FORMAT)) {
    issues.push({ name: 'TOKEN_ENCRYPTION_WRITE_FORMAT', problem: 'must be legacy, v1, or unset' });
  }
  return issues;
}

function gcmSeal(key: Buffer, plaintext: string, aad?: Buffer) {
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv(ALGO, key, iv, { authTagLength: TAG_BYTES });
  if (aad) cipher.setAAD(aad);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return { iv, tag: cipher.getAuthTag(), ciphertext };
}

/** Returns null on any authentication failure; the cause is deliberately discarded. */
function gcmOpen(key: Buffer, iv: Buffer, tag: Buffer, ciphertext: Buffer, aad?: Buffer): string | null {
  try {
    const decipher = crypto.createDecipheriv(ALGO, key, iv, { authTagLength: TAG_BYTES });
    if (aad) decipher.setAAD(aad);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
  } catch {
    return null;
  }
}

/** Strict base64url: canonical, so one envelope has exactly one spelling. */
function fromB64url(value: string, bytes?: number): Buffer {
  if (!B64URL.test(value)) throw new CredentialEnvelopeError('malformed');
  const decoded = Buffer.from(value, 'base64url');
  if (decoded.toString('base64url') !== value || (bytes !== undefined && decoded.length !== bytes)) {
    throw new CredentialEnvelopeError('malformed');
  }
  return decoded;
}

type Parsed =
  | { format: 'legacy'; iv: Buffer; tag: Buffer; ciphertext: Buffer }
  | { format: 'v1'; keyId: string; header: string; iv: Buffer; tag: Buffer; ciphertext: Buffer };

function parse(payload: unknown): Parsed {
  if (typeof payload !== 'string' || payload === '') throw new CredentialEnvelopeError('malformed');
  if (payload.includes(':')) {
    const version = /^ce([0-9]{1,4}):/.exec(payload);
    if (!version) throw new CredentialEnvelopeError('malformed');
    if (`ce${version[1]}` !== V1) throw new CredentialEnvelopeError('unknown_version');
    const parts = payload.split(':');
    if (parts.length !== 5 || !KEY_ID.test(parts[1])) throw new CredentialEnvelopeError('malformed');
    return { format: 'v1', keyId: parts[1], header: `${V1}:${parts[1]}`,
      iv: fromB64url(parts[2], IV_BYTES), tag: fromB64url(parts[3], TAG_BYTES), ciphertext: fromB64url(parts[4]) };
  }
  // Legacy: kept as lenient about base64 spelling as the original reader, but exactly three
  // non-empty segments and the 12/16-byte IV/tag the original writer always produced. The
  // original reader accepted truncated GCM tags (Node DEP0182); those were never written.
  const parts = payload.split('.');
  if (parts.length !== 3 || parts.some(part => !part)) throw new CredentialEnvelopeError('malformed');
  const [iv, tag, ciphertext] = parts.map(part => Buffer.from(part, 'base64'));
  if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES || ciphertext.length === 0) throw new CredentialEnvelopeError('malformed');
  return { format: 'legacy', iv, tag, ciphertext };
}

/** The envelope's format and key ID, without decrypting. For rotation inventory tooling. */
export function describeCredentialEnvelope(payload: string): CredentialEnvelopeInfo {
  const parsed = parse(payload);
  return parsed.format === 'v1' ? { format: 'v1', keyId: parsed.keyId } : { format: 'legacy' };
}

export function sealCredential(plaintext: string, keyring: CredentialKeyring, format: CredentialWriteFormat = 'legacy'): string {
  const { id, key } = keyring.current;
  if (format === 'legacy') {
    // Byte-for-byte the pre-C26 writer, so a rolled-back Server still reads it.
    const { iv, tag, ciphertext } = gcmSeal(key, plaintext);
    return [iv, tag, ciphertext].map(bytes => bytes.toString('base64')).join('.');
  }
  const header = `${V1}:${id}`;
  const { iv, tag, ciphertext } = gcmSeal(key, plaintext, Buffer.from(header, 'ascii'));
  return [header, iv.toString('base64url'), tag.toString('base64url'), ciphertext.toString('base64url')].join(':');
}

export function openCredential(payload: string, keyring: CredentialKeyring): string {
  const parsed = parse(payload);
  const keys = [keyring.current, ...keyring.previous];
  if (parsed.format === 'v1') {
    const entry = keys.find(candidate => candidate.id === parsed.keyId);
    if (!entry) throw new CredentialEnvelopeError('unknown_key_id');
    const plaintext = gcmOpen(entry.key, parsed.iv, parsed.tag, parsed.ciphertext, Buffer.from(parsed.header, 'ascii'));
    if (plaintext === null) throw new CredentialEnvelopeError('authentication_failed');
    return plaintext;
  }
  // A legacy envelope names no key: try the current key, then each previous key. GCM
  // authentication rejects a wrong key, so at most 1 + MAX_PREVIOUS_KEYS attempts.
  for (const { key } of keys) {
    const plaintext = gcmOpen(key, parsed.iv, parsed.tag, parsed.ciphertext);
    if (plaintext !== null) return plaintext;
  }
  throw new CredentialEnvelopeError('authentication_failed');
}

/** Encrypts a Google access/refresh token before it is stored. */
export function encryptToken(plaintext: string): string {
  return sealCredential(plaintext, credentialKeyringFromEnv(), credentialWriteFormat());
}

export function decryptToken(payload: string): string {
  return openCredential(payload, credentialKeyringFromEnv());
}
