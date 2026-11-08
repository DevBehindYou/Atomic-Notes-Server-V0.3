import { createHash, timingSafeEqual, verify as verifySignature, type KeyObject } from 'node:crypto';

// C38 scoped gateway delegation, contract version 1. DISABLED: no deployed route,
// key, replay store or subject binding is wired. A delegation assertion is minted by a
// browser gateway for ONE of its server-side browser sessions and verified here, by the
// App Server, which remains the only authority for accounts.
//
// Wire form:  atomic-delegation-v1.<payload>.<signature>
//   payload   = base64url (no padding) of the canonical claims JSON (fixed key order,
//               no whitespace); any other encoding of the same claims is refused.
//   signature = base64url Ed25519 signature over the ASCII bytes "<header>.<payload>".
// The algorithm is fixed by the header; nothing in the assertion selects it.
//
// What a verified assertion proves: gateway `iss` (holder of key `kid`) asserts that its
// browser session `sid` belongs to App Server account `sub` and asks for `scope` until
// `exp`. The App Server still re-checks `sub` against its OWN record for (iss, sid)
// before trusting it. No claim carries a provider token, App Server bearer, wallet,
// Energy or billing authority, and no such scope exists.
//
// Deliberately pure apart from node:crypto: no database, billing, energy, ledger or
// wallet import (pinned by an import allowlist test).

export const DELEGATION_CONTRACT = 'atomic-delegation' as const;
export const DELEGATION_CONTRACT_VERSION = 1 as const;
export const DELEGATION_HEADER = 'atomic-delegation-v1' as const;
export const DELEGATION_ALGORITHM = 'Ed25519' as const;
/** The only scopes a v1 assertion may request. No wallet, Energy, billing or write scope exists. */
export const DELEGATION_SCOPES = ['notes:read'] as const;
export const MAX_ASSERTION_BYTES = 2048;
export const MAX_LIFETIME_SECONDS = 300;
export const CLOCK_SKEW_SECONDS = 30;
/** Canonical claim order. Exactly these keys, nothing else. */
export const CLAIM_ORDER = ['v', 'aud', 'iss', 'kid', 'sub', 'sid', 'scope', 'iat', 'exp', 'jti'] as const;

export type DelegationScope = typeof DELEGATION_SCOPES[number];
export type DelegationClaims = Readonly<{
  v: typeof DELEGATION_CONTRACT_VERSION; aud: string; iss: string; kid: string; sub: string; sid: string;
  scope: readonly DelegationScope[]; iat: number; exp: number; jti: string;
}>;

export const DELEGATION_ERRORS = ['delegation_malformed', 'delegation_unsupported_version', 'delegation_unknown_issuer',
  'delegation_bad_signature', 'delegation_wrong_audience', 'delegation_not_yet_valid', 'delegation_expired',
  'delegation_lifetime_exceeded', 'delegation_scope_denied', 'delegation_replayed', 'delegation_subject_mismatch'] as const;
export type DelegationError = typeof DELEGATION_ERRORS[number];
export type DelegationResult =
  | { ok: true; claims: DelegationClaims }
  | { ok: false; error: DelegationError };

/** Verification keys by gateway issuer and key id. Public keys only; the App Server cannot mint. */
export interface DelegationKeyPort { verificationKey(iss: string, kid: string): KeyObject | undefined }
/** Single-use `jti` per issuer until `expiresAtMs`. False when already seen. Must be atomic and shared in production. */
export interface DelegationReplayPort { claim(iss: string, jti: string, expiresAtMs: number): Promise<boolean> }
/**
 * The App Server's OWN record of which account a gateway session is bound to. Null when
 * there is none. The asserted `sub` is never trusted without this.
 */
export interface DelegationSubjectPort { boundAccount(iss: string, sid: string): Promise<string | null> }

export type DelegationVerifierOptions = Readonly<{
  audience: string; keys: DelegationKeyPort; replay: DelegationReplayPort; subjects: DelegationSubjectPort;
  now?: () => number;
}>;

const B64URL = /^[A-Za-z0-9_-]+$/;
const ISSUER = /^[a-z0-9][a-z0-9-]{0,62}$/;
const KEY_ID = /^[A-Za-z0-9_-]{1,64}$/;
const ACCOUNT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SESSION_REF = /^[A-Za-z0-9_-]{43}$/;
const TOKEN_ID = /^[A-Za-z0-9_-]{22,64}$/;
const AUDIENCE = /^[\x21-\x7e]{1,256}$/;
const HEADER_SHAPE = /^atomic-delegation-v[0-9]{1,4}$/;
const SIGNATURE_BYTES = 64;
const MAX_EPOCH_SECONDS = 253402300799; // 9999-12-31

/** Constant-time string equality over fixed-length digests, for any input lengths. */
export function constantTimeEqual(a: string, b: string): boolean {
  const left = createHash('sha256').update(a, 'utf8').digest(), right = createHash('sha256').update(b, 'utf8').digest();
  return timingSafeEqual(left, right);
}

function strictBase64url(text: string): Buffer | null {
  if (!B64URL.test(text)) return null;
  const bytes = Buffer.from(text, 'base64url');
  // Reject non-canonical encodings (stray trailing bits) so one byte string has one wire form.
  return bytes.toString('base64url') === text ? bytes : null;
}

/** Canonical claims JSON: fixed key order, no whitespace. The gateway must produce exactly this. */
export function canonicalClaimsJson(claims: DelegationClaims): string {
  return JSON.stringify(Object.fromEntries(CLAIM_ORDER.map(key => [key, claims[key]])));
}

/** "<header>.<payload>": the exact bytes that are signed. */
export function signingInput(claims: DelegationClaims): string {
  return `${DELEGATION_HEADER}.${Buffer.from(canonicalClaimsJson(claims), 'utf8').toString('base64url')}`;
}

const isEpoch = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0
  && (value as number) <= MAX_EPOCH_SECONDS;

type Parsed = { ok: true; claims: DelegationClaims; signed: Buffer; signature: Buffer } | { ok: false; error: DelegationError };

/** Structure only. Nothing here is trusted until the signature verifies. */
function parse(assertion: unknown): Parsed {
  const malformed = { ok: false as const, error: 'delegation_malformed' as const };
  if (typeof assertion !== 'string' || assertion.length === 0 || Buffer.byteLength(assertion) > MAX_ASSERTION_BYTES) return malformed;
  const parts = assertion.split('.');
  if (parts.length !== 3) return malformed;
  const [header, payload, sig] = parts as [string, string, string];
  if (!HEADER_SHAPE.test(header)) return malformed;
  if (header !== DELEGATION_HEADER) return { ok: false, error: 'delegation_unsupported_version' };
  const payloadBytes = strictBase64url(payload), signature = strictBase64url(sig);
  if (!payloadBytes || !signature || signature.length !== SIGNATURE_BYTES) return malformed;
  let text: string, raw: unknown;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(payloadBytes);
    raw = JSON.parse(text);
  } catch { return malformed; }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return malformed;
  const record = raw as Record<string, unknown>;
  const keys = Object.keys(record);
  // Extra fields (an accountId, a provider token, a wallet grant) and missing claims are refused.
  if (keys.length !== CLAIM_ORDER.length || !CLAIM_ORDER.every(key => Object.hasOwn(record, key))) return malformed;
  if (record.v !== DELEGATION_CONTRACT_VERSION) {
    return Number.isSafeInteger(record.v) ? { ok: false, error: 'delegation_unsupported_version' } : malformed;
  }
  const { aud, iss, kid, sub, sid, scope, iat, exp, jti } = record;
  if (typeof aud !== 'string' || !AUDIENCE.test(aud) || typeof iss !== 'string' || !ISSUER.test(iss)
    || typeof kid !== 'string' || !KEY_ID.test(kid) || typeof sub !== 'string' || !ACCOUNT_ID.test(sub)
    || typeof sid !== 'string' || !SESSION_REF.test(sid) || typeof jti !== 'string' || !TOKEN_ID.test(jti)
    || !isEpoch(iat) || !isEpoch(exp)) return malformed;
  if (!Array.isArray(scope) || scope.length === 0 || scope.length > 8 || !scope.every(s => typeof s === 'string' && s.length <= 64)
    || new Set(scope).size !== scope.length) return malformed;
  const claims = { v: DELEGATION_CONTRACT_VERSION, aud, iss, kid, sub, sid, scope: scope as DelegationScope[], iat, exp, jti };
  // One canonical encoding: duplicate keys, reordering or whitespace are refused.
  if (canonicalClaimsJson(claims) !== text) return malformed;
  return { ok: true, claims, signed: Buffer.from(`${header}.${payload}`, 'ascii'), signature };
}

/**
 * Verifies a v1 delegation assertion. Order: structure, issuer key, signature, audience,
 * time, scope, single use, then the App Server's own subject record. A refused
 * assertion never consumes a `jti` unless it was authentic and otherwise valid.
 */
export async function verifyDelegationAssertion(assertion: unknown, options: DelegationVerifierOptions): Promise<DelegationResult> {
  const parsed = parse(assertion);
  if (!parsed.ok) return parsed;
  const { claims } = parsed;
  const key = options.keys.verificationKey(claims.iss, claims.kid);
  if (!key) return { ok: false, error: 'delegation_unknown_issuer' };
  let authentic = false;
  try { authentic = key.asymmetricKeyType === 'ed25519' && verifySignature(null, parsed.signed, key, parsed.signature); } catch { authentic = false; }
  if (!authentic) return { ok: false, error: 'delegation_bad_signature' };
  if (!constantTimeEqual(claims.aud, options.audience)) return { ok: false, error: 'delegation_wrong_audience' };
  const now = Math.floor((options.now ?? Date.now)() / 1000);
  if (claims.exp <= claims.iat || claims.exp - claims.iat > MAX_LIFETIME_SECONDS) return { ok: false, error: 'delegation_lifetime_exceeded' };
  if (claims.iat > now + CLOCK_SKEW_SECONDS) return { ok: false, error: 'delegation_not_yet_valid' };
  if (now >= claims.exp + CLOCK_SKEW_SECONDS) return { ok: false, error: 'delegation_expired' };
  if (!claims.scope.every(s => (DELEGATION_SCOPES as readonly string[]).includes(s))) return { ok: false, error: 'delegation_scope_denied' };
  if (!(await options.replay.claim(claims.iss, claims.jti, (claims.exp + CLOCK_SKEW_SECONDS) * 1000))) {
    return { ok: false, error: 'delegation_replayed' };
  }
  const bound = await options.subjects.boundAccount(claims.iss, claims.sid);
  if (bound === null || !constantTimeEqual(bound, claims.sub)) return { ok: false, error: 'delegation_subject_mismatch' };
  return { ok: true, claims };
}

/** Process-local replay store for tests only. Not shared across serverless instances. */
export class MemoryReplayStore implements DelegationReplayPort {
  readonly #seen = new Map<string, number>();
  constructor(private readonly now: () => number = Date.now) {}
  async claim(iss: string, jti: string, expiresAtMs: number): Promise<boolean> {
    const at = this.now();
    for (const [id, until] of this.#seen) if (until <= at) this.#seen.delete(id);
    const id = `${iss}\0${jti}`;
    if (this.#seen.has(id)) return false;
    this.#seen.set(id, expiresAtMs);
    return true;
  }
}

