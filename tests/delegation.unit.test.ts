import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash, createSecretKey, generateKeyPairSync, randomBytes, sign, type KeyObject } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { Hono } from 'hono';
import {
  CLAIM_ORDER, CLOCK_SKEW_SECONDS, DELEGATION_ALGORITHM, DELEGATION_CONTRACT, DELEGATION_CONTRACT_VERSION, DELEGATION_ERRORS,
  DELEGATION_HEADER, DELEGATION_SCOPES, MAX_ASSERTION_BYTES, MAX_LIFETIME_SECONDS, MemoryReplayStore, canonicalClaimsJson,
  signingInput, verifyDelegationAssertion, type DelegationClaims, type DelegationVerifierOptions,
} from '../src/lib/delegation.js';
import { CAPABILITY_HEADER, buildCapabilityDocument, capabilityResponse } from '../src/lib/capabilities.js';
import { createDelegationRoute } from '../src/routes/delegation.js';

// A closed port: any MongoDB access would fail. The gate is unset, as in every deployment.
process.env.MONGODB_URI = 'mongodb://127.0.0.1:9';
delete process.env.ATOMIC_DELEGATION_VERIFY_ENABLED;

const fixture = JSON.parse(readFileSync(new URL('./fixtures/delegation/assertion.v1.json', import.meta.url), 'utf8')
  .replace(/\r\n/g, '\n')) as {
  example: { gatewayFamilyId: string; claims: DelegationClaims; payload: string; signingInput: string };
  verifyResponse: { status: number; body: Record<string, unknown> };
  errors: { status: number; codes: string[] }; unavailable: { status: number; body: unknown };
  [key: string]: unknown;
};
const CANARY = 'CANARY-provider-access-7f3a9c';
const AUD = fixture.example.claims.aud, ISS = fixture.example.claims.iss, KID = fixture.example.claims.kid;
const OTHER_ISS = 'atomic-webapp-gateway-other';
const NOW_MS = fixture.example.claims.iat * 1000;
const NOW = fixture.example.claims.iat;
const ALICE = fixture.example.claims.sub, BOB = '9b8a7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d';

// Test-only keys, generated per run. No key material is committed.
const gateway = generateKeyPairSync('ed25519'), stranger = generateKeyPairSync('ed25519'), other = generateKeyPairSync('ed25519');
const sidOf = (familyId: string) => createHash('sha256').update(`atomic-delegation/sid/v1\0${familyId}`, 'utf8').digest('base64url');
const ALICE_SID = fixture.example.claims.sid, BOB_SID = sidOf('ffeeddccbbaa99887766554433221100');

function harness(overrides: { keyFor?: (iss: string, kid: string) => KeyObject | undefined; now?: number } = {}) {
  const now = overrides.now ?? NOW_MS;
  const records = new Map([[`${ISS}\0${ALICE_SID}`, ALICE], [`${ISS}\0${BOB_SID}`, BOB]]);
  const options: DelegationVerifierOptions = {
    audience: AUD,
    keys: { verificationKey: overrides.keyFor ?? ((iss, kid) => iss === ISS && kid === KID ? gateway.publicKey
      : iss === OTHER_ISS && kid === KID ? other.publicKey : undefined) },
    replay: new MemoryReplayStore(() => now),
    subjects: { boundAccount: async (iss, sid) => records.get(`${iss}\0${sid}`) ?? null },
    now: () => now,
  };
  return { options, records };
}

let counter = 0;
const claims = (patch: Partial<Record<keyof DelegationClaims, unknown>> = {}) => ({
  ...fixture.example.claims, jti: `test-jti-${String(++counter).padStart(16, '0')}`, ...patch }) as DelegationClaims;
const b64 = (text: string) => Buffer.from(text, 'utf8').toString('base64url');
const signRaw = (input: string, key: KeyObject = gateway.privateKey) => `${input}.${sign(null, Buffer.from(input, 'ascii'), key).toString('base64url')}`;
const mint = (c: DelegationClaims, key?: KeyObject) => signRaw(signingInput(c), key);
/** Signs an arbitrary JSON payload text, for structurally invalid claim sets. */
const mintText = (json: string, header: string = DELEGATION_HEADER, key?: KeyObject) => signRaw(`${header}.${b64(json)}`, key);
const withoutKey = (key: string) => JSON.stringify(Object.fromEntries(Object.entries(claims()).filter(([k]) => k !== key)));

async function verdict(assertion: unknown, options = harness().options) {
  const result = await verifyDelegationAssertion(assertion, options);
  return result.ok ? 'ok' : result.error;
}

test('the shared consumer fixture pins the v1 wire format and the gateway sid derivation', () => {
  const pretty = `${JSON.stringify(fixture, null, 2)}\n`;
  assert.equal(pretty, readFileSync(new URL('./fixtures/delegation/assertion.v1.json', import.meta.url), 'utf8').replace(/\r\n/g, '\n'));
  assert.equal(fixture.contract, DELEGATION_CONTRACT);
  assert.equal(fixture.version, DELEGATION_CONTRACT_VERSION);
  assert.equal(fixture.header, DELEGATION_HEADER);
  assert.equal(fixture.algorithm, DELEGATION_ALGORITHM);
  assert.deepEqual(fixture.claimOrder, [...CLAIM_ORDER]);
  assert.deepEqual(fixture.scopes, [...DELEGATION_SCOPES]);
  assert.equal(fixture.maxAssertionBytes, MAX_ASSERTION_BYTES);
  assert.equal(fixture.maxLifetimeSeconds, MAX_LIFETIME_SECONDS);
  assert.equal(fixture.clockSkewSeconds, CLOCK_SKEW_SECONDS);
  assert.deepEqual(fixture.errors, { status: 401, codes: [...DELEGATION_ERRORS] });
  assert.deepEqual(Object.keys(fixture.example.claims), [...CLAIM_ORDER]);
  assert.equal(fixture.example.claims.sid, sidOf(fixture.example.gatewayFamilyId));
  assert.equal(signingInput(fixture.example.claims), fixture.example.signingInput);
  assert.equal(Buffer.from(fixture.example.payload, 'base64url').toString('utf8'), canonicalClaimsJson(fixture.example.claims));
});

test('an authentic, in-audience, in-scope, fresh assertion bound to the App Server record is accepted', async () => {
  const assertion = signRaw(fixture.example.signingInput);
  const result = await verifyDelegationAssertion(assertion, harness().options);
  assert.deepEqual(result, { ok: true, claims: fixture.example.claims });
  // Clock skew is bounded on both sides.
  assert.equal(await verdict(mint(claims({ iat: NOW + CLOCK_SKEW_SECONDS, exp: NOW + CLOCK_SKEW_SECONDS + 60 }))), 'ok');
  assert.equal(await verdict(mint(claims({ iat: NOW - 300, exp: NOW - CLOCK_SKEW_SECONDS + 1 }))), 'ok');
});

test('forged, mis-keyed, tampered and wrong-issuer assertions are denied', async () => {
  const valid = mint(claims());
  const [header, payload] = valid.split('.');
  const foreignSignature = mint(claims()).split('.')[2];
  assert.equal(await verdict(`${header}.${payload}.${foreignSignature}`), 'delegation_bad_signature');
  assert.equal(await verdict(mint(claims(), stranger.privateKey)), 'delegation_bad_signature');
  const tampered = b64(canonicalClaimsJson(claims({ sub: BOB })));
  assert.equal(await verdict(`${header}.${tampered}.${valid.split('.')[2]}`), 'delegation_bad_signature');
  // A known second gateway cannot be impersonated with the first gateway's key, or vice versa.
  assert.equal(await verdict(mint(claims({ iss: OTHER_ISS }))), 'delegation_bad_signature');
  assert.equal(await verdict(mint(claims({ iss: 'unregistered-gateway' }))), 'delegation_unknown_issuer');
  assert.equal(await verdict(mint(claims({ kid: 'retired-key' }))), 'delegation_unknown_issuer');
  // Algorithm confusion: a non-Ed25519 key from the key port never verifies anything.
  const hmac = harness({ keyFor: () => createSecretKey(randomBytes(32)) }).options;
  assert.equal(await verdict(mint(claims()), hmac), 'delegation_bad_signature');
});

test('expired, not-yet-valid, over-long and wrong-audience assertions are denied', async () => {
  assert.equal(await verdict(mint(claims({ iat: NOW - 300, exp: NOW - CLOCK_SKEW_SECONDS }))), 'delegation_expired');
  assert.equal(await verdict(mint(claims({ iat: NOW - 3600, exp: NOW - 3400 }))), 'delegation_expired');
  assert.equal(await verdict(mint(claims({ iat: NOW + CLOCK_SKEW_SECONDS + 1, exp: NOW + 120 }))), 'delegation_not_yet_valid');
  assert.equal(await verdict(mint(claims({ exp: NOW + MAX_LIFETIME_SECONDS + 1 }))), 'delegation_lifetime_exceeded');
  assert.equal(await verdict(mint(claims({ exp: NOW }))), 'delegation_lifetime_exceeded');
  for (const aud of ['urn:atomic-notes:app-server:prod', AUD.toUpperCase(), `${AUD}:`, AUD.slice(0, -1), 'x']) {
    assert.equal(await verdict(mint(claims({ aud }))), 'delegation_wrong_audience', aud);
  }
});

test('unknown versions, extra fields, missing claims and non-canonical encodings are refused', async () => {
  assert.equal(await verdict(mintText(canonicalClaimsJson(claims()), 'atomic-delegation-v2')), 'delegation_unsupported_version');
  assert.equal(await verdict(mintText(JSON.stringify({ ...claims(), v: 2 }))), 'delegation_unsupported_version');
  assert.equal(await verdict(mintText(JSON.stringify({ ...claims(), v: '1' }))), 'delegation_malformed');
  for (const extra of [{ accountId: BOB }, { access_token: CANARY }, { providerToken: CANARY }, { wallet: 'write' }, { alg: 'none' }]) {
    assert.equal(await verdict(mintText(JSON.stringify({ ...claims(), ...extra }))), 'delegation_malformed', JSON.stringify(extra));
  }
  for (const key of CLAIM_ORDER) assert.equal(await verdict(mintText(withoutKey(key))), 'delegation_malformed', key);
  const c = claims(), canonical = canonicalClaimsJson(c);
  assert.equal(await verdict(mintText(JSON.stringify(c, null, 1))), 'delegation_malformed');
  assert.equal(await verdict(mintText(JSON.stringify(Object.fromEntries(Object.entries(c).reverse())))), 'delegation_malformed');
  assert.equal(await verdict(mintText(canonical.replace('{', `{"sub":"${BOB}",`))), 'delegation_malformed');
  const valid = mint(claims());
  for (const bad of [valid.replace(/^[^.]+/, 'atomic-delegation-v1 '), `${valid}.x`, valid.split('.').slice(0, 2).join('.'),
    `${valid}=`, valid.replace(/^atomic-delegation-v1/, 'jwt'), `${valid}${'A'.repeat(MAX_ASSERTION_BYTES)}`, '', 42, null, { assertion: valid }]) {
    assert.equal(await verdict(bad), 'delegation_malformed', String(bad).slice(0, 40));
  }
  for (const patch of [{ sub: 'acct-alice' }, { sub: ALICE.toUpperCase() }, { sid: 'short' }, { jti: 'short' }, { iss: 'Upper' },
    { iat: 1.5 }, { exp: -1 }, { scope: [] }, { scope: 'notes:read' }, { scope: ['notes:read', 'notes:read'] }]) {
    assert.equal(await verdict(mint(claims(patch))), 'delegation_malformed', JSON.stringify(patch));
  }
});

test('only the notes:read scope exists: wallet, Energy, billing and write scopes are denied', async () => {
  for (const scope of [['wallet:write'], ['energy:spend'], ['billing:charge'], ['notes:write'], ['notes:read', 'wallet:write'], ['*']]) {
    assert.equal(await verdict(mint(claims({ scope }))), 'delegation_scope_denied', scope.join());
  }
});

test('a jti is single use, and a refused assertion never burns one', async () => {
  const { options } = harness();
  const jti = 'replay-jti-0000000000000001';
  assert.equal(await verdict(mint(claims({ jti }), stranger.privateKey), options), 'delegation_bad_signature');
  assert.equal(await verdict(mint(claims({ jti, aud: 'urn:wrong' })), options), 'delegation_wrong_audience');
  const valid = mint(claims({ jti }));
  assert.equal(await verdict(valid, options), 'ok');
  assert.equal(await verdict(valid, options), 'delegation_replayed');
  assert.equal(await verdict(mint(claims({ jti })), options), 'delegation_replayed');
  // Issuers have separate jti spaces.
  assert.equal(await verdict(mint(claims({ jti, iss: OTHER_ISS }), other.privateKey), options), 'delegation_subject_mismatch');
});

test('sub must match the App Server own record for the gateway session, never the assertion alone', async () => {
  const { options, records } = harness();
  assert.equal(await verdict(mint(claims({ sub: BOB })), options), 'delegation_subject_mismatch');
  assert.equal(await verdict(mint(claims({ sid: sidOf('unknown-family') })), options), 'delegation_subject_mismatch');
  assert.equal(await verdict(mint(claims({ sid: BOB_SID, sub: BOB })), options), 'ok');
  records.delete(`${ISS}\0${ALICE_SID}`);
  assert.equal(await verdict(mint(claims()), options), 'delegation_subject_mismatch');
});

const mounted = (route: Hono) => new Hono().basePath('/api').route('/delegation', route);
const post = (app: Hono, body: unknown, headers: Record<string, string> = {}) => app.request('/api/delegation/verify', {
  method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body) });

test('the route verifies only the assertion and ignores caller-supplied account ids and tokens', async () => {
  const app = mounted(createDelegationRoute({ enabled: true, verifier: harness().options }));
  const res = await post(app, { assertion: signRaw(fixture.example.signingInput), accountId: BOB, userId: BOB, providerToken: CANARY },
    { 'x-account-id': BOB, authorization: `Bearer ${CANARY}` });
  assert.equal(res.status, fixture.verifyResponse.status);
  assert.equal(res.headers.get('cache-control'), 'no-store');
  const text = await res.text();
  assert.deepEqual(JSON.parse(text), fixture.verifyResponse.body);
  assert.doesNotMatch(text, /CANARY|atomic-delegation-v1\.|token|bearer/i);
  const bob = await post(app, { assertion: mint(claims({ sid: BOB_SID, sub: BOB })), accountId: ALICE });
  assert.equal((await bob.json() as { sub: string }).sub, BOB);
  for (const code of DELEGATION_ERRORS.filter(c => c === 'delegation_malformed' || c === 'delegation_scope_denied')) {
    const patch = code === 'delegation_scope_denied' ? { scope: ['wallet:write'] } : { sub: 'x' };
    const denied = await post(app, { assertion: mint(claims(patch)), accountId: ALICE });
    assert.equal(denied.status, fixture.errors.status);
    assert.deepEqual(await denied.json(), { error: code });
  }
  for (const [body, type] of [['not json', 'application/json'], ['[]', 'application/json'], [JSON.stringify({ assertion: 'x' }), 'text/plain'],
    [JSON.stringify({ assertion: 'x'.repeat(5000) }), 'application/json']] as const) {
    const res = await post(app, body, { 'content-type': type });
    assert.equal(res.status, 400, body.slice(0, 20));
    assert.deepEqual(await res.json(), { error: 'delegation_request_invalid' });
  }
  assert.deepEqual(await (await post(app, { accountId: ALICE })).json(), { error: 'delegation_malformed' });
});

test('gate on without verifier wiring answers 503; gate off is exactly an unknown route', async () => {
  const unwired = await post(mounted(createDelegationRoute({ enabled: true })), { assertion: signRaw(fixture.example.signingInput) });
  assert.equal(unwired.status, fixture.unavailable.status);
  assert.deepEqual(await unwired.json(), fixture.unavailable.body);
  const { default: realApp } = await import('../src/app.js');
  const unknown = await realApp.request('/api/definitely-unknown', { method: 'POST' });
  for (const app of [realApp, mounted(createDelegationRoute({ enabled: false, verifier: harness().options })),
    mounted(createDelegationRoute())]) {
    for (const method of ['POST', 'GET']) {
      const res = await app.request('/api/delegation/verify', { method, headers: { 'content-type': 'application/json' },
        ...(method === 'POST' ? { body: JSON.stringify({ assertion: signRaw(fixture.example.signingInput) }) } : {}) });
      assert.equal(res.status, 404);
      assert.equal(res.status, unknown.status);
      assert.equal(await res.text(), await unknown.clone().text());
    }
  }
});

test('capabilities: gate off keeps the pinned unsupported entry; gate on is disabled and still not negotiable', () => {
  const off = buildCapabilityDocument({ logoutSync: false }), on = buildCapabilityDocument({ logoutSync: false, delegation: true });
  assert.deepEqual(off.features.delegation, { status: 'unsupported', supported: [] });
  assert.deepEqual(on.features.delegation, { status: 'disabled', supported: [], defined: [DELEGATION_CONTRACT_VERSION] });
  assert.deepEqual({ ...on.features, delegation: off.features.delegation }, off.features);
  assert.deepEqual(capabilityResponse(on, 'delegation=1'),
    { status: 406, body: { error: 'unsupported_capability', feature: 'delegation', supported: [] } });
  assert.equal(CAPABILITY_HEADER, 'atomic-capabilities');
});

test('delegation modules import no billing, Energy, ledger, wallet, database or session module, and nothing routes to them', () => {
  const allowed: Record<string, string[]> = {
    '../src/lib/delegation.ts': ['node:crypto'],
    '../src/routes/delegation.ts': ['hono', '../lib/capabilities.js', '../lib/delegation.js'],
  };
  for (const [file, specs] of Object.entries(allowed)) {
    const imports = [...readFileSync(new URL(file, import.meta.url), 'utf8').matchAll(/from '([^']+)'/g)].map(m => m[1]);
    assert.ok(imports.length > 0);
    for (const spec of imports) assert.ok(specs.includes(spec as string), `${file} imports ${spec}`);
  }
  // Only the app entrypoint mounts the route; no notes, wallet, Energy or billing code uses the verifier.
  const importers: string[] = [];
  for (const dir of ['lib', 'routes', 'middleware', 'db', 'scripts', 'types']) {
    for (const name of readdirSync(new URL(`../src/${dir}/`, import.meta.url))) {
      if (!name.endsWith('.ts')) continue;
      const source = readFileSync(new URL(`../src/${dir}/${name}`, import.meta.url), 'utf8');
      if (/from '[^']*delegation\.js'/.test(source)) importers.push(`${dir}/${name}`);
    }
  }
  assert.deepEqual(importers.sort(), ['routes/delegation.ts']);
  assert.match(readFileSync(new URL('../src/app.ts', import.meta.url), 'utf8'), /import delegationRoute from '\.\/routes\/delegation\.js'/);
});
