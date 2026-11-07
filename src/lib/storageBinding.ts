import { isDeepStrictEqual } from 'node:util';
import { GOOGLE_ISSUER, canonicalIssuer, isAccountId, isFolderId, subjectError } from './identityContract.js';

// C29 storage-binding reservation state machine. Pure: no database, network or clock.
//
// INTEGRATION DISABLED. Nothing in src/routes or src/app.ts imports this module or its store.
// The existing Google sign-in and Drive setup path (src/routes/auth.ts) is unchanged and does
// not consult a binding. Activation needs accepted identity/binding contracts (C28 review, B07/B08).
//
// One authoritative binding exists per library. A library initially belongs to exactly one
// account, so the binding key is the existing account UUID (users._id), never re-minted.
//
//   state         | holds                                   | leaves by
//   ------------- | --------------------------------------- | -------------------------------------------------
//   (none)        | -                                       | reserve -> reserved
//   reserved      | owner, provider, lease                  | begin_provisioning -> provisioning; release -> released;
//                 |                                         | reserve by anyone after lease expiry (takeover) -> reserved
//   provisioning  | owner, provider, idempotencyKey, lease? | complete_provisioning -> active; fail_provisioning (verified
//                 |                                         | absent) -> paused; pause -> paused (key kept);
//                 |                                         | resume_provisioning (same owner, lease expired) -> provisioning
//   active        | owner, provider, locator                | pause -> paused (locator kept)
//   paused        | owner, provider, reason, locator? key?  | reconnect (same owner) -> reconnecting | provisioning;
//                 |                                         | reprovision (explicit, names the replaced locator) -> provisioning
//   reconnecting  | owner, provider, locator, lease         | confirm_reconnect (same locator) -> active; fail_reconnect -> paused;
//                 |                                         | pause -> paused; reconnect (same owner, lease expired) -> reconnecting
//   released      | nothing reserved                        | reserve -> reserved
//
// Invariants (checked by checkRecordInvariants and the tests):
//  I1 every committed write is a compare-and-set on (accountId, generation) and advances generation by exactly 1;
//  I2 a live lease is never taken over; only an expired `reserved` lease can be taken by another identity,
//     and only through the CAS. A stale lease token or expected generation is refused, never merged;
//  I3 once provisioning starts (a provider side effect may exist), owner and provider never change until release;
//     a different identity or provider can never take over provisioning, reconnecting, active or paused;
//  I4 an unknown setup outcome stays `provisioning` (or `paused` with the same idempotency key). It is resolved by
//     an idempotent re-check with that key; failure must be provider-verified, never assumed;
//  I5 a recorded locator is never deleted or replaced by pause, reconnect or revoked consent. Only an explicit
//     reprovision that names it moves it to retiredLocators;
//  I6 reconnect requires the same provider and the same (canonical issuer, exact subject). Email is not an input;
//  I7 at most one reserved (non-released) binding per owner identity (enforced by the store).

export const BINDING_SCHEMA_VERSION = 1 as const;
export const DROPBOX_ISSUER = 'https://www.dropbox.com' as const;
export const STORAGE_PROVIDERS = ['google_drive', 'dropbox'] as const;
export const BINDING_STATES = ['reserved', 'provisioning', 'active', 'paused', 'reconnecting', 'released'] as const;
export const MIN_LEASE_MS = 1000;
export const MAX_LEASE_MS = 15 * 60 * 1000;
export const MAX_RETIRED_LOCATORS = 16;
/** The legacy Drive setup re-check is ensureAppFolders' find-or-create by app folder name. */
export const LEGACY_GOOGLE_SETUP_KEY = 'legacy-google-app-folder-v1';

export type StorageProvider = typeof STORAGE_PROVIDERS[number];
export type BindingState = typeof BINDING_STATES[number];
export type BindingOwner = { issuer: string; subject: string };
export type Locator = { kind: 'drive_folder'; folderId: string } | { kind: 'dropbox_namespace'; namespaceId: string };
export type Lease = { token: string; holder: string; expiresAt: number };
export type PauseReason = 'consent_revoked' | 'provider_unavailable' | 'setup_failed' | 'locator_unavailable';

export type BindingRecord = {
  schemaVersion: typeof BINDING_SCHEMA_VERSION;
  accountId: string;
  state: BindingState;
  generation: number;
  provider: StorageProvider;
  owner: BindingOwner;
  ownerKey: string;
  /** True for every state except `released`; the store keys owner uniqueness on it. */
  reserved: boolean;
  lease: Lease | null;
  idempotencyKey: string | null;
  locator: Locator | null;
  pauseReason: PauseReason | null;
  retiredLocators: Locator[];
  origin: 'binding_service' | 'legacy_google';
  updatedAt: number;
};

/** The authenticated requester: a verified provider identity plus the device's holder id. */
export type BindingActor = { provider: StorageProvider; issuer: string; subject: string; holder: string };

export type BindingCommand =
  | { type: 'reserve'; actor: BindingActor; token: string; leaseMs: number; expectedGeneration?: number }
  | { type: 'begin_provisioning'; actor: BindingActor; token: string; idempotencyKey: string; leaseMs: number; expectedGeneration?: number }
  | { type: 'complete_provisioning'; actor: BindingActor; token: string; idempotencyKey: string; locator: Locator; expectedGeneration?: number }
  | { type: 'fail_provisioning'; actor: BindingActor; token: string; evidence: 'provider_confirmed_absent'; expectedGeneration?: number }
  | { type: 'resume_provisioning'; actor: BindingActor; token: string; leaseMs: number; expectedGeneration?: number }
  | { type: 'release'; actor: BindingActor; token: string; expectedGeneration?: number }
  | { type: 'pause'; reason: 'consent_revoked' | 'provider_unavailable'; expectedGeneration: number }
  | { type: 'reconnect'; actor: BindingActor; token: string; leaseMs: number; idempotencyKey?: string; expectedGeneration?: number }
  | { type: 'confirm_reconnect'; actor: BindingActor; token: string; locator: Locator; expectedGeneration?: number }
  | { type: 'fail_reconnect'; actor: BindingActor; token: string; reason: 'locator_unavailable' | 'provider_unavailable' | 'consent_revoked';
      expectedGeneration?: number }
  | { type: 'reprovision'; actor: BindingActor; token: string; leaseMs: number; idempotencyKey: string; replaceLocator: Locator;
      expectedGeneration?: number };
export type BindingCommandType = BindingCommand['type'];
export const BINDING_COMMAND_TYPES: readonly BindingCommandType[] = ['reserve', 'begin_provisioning', 'complete_provisioning',
  'fail_provisioning', 'resume_provisioning', 'release', 'pause', 'reconnect', 'confirm_reconnect', 'fail_reconnect', 'reprovision'];

export type BindingError =
  | 'invalid_command' | 'invalid_actor' | 'provider_identity_mismatch' | 'invalid_token' | 'invalid_lease'
  | 'invalid_idempotency_key' | 'invalid_locator' | 'unknown_outcome_not_failure' | 'binding_record_invalid'
  | 'not_bound' | 'invalid_state' | 'binding_reserved' | 'binding_active' | 'binding_paused'
  | 'stale_generation' | 'stale_lease' | 'owner_mismatch' | 'provider_mismatch' | 'idempotency_key_mismatch'
  | 'idempotency_key_required' | 'provisioning_in_progress' | 'reconnect_in_progress' | 'locator_mismatch'
  | 'retired_locator_limit' | 'identity_bound_elsewhere' | 'contention';

export type TransitionResult =
  | { ok: true; changed: false; record: BindingRecord }
  | { ok: true; changed: true; record: BindingRecord; from: BindingState | null }
  | { ok: false; error: BindingError };

const TOKEN = /^[A-Za-z0-9_-]{16,128}$/;
const DROPBOX_NAMESPACE = /^[0-9]{1,20}$/;
const isToken = (value: unknown): value is string => typeof value === 'string' && TOKEN.test(value);
const isInt = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value);

/** Unambiguous owner-identity key used for the one-reservation-per-identity constraint. */
export const ownerKey = (provider: StorageProvider, owner: BindingOwner) =>
  JSON.stringify(['atomic-binding-owner', BINDING_SCHEMA_VERSION, provider, owner.issuer, owner.subject]);

/** Canonical issuer for the provider's identity, or null. Dropbox appears only in disposable tests: no adapter exists. */
function providerIssuer(provider: StorageProvider, raw: unknown): string | null {
  if (provider === 'google_drive') return canonicalIssuer(raw);
  return raw === DROPBOX_ISSUER ? DROPBOX_ISSUER : null;
}

function actorError(actor: unknown): BindingError | null {
  if (typeof actor !== 'object' || actor === null) return 'invalid_actor';
  const { provider, issuer, subject, holder } = actor as Record<string, unknown>;
  if (!STORAGE_PROVIDERS.includes(provider as StorageProvider) || !isToken(holder) || subjectError(subject)) return 'invalid_actor';
  return providerIssuer(provider as StorageProvider, issuer) ? null : 'provider_identity_mismatch';
}

const canonicalOwner = (actor: BindingActor): BindingOwner =>
  ({ issuer: providerIssuer(actor.provider, actor.issuer)!, subject: actor.subject });

export function isLocatorFor(provider: StorageProvider, locator: unknown): locator is Locator {
  if (typeof locator !== 'object' || locator === null || Array.isArray(locator)) return false;
  const value = locator as Record<string, unknown>;
  const keys = Object.keys(value).sort().join(',');
  if (provider === 'google_drive') return keys === 'folderId,kind' && value.kind === 'drive_folder' && isFolderId(value.folderId);
  return keys === 'kind,namespaceId' && value.kind === 'dropbox_namespace' && typeof value.namespaceId === 'string'
    && DROPBOX_NAMESPACE.test(value.namespaceId);
}
const isAnyLocator = (value: unknown) => STORAGE_PROVIDERS.some(provider => isLocatorFor(provider, value));
const sameLocator = (a: Locator | null, b: Locator | null) => a !== null && b !== null && isDeepStrictEqual(a, b);

/** Returns the violated invariants of a stored record; empty means valid. Used on every store read. */
export function checkRecordInvariants(record: unknown): string[] {
  if (typeof record !== 'object' || record === null) return ['not_object'];
  const r = record as BindingRecord;
  const problems: string[] = [];
  const need = (condition: boolean, name: string) => { if (!condition) problems.push(name); };
  need(r.schemaVersion === BINDING_SCHEMA_VERSION, 'schema_version');
  need(isAccountId(r.accountId), 'account_id');
  need(BINDING_STATES.includes(r.state), 'state');
  need(isInt(r.generation) && r.generation >= 0, 'generation');
  need(STORAGE_PROVIDERS.includes(r.provider), 'provider');
  const ownerValid = typeof r.owner === 'object' && r.owner !== null && Object.keys(r.owner).sort().join(',') === 'issuer,subject'
    && STORAGE_PROVIDERS.includes(r.provider) && providerIssuer(r.provider, r.owner.issuer) === r.owner.issuer
    && subjectError(r.owner.subject) === null;
  need(ownerValid, 'owner');
  need(ownerValid && r.ownerKey === ownerKey(r.provider, r.owner), 'owner_key');
  need(r.reserved === (r.state !== 'released'), 'reserved_flag');
  const leaseValid = r.lease === null || (typeof r.lease === 'object' && isToken(r.lease.token) && isToken(r.lease.holder)
    && isInt(r.lease.expiresAt));
  need(leaseValid, 'lease');
  need(r.idempotencyKey === null || isToken(r.idempotencyKey), 'idempotency_key');
  need(r.locator === null || isLocatorFor(r.provider, r.locator), 'locator');
  need(r.pauseReason === null || ['consent_revoked', 'provider_unavailable', 'setup_failed', 'locator_unavailable'].includes(r.pauseReason),
    'pause_reason');
  need(Array.isArray(r.retiredLocators) && r.retiredLocators.length <= MAX_RETIRED_LOCATORS && r.retiredLocators.every(isAnyLocator),
    'retired_locators');
  need(r.origin === 'binding_service' || r.origin === 'legacy_google', 'origin');
  need(isInt(r.updatedAt), 'updated_at');
  const shape: Record<BindingState, [lease: boolean | null, key: boolean | null, locator: boolean | null, reason: boolean]> = {
    // [lease present, idempotency key present, locator present, pause reason present]; null = either
    reserved: [true, false, false, false],
    provisioning: [null, true, false, false], // a legacy or paused-then-resumed setup may be unleased
    active: [false, false, true, false],
    paused: [false, null, null, true],
    reconnecting: [true, false, true, false],
    released: [false, false, false, false],
  };
  const expected = shape[r.state];
  if (expected) {
    const [lease, key, locator, reason] = expected;
    if (lease !== null) need((r.lease !== null) === lease, 'state_lease');
    if (key !== null) need((r.idempotencyKey !== null) === key, 'state_idempotency_key');
    if (locator !== null) need((r.locator !== null) === locator, 'state_locator');
    need((r.pauseReason !== null) === reason, 'state_pause_reason');
    if (r.state === 'paused') need(r.locator === null || r.idempotencyKey === null, 'paused_key_with_locator');
  }
  return problems;
}

function commandError(command: BindingCommand): BindingError | null {
  if (typeof command !== 'object' || command === null || !BINDING_COMMAND_TYPES.includes(command.type)) return 'invalid_command';
  const c = command as Record<string, unknown>;
  if (c.expectedGeneration !== undefined && !(isInt(c.expectedGeneration) && c.expectedGeneration >= 0)) return 'invalid_command';
  if (command.type === 'pause') {
    if (c.expectedGeneration === undefined) return 'invalid_command'; // a pause observed under one generation must not hit a later one
    return command.reason === 'consent_revoked' || command.reason === 'provider_unavailable' ? null : 'invalid_command';
  }
  const actor = actorError(c.actor);
  if (actor) return actor;
  if (!isToken(c.token)) return 'invalid_token';
  if ('leaseMs' in c && !(isInt(c.leaseMs) && c.leaseMs >= MIN_LEASE_MS && c.leaseMs <= MAX_LEASE_MS)) return 'invalid_lease';
  if (command.type === 'fail_provisioning' && command.evidence !== 'provider_confirmed_absent') return 'unknown_outcome_not_failure';
  if (command.type === 'fail_reconnect' && !['locator_unavailable', 'provider_unavailable', 'consent_revoked'].includes(command.reason)) {
    return 'invalid_command';
  }
  const key = c.idempotencyKey;
  const keyRequired = command.type === 'begin_provisioning' || command.type === 'complete_provisioning' || command.type === 'reprovision';
  if ((keyRequired || key !== undefined) && !isToken(key)) return 'invalid_idempotency_key';
  return null;
}

/**
 * Pure transition: evaluates one command against the current record (null when none exists) at time `now`.
 * It never performs I/O; the caller commits `record` with a CAS on the previous generation.
 */
export function transition(accountId: string, current: BindingRecord | null, command: BindingCommand, now: number): TransitionResult {
  const fail = (error: BindingError): TransitionResult => ({ ok: false, error });
  if (!isAccountId(accountId) || !isInt(now) || now < 0) return fail('invalid_command');
  const invalid = commandError(command);
  if (invalid) return fail(invalid);
  if (current !== null && (current.accountId !== accountId || checkRecordInvariants(current).length > 0)) return fail('binding_record_invalid');

  const noop = (record: BindingRecord): TransitionResult => ({ ok: true, changed: false, record });
  const stale = () => command.expectedGeneration !== undefined && command.expectedGeneration !== (current?.generation ?? 0);
  const commit = (base: BindingRecord, patch: Partial<BindingRecord>): TransitionResult => {
    if (stale()) return fail('stale_generation');
    const state = patch.state ?? base.state;
    const record: BindingRecord = { ...base, ...patch, state, reserved: state !== 'released',
      generation: (current?.generation ?? 0) + 1, updatedAt: now };
    return { ok: true, changed: true, record, from: current?.state ?? null };
  };
  const lease = (actor: BindingActor, token: string, leaseMs: number): Lease => ({ token, holder: actor.holder, expiresAt: now + leaseMs });
  const ownerError = (record: BindingRecord, actor: BindingActor): BindingError | null => {
    if (record.provider !== actor.provider) return 'provider_mismatch';
    const owner = canonicalOwner(actor);
    return owner.issuer === record.owner.issuer && owner.subject === record.owner.subject ? null : 'owner_mismatch';
  };
  const holds = (record: BindingRecord, token: string) => record.lease !== null && record.lease.token === token;
  const expired = (record: BindingRecord) => record.lease === null || now >= record.lease.expiresAt;

  if (command.type === 'pause') {
    if (current === null || current.state === 'released' || current.state === 'reserved') return fail('not_bound');
    if (current.state === 'paused') return noop(current);
    return commit(current, { state: 'paused', lease: null, pauseReason: command.reason });
  }

  const { actor } = command;
  if (command.type === 'reserve') {
    const fresh = (): Partial<BindingRecord> => {
      const owner = canonicalOwner(actor);
      return { state: 'reserved', provider: actor.provider, owner, ownerKey: ownerKey(actor.provider, owner),
        lease: lease(actor, command.token, command.leaseMs), idempotencyKey: null, locator: null, pauseReason: null, origin: 'binding_service' };
    };
    if (current === null || current.state === 'released') {
      const base = current ?? { schemaVersion: BINDING_SCHEMA_VERSION, accountId, retiredLocators: [] } as unknown as BindingRecord;
      return commit({ ...base, retiredLocators: [...base.retiredLocators] }, fresh());
    }
    if (current.state === 'reserved') {
      if (holds(current, command.token)) return ownerError(current, actor) ? fail('stale_lease') : noop(current);
      if (!expired(current)) return fail('binding_reserved');
      return commit(current, fresh()); // takeover: no provider effect was started under the expired reservation
    }
    if (current.state === 'active') return fail('binding_active');
    if (current.state === 'paused') return fail('binding_paused');
    return fail('binding_reserved');
  }

  if (current === null) return fail('not_bound');
  const owner = ownerError(current, actor);

  switch (command.type) {
    case 'begin_provisioning': {
      if (current.state === 'provisioning' && holds(current, command.token) && !owner) {
        return current.idempotencyKey === command.idempotencyKey ? noop(current) : fail('idempotency_key_mismatch');
      }
      if (current.state !== 'reserved') return fail('invalid_state');
      if (owner) return fail(owner);
      if (!holds(current, command.token)) return fail('stale_lease');
      // Intent before effect: the provider call may start only after this write commits.
      return commit(current, { state: 'provisioning', lease: lease(actor, command.token, command.leaseMs),
        idempotencyKey: command.idempotencyKey });
    }
    case 'complete_provisioning': {
      if (current.state === 'active' && !owner && sameLocator(current.locator, command.locator)) return noop(current);
      if (current.state !== 'provisioning') return fail('invalid_state');
      if (owner) return fail(owner);
      if (!holds(current, command.token)) return fail('stale_lease');
      if (current.idempotencyKey !== command.idempotencyKey) return fail('idempotency_key_mismatch');
      if (!isLocatorFor(current.provider, command.locator)) return fail('invalid_locator');
      return commit(current, { state: 'active', lease: null, idempotencyKey: null, locator: { ...command.locator }, pauseReason: null });
    }
    case 'fail_provisioning': {
      if (current.state === 'paused' && !owner && current.pauseReason === 'setup_failed' && current.locator === null
        && current.idempotencyKey === null) return noop(current);
      if (current.state !== 'provisioning') return fail('invalid_state');
      if (owner) return fail(owner);
      if (!holds(current, command.token)) return fail('stale_lease');
      return commit(current, { state: 'paused', lease: null, idempotencyKey: null, pauseReason: 'setup_failed' });
    }
    case 'resume_provisioning': {
      if (current.state !== 'provisioning') return fail('invalid_state');
      if (owner) return fail('binding_reserved'); // never stolen by another identity or provider, even after expiry
      if (holds(current, command.token)) return noop(current);
      if (!expired(current)) return fail('provisioning_in_progress');
      // Same idempotency key: the re-check finds what an interrupted attempt may already have created.
      return commit(current, { lease: lease(actor, command.token, command.leaseMs) });
    }
    case 'release': {
      if (current.state === 'released') return noop(current);
      if (current.state !== 'reserved') return fail('invalid_state');
      if (owner) return fail(owner);
      if (!holds(current, command.token)) return fail('stale_lease');
      return commit(current, { state: 'released', lease: null });
    }
    case 'reconnect': {
      if (current.state === 'released') return fail('not_bound');
      if (current.state === 'reserved' || current.state === 'provisioning') return fail('invalid_state');
      if (owner) return fail(owner);
      if (current.state === 'active') return noop(current);
      if (current.state === 'reconnecting') {
        if (holds(current, command.token)) return noop(current);
        if (!expired(current)) return fail('reconnect_in_progress');
        return commit(current, { lease: lease(actor, command.token, command.leaseMs) });
      }
      // paused: keep the locator; verify it under the new consent before resuming.
      if (current.locator !== null) {
        return commit(current, { state: 'reconnecting', lease: lease(actor, command.token, command.leaseMs), pauseReason: null });
      }
      const key = current.idempotencyKey ?? command.idempotencyKey; // an unresolved setup resumes with its original key
      if (!key) return fail('idempotency_key_required');
      return commit(current, { state: 'provisioning', lease: lease(actor, command.token, command.leaseMs), idempotencyKey: key,
        pauseReason: null });
    }
    case 'confirm_reconnect': {
      if (current.state === 'active' && !owner && sameLocator(current.locator, command.locator)) return noop(current);
      if (current.state !== 'reconnecting') return fail('invalid_state');
      if (owner) return fail(owner);
      if (!holds(current, command.token)) return fail('stale_lease');
      if (!sameLocator(current.locator, command.locator)) return fail('locator_mismatch'); // never silently replaced
      return commit(current, { state: 'active', lease: null });
    }
    case 'fail_reconnect': {
      if (current.state === 'paused' && !owner && current.pauseReason === command.reason) return noop(current);
      if (current.state !== 'reconnecting') return fail('invalid_state');
      if (owner) return fail(owner);
      if (!holds(current, command.token)) return fail('stale_lease');
      return commit(current, { state: 'paused', lease: null, pauseReason: command.reason });
    }
    case 'reprovision': {
      if (current.state === 'provisioning' && !owner && holds(current, command.token)
        && current.idempotencyKey === command.idempotencyKey) return noop(current);
      if (current.state !== 'paused' || current.locator === null) return fail('invalid_state');
      if (owner) return fail(owner);
      if (!sameLocator(current.locator, command.replaceLocator)) return fail('locator_mismatch');
      if (current.retiredLocators.length >= MAX_RETIRED_LOCATORS) return fail('retired_locator_limit');
      return commit(current, { state: 'provisioning', lease: lease(actor, command.token, command.leaseMs),
        idempotencyKey: command.idempotencyKey, locator: null, pauseReason: null,
        retiredLocators: [...current.retiredLocators, current.locator] });
    }
  }
}

// ---------------------------------------------------------------------------
// Persistence port and CAS service
// ---------------------------------------------------------------------------

export type CasOutcome = 'ok' | 'conflict' | 'identity_conflict';
export interface BindingStore {
  get(accountId: string): Promise<BindingRecord | null>;
  /** Writes `next` only if the record is absent (expectedGeneration null) or still at expectedGeneration. */
  compareAndSet(accountId: string, expectedGeneration: number | null, next: BindingRecord): Promise<CasOutcome>;
}

/**
 * Read, evaluate, CAS. A lost CAS re-reads and re-evaluates the same command against the newer record, so a
 * race can only turn into the outcome the winner left behind (refusal or idempotent no-op), never a merge.
 */
export async function applyBindingCommand(store: BindingStore, accountId: string, command: BindingCommand, now: () => number,
  maxAttempts = 4): Promise<TransitionResult> {
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const current = await store.get(accountId);
    const result = transition(accountId, current, command, now());
    if (!result.ok || !result.changed) return result;
    const outcome = await store.compareAndSet(accountId, current?.generation ?? null, result.record);
    if (outcome === 'ok') return result;
    if (outcome === 'identity_conflict') return { ok: false, error: 'identity_bound_elsewhere' };
  }
  return { ok: false, error: 'contention' };
}

// ---------------------------------------------------------------------------
// Read-only legacy Google adapter
// ---------------------------------------------------------------------------

export type LegacyGoogleAccountRow = { userId: unknown; googleAccountId: unknown; driveRootFolderId: unknown };
export type LegacyMappingError = 'invalid_account_id' | 'invalid_subject' | 'folder_invalid' | 'multiple_google_accounts';
export type LegacyMapping = { ok: true; record: BindingRecord } | { ok: false; error: LegacyMappingError };

/**
 * Projects one user's current google_accounts rows into the binding shape without writing anything.
 * A recorded Drive folder becomes `active` with driveRootFolderId byte for byte. A missing folder is the
 * real "setup did not finish" state: auth.ts writes the rows before Drive setup, so the outcome is unknown and
 * maps to unleased `provisioning`, resolved by the existing idempotent find-or-create re-check, not by failure.
 */
export function bindingFromLegacyGoogle(rows: readonly LegacyGoogleAccountRow[], observedAt: number): LegacyMapping {
  if (rows.length !== 1) return { ok: false, error: 'multiple_google_accounts' };
  const [row] = rows;
  if (!isAccountId(row.userId)) return { ok: false, error: 'invalid_account_id' };
  if (subjectError(row.googleAccountId)) return { ok: false, error: 'invalid_subject' };
  const folder = row.driveRootFolderId;
  if (folder !== null && !isFolderId(folder)) return { ok: false, error: 'folder_invalid' };
  const owner = { issuer: GOOGLE_ISSUER as string, subject: row.googleAccountId as string };
  const base = { schemaVersion: BINDING_SCHEMA_VERSION, accountId: row.userId, generation: 0, provider: 'google_drive' as const, owner,
    ownerKey: ownerKey('google_drive', owner), reserved: true, lease: null, pauseReason: null, retiredLocators: [],
    origin: 'legacy_google' as const, updatedAt: observedAt };
  const record: BindingRecord = folder === null
    ? { ...base, state: 'provisioning', idempotencyKey: LEGACY_GOOGLE_SETUP_KEY, locator: null }
    : { ...base, state: 'active', idempotencyKey: null, locator: { kind: 'drive_folder', folderId: folder as string } };
  return { ok: true, record };
}
