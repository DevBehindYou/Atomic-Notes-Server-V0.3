import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import {
  GOOGLE_ISSUER, MAX_FOLDER_ID_LENGTH, MAX_SUBJECT_LENGTH, PROPOSED_ADDITIVE_FIELDS, canonicalIssuer, checkOldReaderCompatibility,
  identityFromLegacy, identityKey, libraryFromLegacy, parseIdentityRecord, parseLibraryRecord,
} from '../src/lib/identityContract.js';
import { googleAccountSchema, userSchema } from '../src/db/collections.js';

// C28 contract: strict, versioned, bounded, Google-only. No database.
const accountId = randomUUID();
const identity = (extra: Record<string, unknown> = {}) => ({ contractVersion: 1, kind: 'external_identity', accountId,
  provider: 'google', issuer: GOOGLE_ISSUER, subject: '109876543210987654321', ...extra });
const library = (extra: Record<string, unknown> = {}) => ({ contractVersion: 1, kind: 'library', accountId, provider: 'google_drive',
  owner: { provider: 'google', issuer: GOOGLE_ISSUER, subject: '109876543210987654321' }, locator: { folderId: '1AbC_d-9' }, ...extra });
const errorOf = (result: { ok: boolean; error?: string }) => result.ok ? 'ok' : result.error;

test('a valid v1 identity parses to a fresh canonical record and preserves the account UUID exactly', () => {
  const input = Object.freeze(identity({ accountId: accountId.toUpperCase(), issuer: 'accounts.google.com' }));
  const parsed = parseIdentityRecord(input);
  assert.ok(parsed.ok);
  assert.deepEqual(parsed.value, { ...identity(), accountId: accountId.toUpperCase() });
  assert.notEqual(parsed.value as object, input);
  assert.equal(input.issuer, 'accounts.google.com', 'input is not modified');
});

test('issuer normalization accepts only the Google forms and rejects look-alikes', () => {
  for (const raw of ['https://accounts.google.com', 'accounts.google.com', 'HTTPS://Accounts.Google.com', 'https://accounts.google.com/',
    'ACCOUNTS.GOOGLE.COM/']) {
    assert.equal(canonicalIssuer(raw), GOOGLE_ISSUER, raw);
  }
  for (const raw of ['http://accounts.google.com', 'https://accounts.google.com.evil.test', 'https://evil.test/accounts.google.com',
    'https://user@accounts.google.com', 'https://accounts.google.com:443', 'https://accounts.google.com//', 'https://accounts.google.com/x',
    'https://accounts.google.com?x=1', ' https://accounts.google.com', 'https://accounts.google.com\n', 'https://www.dropbox.com', '',
    'x'.repeat(300), 42, null, undefined]) {
    assert.equal(canonicalIssuer(raw), null, JSON.stringify(raw));
    if (typeof raw === 'string') assert.equal(errorOf(parseIdentityRecord(identity({ issuer: raw }))), 'invalid_issuer');
  }
});

test('unknown or missing versions are rejected before any other field is interpreted', () => {
  for (const version of [0, 2, '1', 1.5, null, undefined]) {
    assert.equal(errorOf(parseIdentityRecord(identity({ contractVersion: version, issuer: 'bad' }))), 'unsupported_version', String(version));
    assert.equal(errorOf(parseLibraryRecord(library({ contractVersion: version }))), 'unsupported_version');
  }
  const { contractVersion: _, ...withoutVersion } = identity();
  assert.equal(errorOf(parseIdentityRecord(withoutVersion)), 'unsupported_version');
  for (const value of [null, [], 'x', 1, new Date(), new Map()]) assert.equal(errorOf(parseIdentityRecord(value)), 'not_object');
});

test('unknown and missing fields are rejected, including nested and prototype-named fields', () => {
  assert.equal(errorOf(parseIdentityRecord(identity({ email: 'person@example.test' }))), 'unknown_field');
  assert.equal(errorOf(parseIdentityRecord(JSON.parse(JSON.stringify(identity()).replace('{', '{"__proto__":1,')))), 'unknown_field');
  const { subject: _, ...withoutSubject } = identity();
  assert.equal(errorOf(parseIdentityRecord(withoutSubject)), 'missing_field');
  assert.equal(errorOf(parseLibraryRecord(library({ libraryId: randomUUID() }))), 'unknown_field', 'library ids are not minted by v1');
  assert.equal(errorOf(parseLibraryRecord(library({ locator: { folderId: 'a', path: '/x' } }))), 'unknown_field');
  assert.equal(errorOf(parseLibraryRecord(library({ owner: { provider: 'google', issuer: GOOGLE_ISSUER, subject: '1', email: 'e' } }))), 'unknown_field');
  assert.equal(errorOf(parseLibraryRecord(library({ locator: {} }))), 'missing_field');
  assert.equal(errorOf(parseIdentityRecord(identity({ kind: 'library' }))), 'invalid_kind');
});

test('subjects are bounded printable ASCII, case-preserved, and never email-shaped', () => {
  assert.ok(parseIdentityRecord(identity({ subject: 'A'.repeat(MAX_SUBJECT_LENGTH) })).ok);
  assert.equal(errorOf(parseIdentityRecord(identity({ subject: 'A'.repeat(MAX_SUBJECT_LENGTH + 1) }))), 'invalid_subject');
  for (const subject of ['', ' 123', '123 ', '12\t3', '12\u00003', 'café', 123, null]) {
    assert.equal(errorOf(parseIdentityRecord(identity({ subject }))), 'invalid_subject', JSON.stringify(subject));
  }
  assert.equal(errorOf(parseIdentityRecord(identity({ subject: 'person@example.test' }))), 'subject_email_shaped');
  const upper = parseIdentityRecord(identity({ subject: 'AbC' })), lower = parseIdentityRecord(identity({ subject: 'abc' }));
  assert.ok(upper.ok && lower.ok);
  assert.notEqual(identityKey(upper.value), identityKey(lower.value), 'subjects compare exactly');
});

test('account ids must be UUIDs and only the Google provider is recognised', () => {
  for (const id of ['legacy-user', '', randomUUID().slice(1), 7, null]) {
    assert.equal(errorOf(parseIdentityRecord(identity({ accountId: id }))), 'invalid_account_id', String(id));
  }
  assert.equal(errorOf(parseIdentityRecord(identity({ provider: 'dropbox', issuer: 'https://www.dropbox.com' }))), 'unsupported_provider');
  assert.equal(errorOf(parseLibraryRecord(library({ provider: 'dropbox_app_folder' }))), 'unsupported_provider');
  assert.equal(errorOf(parseLibraryRecord(library({ owner: { provider: 'dropbox', issuer: GOOGLE_ISSUER, subject: '1' } }))), 'unsupported_provider');
});

test('library locators are bounded Drive folder ids', () => {
  assert.ok(parseLibraryRecord(library({ locator: { folderId: 'a'.repeat(MAX_FOLDER_ID_LENGTH) } })).ok);
  for (const folderId of ['', 'a'.repeat(MAX_FOLDER_ID_LENGTH + 1), 'bad folder', '../x', 'a/b', null, 5]) {
    assert.equal(errorOf(parseLibraryRecord(library({ locator: { folderId } }))), 'invalid_locator', JSON.stringify(folderId));
  }
  assert.equal(errorOf(parseLibraryRecord(library({ locator: 'folder' }))), 'invalid_locator');
});

test('identity keys are unambiguous tuples', () => {
  const a = { provider: 'google' as const, issuer: GOOGLE_ISSUER, subject: '1","2' };
  const b = { provider: 'google' as const, issuer: GOOGLE_ISSUER, subject: '1' };
  assert.notEqual(identityKey(a), identityKey(b));
  assert.deepEqual(JSON.parse(identityKey(a)), ['atomic-identity', 1, 'google', GOOGLE_ISSUER, '1","2']);
});

test('old readers: legacy documents parse with the contract and with the current schemas, with or without proposed fields', () => {
  const now = new Date('2030-01-01T00:00:00.000Z');
  const user = { _id: accountId, email: 'person@example.test', displayName: null, createdAt: now, updatedAt: now };
  const account = { _id: randomUUID(), userId: accountId, googleAccountId: '109876543210987654321', encryptedAccessToken: 'iv.tag.ct',
    encryptedRefreshToken: 'iv.tag.ct', tokenExpiry: now, driveRootFolderId: '1AbC_d-9', createdAt: now };
  assert.ok(userSchema.safeParse(user).success && googleAccountSchema.safeParse(account).success);
  assert.ok(identityFromLegacy(user._id, account.googleAccountId).ok);
  assert.ok(libraryFromLegacy(user._id, account.googleAccountId, account.driveRootFolderId).ok);
  assert.deepEqual(checkOldReaderCompatibility('users', user), { acceptedBefore: true, acceptedAfter: true, unchanged: true });
  assert.deepEqual(checkOldReaderCompatibility('google_accounts', account), { acceptedBefore: true, acceptedAfter: true, unchanged: true });
  // A document the current reader already rejects stays rejected; the proposal does not repair or break it.
  const { email: _, ...noEmail } = user;
  assert.deepEqual(checkOldReaderCompatibility('users', noEmail), { acceptedBefore: false, acceptedAfter: false, unchanged: true });
  // The proposed fields are additive only: none collide with a field a current reader understands.
  for (const [collection, fields] of Object.entries(PROPOSED_ADDITIVE_FIELDS)) {
    const shape = collection === 'users' ? userSchema.shape : googleAccountSchema.shape;
    for (const field of Object.keys(fields)) assert.ok(!(field in shape), `${collection}.${field}`);
  }
  // Legacy pending setup (folder not yet created) is a valid identity but not yet a library.
  assert.ok(identityFromLegacy(accountId, account.googleAccountId).ok);
  assert.equal(errorOf(libraryFromLegacy(accountId, account.googleAccountId, null)), 'invalid_locator');
});
