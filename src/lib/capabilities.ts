import { remoteNoteRowSchema } from '../types/noteWire.js';

// C30 capability and sync contract, version 1. Pure: no database, network, clock,
// session or wallet. A capability document DESCRIBES which contract versions this
// deployment speaks; it never grants anything. Every route keeps its own gate
// (authentication, rollout flag, energy charge, locks) and ignores capability
// declarations entirely, so a client that declares more than it is allowed gets no
// free write, no wallet authority and no early activation of a V2 or inactive contract.
//
// Deliberately not imported here: billing, energy, ledger and wallet modules, and the
// disabled identity (C28) and storage binding (C29) modules. Their versions are
// restated below as `defined` drafts and pinned against the source by unit tests.

export const CAPABILITY_CONTRACT = 'atomic-capabilities' as const;
export const CAPABILITY_CONTRACT_VERSION = 1 as const;
/** Request header a client uses to declare the versions it speaks. Absent means a legacy client. */
export const CAPABILITY_HEADER = 'atomic-capabilities' as const;
export const CAPABILITY_HEADER_MAX_BYTES = 512;

/**
 * The existing logout/recovery HTTP contract (logout-attempt, recovery-status,
 * recovery-receipts, recovery-commit) as first shipped. It matches the frozen
 * attempt `format: 1` in logoutContract.ts; a test pins the two together.
 */
export const LOGOUT_RECOVERY_CONTRACT_VERSION = 1 as const;
/** Draft versions defined in code but inactive. Pinned to the identity and binding contract sources by tests. */
const IDENTITY_DRAFT_VERSION = 1;
const PROVIDER_BINDING_DRAFT_VERSION = 1;

/** The rollout flag shared with the notes route. Disabled unless explicitly enabled. */
export const logoutSyncFromEnv = () => process.env.ATOMIC_LOGOUT_SYNC_ENABLED === 'true';

export type FeatureStatus = 'active' | 'disabled' | 'inactive' | 'server_internal' | 'unsupported';
export type Feature = Readonly<{ status: FeatureStatus; supported: readonly number[]; defined?: readonly number[] }>;
export const FEATURE_NAMES = ['capabilities', 'noteEnvelope', 'logoutRecovery', 'credentialEnvelope',
  'identity', 'providerBinding', 'delegation'] as const;
export type FeatureName = typeof FEATURE_NAMES[number];
export type CapabilityDocument = Readonly<{
  contract: typeof CAPABILITY_CONTRACT; version: typeof CAPABILITY_CONTRACT_VERSION;
  features: Readonly<Record<FeatureName, Feature>>;
}>;

/** The `enc_v` values the note wire schema accepts, read from the schema itself. */
function noteEnvelopeVersions(): number[] {
  const encV = remoteNoteRowSchema.shape.enc_v as unknown as { options: readonly { value: unknown }[] };
  return encV.options.map(option => option.value as number).sort((a, b) => a - b);
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

/**
 * Deterministic document: fixed key order, only public contract versions, no account,
 * session, wallet, energy or deployment secret. `supported` lists what a client may
 * negotiate; an empty list means the feature cannot be negotiated at all.
 */
export function buildCapabilityDocument(flags: { logoutSync: boolean }): CapabilityDocument {
  return deepFreeze({
    contract: CAPABILITY_CONTRACT,
    version: CAPABILITY_CONTRACT_VERSION,
    features: {
      capabilities: { status: 'active', supported: [CAPABILITY_CONTRACT_VERSION] },
      noteEnvelope: { status: 'active', supported: noteEnvelopeVersions() },
      // Advisory like /notes/logout-capability: admission still rechecks the deployment gate.
      logoutRecovery: { status: flags.logoutSync ? 'active' : 'disabled', supported: [LOGOUT_RECOVERY_CONTRACT_VERSION] },
      // Google token envelopes at rest. Clients never see or choose them; formats are not disclosed.
      credentialEnvelope: { status: 'server_internal', supported: [] },
      identity: { status: 'inactive', supported: [], defined: [IDENTITY_DRAFT_VERSION] },
      providerBinding: { status: 'inactive', supported: [], defined: [PROVIDER_BINDING_DRAFT_VERSION] },
      // Browser gateway to App Server delegation is not implemented.
      delegation: { status: 'unsupported', supported: [] },
    },
  } satisfies CapabilityDocument);
}

export type Declaration = ReadonlyMap<string, readonly number[]>;
export type NegotiationResult =
  | { ok: true; legacy: true }
  | { ok: true; legacy: false; negotiated: Partial<Record<FeatureName, number>> }
  | { ok: false; status: 400; body: { error: 'invalid_capability_declaration' } }
  | { ok: false; status: 406; body: { error: 'unsupported_capability'; feature: FeatureName; supported: number[] } };

const NAME = /^[A-Za-z][A-Za-z0-9]{0,31}$/;
const VERSION = /^(0|[1-9][0-9]{0,3})$/;
const MAX_ENTRIES = 16;
const MAX_VERSIONS = 8;

/**
 * Parses `capabilities=1; noteEnvelope=0,1; logoutRecovery=1`. Returns null for a
 * missing or blank header (legacy client) and 'invalid' for anything malformed.
 */
export function parseCapabilityDeclaration(header: string | null | undefined): Declaration | null | 'invalid' {
  if (header === null || header === undefined || header.trim() === '') return null;
  if (Buffer.byteLength(header) > CAPABILITY_HEADER_MAX_BYTES) return 'invalid';
  const entries = header.split(';').map(part => part.trim());
  if (entries.length > MAX_ENTRIES) return 'invalid';
  const declared = new Map<string, number[]>();
  for (const entry of entries) {
    const eq = entry.indexOf('=');
    if (eq < 1) return 'invalid';
    const name = entry.slice(0, eq).trim(), list = entry.slice(eq + 1).split(',').map(v => v.trim());
    if (!NAME.test(name) || declared.has(name) || list.length > MAX_VERSIONS || !list.every(v => VERSION.test(v))) return 'invalid';
    const versions = list.map(Number);
    if (new Set(versions).size !== versions.length) return 'invalid';
    declared.set(name, versions);
  }
  return declared;
}

/**
 * Picks the highest common version per declared feature, in document order. A feature
 * the client omits keeps legacy behaviour. A known feature with no common version
 * (including any inactive, internal or unsupported feature) is an explicit 406.
 * Unknown feature names are ignored so a newer client can talk to an older server;
 * they never appear in `negotiated`, so the client cannot mistake them for support.
 */
export function negotiate(document: CapabilityDocument, header: string | null | undefined): NegotiationResult {
  const declared = parseCapabilityDeclaration(header);
  if (declared === null) return { ok: true, legacy: true };
  if (declared === 'invalid') return { ok: false, status: 400, body: { error: 'invalid_capability_declaration' } };
  const negotiated: Partial<Record<FeatureName, number>> = {};
  for (const feature of FEATURE_NAMES) {
    const wanted = declared.get(feature);
    if (!wanted) continue;
    const supported = document.features[feature].supported;
    const common = wanted.filter(v => supported.includes(v));
    if (!common.length) return { ok: false, status: 406, body: { error: 'unsupported_capability', feature, supported: [...supported] } };
    negotiated[feature] = Math.max(...common);
  }
  return { ok: true, legacy: false, negotiated };
}

/** Status and JSON body for GET /api/capabilities. A legacy client receives the bare document. */
export function capabilityResponse(document: CapabilityDocument, header: string | null | undefined):
  { status: 200 | 400 | 406; body: unknown } {
  const result = negotiate(document, header);
  if (!result.ok) return { status: result.status, body: result.body };
  return { status: 200, body: result.legacy ? document : { ...document, negotiated: result.negotiated } };
}
