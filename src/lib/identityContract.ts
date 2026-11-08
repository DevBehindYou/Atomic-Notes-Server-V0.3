import { isDeepStrictEqual } from 'node:util';
import { googleAccountSchema, userSchema } from '../db/collections.js';

// C28 identity/library contract, version 1. Pure: no database, network or clock.
//
// An identity is a verified external (issuer, subject) pair mapped to an EXISTING
// Atomic account UUID (users._id). The UUID is preserved byte for byte and is never
// re-minted: it is the wallet owner, the note owner and the vault KDF input.
// A library is the account's storage location. Today that is only the Google Drive
// folder recorded in google_accounts.driveRootFolderId, owned by that Google identity.
//
// Version 1 recognises the Google provider only. Other providers (for example
// Dropbox, issuer https://www.dropbox.com) are deliberately rejected as
// `unsupported_provider`: this contract activates no new provider. Email is not part
// of either record and is never an identity or linking key.
//
// Library IDs are not part of v1. They are opaque server-generated UUIDs that only an
// approved apply step may mint; the dry run plans the mapping, not the new IDs.

export const IDENTITY_CONTRACT_VERSION = 1 as const;
export const GOOGLE_ISSUER = 'https://accounts.google.com' as const;
export const MAX_ISSUER_LENGTH = 256;
/** Google documents `sub` as at most 255 case-sensitive ASCII characters. */
export const MAX_SUBJECT_LENGTH = 255;
export const MAX_FOLDER_ID_LENGTH = 256;

const ACCOUNT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SUBJECT = /^[\x21-\x7e]+$/; // printable ASCII, no space or control characters
const FOLDER_ID = /^[A-Za-z0-9_-]+$/; // Drive file ID alphabet

export type IdentityRecordV1 = {
  contractVersion: 1;
  kind: 'external_identity';
  accountId: string;
  provider: 'google';
  issuer: typeof GOOGLE_ISSUER;
  subject: string;
};
export type LibraryRecordV1 = {
  contractVersion: 1;
  kind: 'library';
  accountId: string;
  provider: 'google_drive';
  owner: { provider: 'google'; issuer: typeof GOOGLE_ISSUER; subject: string };
  locator: { folderId: string };
};

export type ContractError =
  | 'not_object' | 'unsupported_version' | 'unknown_field' | 'missing_field' | 'invalid_kind'
  | 'invalid_account_id' | 'unsupported_provider' | 'invalid_issuer' | 'invalid_subject'
  | 'subject_email_shaped' | 'invalid_locator';
export type Parsed<T> = { ok: true; value: T } | { ok: false; error: ContractError };

const IDENTITY_FIELDS = ['contractVersion', 'kind', 'accountId', 'provider', 'issuer', 'subject'] as const;
const LIBRARY_FIELDS = ['contractVersion', 'kind', 'accountId', 'provider', 'owner', 'locator'] as const;
const OWNER_FIELDS = ['provider', 'issuer', 'subject'] as const;
const LOCATOR_FIELDS = ['folderId'] as const;

/**
 * Canonical issuer, or null. Google ID tokens carry either form below; scheme and host
 * compare case-insensitively and one trailing slash is tolerated. Anything else
 * (http, other hosts, ports, paths, queries, userinfo, whitespace) is rejected, not repaired.
 */
export function canonicalIssuer(raw: unknown): typeof GOOGLE_ISSUER | null {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > MAX_ISSUER_LENGTH) return null;
  if (/[\s\x00-\x1f\x7f]/.test(raw)) return null;
  let value = raw.toLowerCase();
  if (value.endsWith('/')) value = value.slice(0, -1);
  return value === GOOGLE_ISSUER || value === 'accounts.google.com' ? GOOGLE_ISSUER : null;
}

/** Validates a Google subject exactly as stored; it is never case-folded or trimmed. */
export function subjectError(subject: unknown): ContractError | null {
  if (typeof subject !== 'string' || subject.length === 0 || subject.length > MAX_SUBJECT_LENGTH || !SUBJECT.test(subject)) {
    return 'invalid_subject';
  }
  // An email in the subject slot means email was used as identity. Never accept it.
  return subject.includes('@') ? 'subject_email_shaped' : null;
}

export const isAccountId = (value: unknown): value is string => typeof value === 'string' && ACCOUNT_ID.test(value);
export const isFolderId = (value: unknown): value is string => typeof value === 'string' && value.length > 0
  && value.length <= MAX_FOLDER_ID_LENGTH && FOLDER_ID.test(value);

const isPlainObject = (value: unknown): value is Record<string, unknown> => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
};

function exactFields(value: Record<string, unknown>, allowed: readonly string[]): ContractError | null {
  for (const key of Object.keys(value)) if (!allowed.includes(key)) return 'unknown_field';
  for (const key of allowed) if (!Object.hasOwn(value, key)) return 'missing_field';
  return null;
}

/** The version is checked before anything else: an unknown version is never partially interpreted. */
function versioned(input: unknown, allowed: readonly string[], kind: string): ContractError | Record<string, unknown> {
  if (!isPlainObject(input)) return 'not_object';
  if (input.contractVersion !== IDENTITY_CONTRACT_VERSION) return 'unsupported_version';
  const fields = exactFields(input, allowed);
  if (fields) return fields;
  return input.kind === kind ? input : 'invalid_kind';
}

function parseOwner(input: unknown): ContractError | LibraryRecordV1['owner'] {
  if (!isPlainObject(input)) return 'not_object';
  const fields = exactFields(input, OWNER_FIELDS);
  if (fields) return fields;
  if (input.provider !== 'google') return 'unsupported_provider';
  const issuer = canonicalIssuer(input.issuer);
  if (!issuer) return 'invalid_issuer';
  const subject = subjectError(input.subject);
  if (subject) return subject;
  return { provider: 'google', issuer, subject: input.subject as string };
}

/** Strict v1 parser. Returns a fresh object with a canonical issuer; the input is not modified. */
export function parseIdentityRecord(input: unknown): Parsed<IdentityRecordV1> {
  const value = versioned(input, IDENTITY_FIELDS, 'external_identity');
  if (typeof value === 'string') return { ok: false, error: value };
  if (!isAccountId(value.accountId)) return { ok: false, error: 'invalid_account_id' };
  const owner = parseOwner({ provider: value.provider, issuer: value.issuer, subject: value.subject });
  if (typeof owner === 'string') return { ok: false, error: owner };
  return { ok: true, value: { contractVersion: 1, kind: 'external_identity', accountId: value.accountId, ...owner } };
}

export function parseLibraryRecord(input: unknown): Parsed<LibraryRecordV1> {
  const value = versioned(input, LIBRARY_FIELDS, 'library');
  if (typeof value === 'string') return { ok: false, error: value };
  if (!isAccountId(value.accountId)) return { ok: false, error: 'invalid_account_id' };
  if (value.provider !== 'google_drive') return { ok: false, error: 'unsupported_provider' };
  const owner = parseOwner(value.owner);
  if (typeof owner === 'string') return { ok: false, error: owner };
  if (!isPlainObject(value.locator)) return { ok: false, error: 'invalid_locator' };
  const locatorFields = exactFields(value.locator, LOCATOR_FIELDS);
  if (locatorFields) return { ok: false, error: locatorFields };
  if (!isFolderId(value.locator.folderId)) return { ok: false, error: 'invalid_locator' };
  return { ok: true, value: { contractVersion: 1, kind: 'library', accountId: value.accountId, provider: 'google_drive',
    owner, locator: { folderId: value.locator.folderId } } };
}

/**
 * Unambiguous tuple encoding for uniqueness: (version, provider, canonical issuer, exact subject).
 * JSON array encoding cannot be confused by separators inside a component.
 */
export const identityKey = (record: Pick<IdentityRecordV1, 'provider' | 'issuer' | 'subject'>) =>
  JSON.stringify(['atomic-identity', IDENTITY_CONTRACT_VERSION, record.provider, record.issuer, record.subject]);

/** Builds v1 records from the current (legacy) users/google_accounts fields only. */
export function identityFromLegacy(accountId: unknown, googleAccountId: unknown): Parsed<IdentityRecordV1> {
  return parseIdentityRecord({ contractVersion: 1, kind: 'external_identity', accountId, provider: 'google',
    issuer: GOOGLE_ISSUER, subject: googleAccountId });
}
export function libraryFromLegacy(accountId: unknown, googleAccountId: unknown, driveRootFolderId: unknown): Parsed<LibraryRecordV1> {
  return parseLibraryRecord({ contractVersion: 1, kind: 'library', accountId, provider: 'google_drive',
    owner: { provider: 'google', issuer: GOOGLE_ISSUER, subject: googleAccountId }, locator: { folderId: driveRootFolderId } });
}

// ---------------------------------------------------------------------------
// Old-reader compatibility
// ---------------------------------------------------------------------------

/**
 * Fields a future, separately approved backfill might add. Proposed only: this task
 * writes nothing. They are additive and optional so that current readers keep working.
 */
export const PROPOSED_ADDITIVE_FIELDS = {
  users: { identityContractVersion: IDENTITY_CONTRACT_VERSION },
  google_accounts: { identityContractVersion: IDENTITY_CONTRACT_VERSION },
} as const;
const CURRENT_READERS = { users: userSchema, google_accounts: googleAccountSchema } as const;

export type OldReaderOutcome = { acceptedBefore: boolean; acceptedAfter: boolean; unchanged: boolean };

/**
 * Parses a stored document with the CURRENT zod reader, before and after adding the
 * proposed fields. `unchanged` means the reader accepts or rejects both identically and,
 * when it accepts, yields the same value (current schemas strip unknown keys).
 */
export function checkOldReaderCompatibility(collection: keyof typeof CURRENT_READERS, doc: unknown): OldReaderOutcome {
  const reader = CURRENT_READERS[collection];
  const before = reader.safeParse(doc);
  const after = reader.safeParse(isPlainObject(doc) ? { ...doc, ...PROPOSED_ADDITIVE_FIELDS[collection] } : doc);
  return { acceptedBefore: before.success, acceptedAfter: after.success,
    unchanged: before.success === after.success && (!before.success || isDeepStrictEqual(before.data, after.data)) };
}
