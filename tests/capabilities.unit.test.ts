import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync, readdirSync } from 'node:fs';
import { Hono } from 'hono';
import {
  CAPABILITY_HEADER, FEATURE_NAMES, LOGOUT_RECOVERY_CONTRACT_VERSION, buildCapabilityDocument,
  capabilityResponse, negotiate, parseCapabilityDeclaration,
} from '../src/lib/capabilities.js';
import { remoteNoteRowSchema } from '../src/types/noteWire.js';
import { logoutAttemptSchema } from '../src/lib/logoutContract.js';
import { IDENTITY_CONTRACT_VERSION } from '../src/lib/identityContract.js';
import { BINDING_SCHEMA_VERSION } from '../src/lib/storageBinding.js';

// A closed port: any MongoDB access would fail instead of answering. Route modules read
// the rollout flag when first evaluated, so they are imported only after this setup.
process.env.MONGODB_URI = 'mongodb://127.0.0.1:9';
delete process.env.ATOMIC_LOGOUT_SYNC_ENABLED;
const { createCapabilitiesRoute } = await import('../src/routes/capabilities.js');

const FIXTURES = new URL('./fixtures/capabilities/', import.meta.url);
// Fixtures are LF on disk in Git; tolerate a Windows CRLF checkout.
const fixtureText = (name: string) => readFileSync(new URL(name, FIXTURES), 'utf8').replace(/\r\n/g, '\n');
const pretty = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;
type Exchange = { request: { method: 'GET'; path: string; headers: Record<string, string> };
  response: { status: number; body: unknown } };
const exchanges = readdirSync(FIXTURES).filter(name => name.endsWith('-client.json'));
const app = (logoutSync: boolean) => new Hono().basePath('/api').route('/capabilities', createCapabilitiesRoute({ logoutSync }));

test('the v1 document matches the pinned consumer fixture byte for byte', () => {
  assert.equal(pretty(buildCapabilityDocument({ logoutSync: false })), fixtureText('document.v1.json'));
});

test('every client fixture is reproduced exactly by the route, on the wire and pretty-printed', async () => {
  assert.deepEqual(exchanges.sort(), ['current-client.json', 'delegation-client.json', 'future-client.json',
    'future-only-client.json', 'identity-client.json', 'legacy-client.json', 'malformed-client.json', 'stale-client.json']);
  for (const name of exchanges) {
    const fixture = JSON.parse(fixtureText(name)) as Exchange;
    assert.equal(pretty(fixture), fixtureText(name), `${name} is canonical JSON`);
    const res = await app(false).request(fixture.request.path, { method: fixture.request.method, headers: fixture.request.headers });
    assert.equal(res.status, fixture.response.status, name);
    assert.equal(await res.text(), JSON.stringify(fixture.response.body), name);
    assert.equal(res.headers.get('cache-control'), 'no-store');
    assert.equal(res.headers.get('vary'), CAPABILITY_HEADER);
  }
});

test('a legacy client without a declaration receives the bare document, unchanged', async () => {
  const doc = buildCapabilityDocument({ logoutSync: false });
  for (const header of [undefined, null, '', '   ']) assert.deepEqual(negotiate(doc, header), { ok: true, legacy: true });
  const legacy = JSON.parse(fixtureText('legacy-client.json')) as Exchange;
  assert.equal(pretty(legacy.response.body), fixtureText('document.v1.json'));
  assert.equal('negotiated' in (legacy.response.body as object), false);
});

test('current, stale and future clients negotiate the highest common version', () => {
  const doc = buildCapabilityDocument({ logoutSync: false });
  assert.deepEqual(negotiate(doc, 'capabilities=1; noteEnvelope=0,1; logoutRecovery=1'),
    { ok: true, legacy: false, negotiated: { capabilities: 1, noteEnvelope: 1, logoutRecovery: 1 } });
  // A stale client that only speaks plaintext envelopes keeps working.
  assert.deepEqual(negotiate(doc, 'noteEnvelope=0'), { ok: true, legacy: false, negotiated: { noteEnvelope: 0 } });
  // A future client downgrades; unknown features are ignored and never reported as negotiated.
  assert.deepEqual(negotiate(doc, 'futureFeature=3;noteEnvelope=2,1;capabilities=2,1'),
    { ok: true, legacy: false, negotiated: { capabilities: 1, noteEnvelope: 1 } });
  // Omitting a feature keeps its legacy behaviour rather than failing.
  assert.deepEqual(negotiate(doc, 'capabilities=1'), { ok: true, legacy: false, negotiated: { capabilities: 1 } });
});

test('an unsupported version, or any inactive, internal or unsupported feature, is an explicit 406', () => {
  const doc = buildCapabilityDocument({ logoutSync: true });
  assert.deepEqual(capabilityResponse(doc, 'capabilities=2'),
    { status: 406, body: { error: 'unsupported_capability', feature: 'capabilities', supported: [1] } });
  assert.deepEqual(capabilityResponse(doc, 'noteEnvelope=2'),
    { status: 406, body: { error: 'unsupported_capability', feature: 'noteEnvelope', supported: [0, 1] } });
  assert.deepEqual(capabilityResponse(doc, 'logoutRecovery=2'),
    { status: 406, body: { error: 'unsupported_capability', feature: 'logoutRecovery', supported: [1] } });
  for (const feature of ['credentialEnvelope', 'identity', 'providerBinding', 'delegation'] as const) {
    for (const version of [0, 1, 2]) {
      assert.deepEqual(capabilityResponse(doc, `${feature}=${version}`),
        { status: 406, body: { error: 'unsupported_capability', feature, supported: [] } }, `${feature}=${version}`);
    }
  }
  // The first failure is reported in document order, independent of header order.
  assert.equal((capabilityResponse(doc, 'delegation=1; capabilities=9').body as { feature: string }).feature, 'capabilities');
});

test('malformed declarations are refused instead of silently treated as legacy', () => {
  for (const header of ['capabilities', '=1', 'capabilities=', 'capabilities=one', 'capabilities=-1', 'capabilities=01',
    'capabilities=1.0', 'capabilities=1;capabilities=1', 'noteEnvelope=1,1', 'note-envelope=1', 'a=1;;b=1',
    'x=1,2,3,4,5,6,7,8,9', Array.from({ length: 17 }, (_, i) => `f${i}=1`).join(';'), `capabilities=1;${'x'.repeat(520)}=1`]) {
    assert.equal(parseCapabilityDeclaration(header), 'invalid', header);
    assert.deepEqual(capabilityResponse(buildCapabilityDocument({ logoutSync: false }), header),
      { status: 400, body: { error: 'invalid_capability_declaration' } }, header);
  }
  assert.deepEqual(parseCapabilityDeclaration(' capabilities = 1 ; noteEnvelope = 0 , 1 '),
    new Map([['capabilities', [1]], ['noteEnvelope', [0, 1]]]));
});

test('the document is deeply frozen, deterministic and carries no account or billing data', () => {
  const doc = buildCapabilityDocument({ logoutSync: false });
  const frozen = (value: unknown): boolean => !value || typeof value !== 'object'
    || (Object.isFrozen(value) && Object.values(value).every(frozen));
  assert.equal(frozen(doc), true);
  assert.throws(() => { (doc.features.delegation as { status: string }).status = 'active'; }, TypeError);
  assert.throws(() => { (doc.features.identity.supported as number[]).push(1); }, TypeError);
  assert.equal(JSON.stringify(buildCapabilityDocument({ logoutSync: false })), JSON.stringify(doc));
  assert.deepEqual(Object.keys(doc.features), [...FEATURE_NAMES]);
  assert.doesNotMatch(JSON.stringify(doc), /energy|wallet|coin|balance|credit|price|cost|charge|ledger|user|session|email|token|key/i);
});

test('the rollout flag changes only the advisory logout status', () => {
  const off = buildCapabilityDocument({ logoutSync: false }), on = buildCapabilityDocument({ logoutSync: true });
  assert.equal(off.features.logoutRecovery.status, 'disabled');
  assert.equal(on.features.logoutRecovery.status, 'active');
  assert.deepEqual({ ...on.features, logoutRecovery: off.features.logoutRecovery }, off.features);
});

test('declared versions are pinned to the source contracts they describe', () => {
  const doc = buildCapabilityDocument({ logoutSync: false });
  const accepted = [-1, 0, 1, 2, 3, 255].filter(v => remoteNoteRowSchema.shape.enc_v.safeParse(v).success);
  assert.deepEqual(doc.features.noteEnvelope.supported, accepted);
  assert.equal(logoutAttemptSchema.shape.format.value, LOGOUT_RECOVERY_CONTRACT_VERSION);
  assert.deepEqual(doc.features.identity.defined, [IDENTITY_CONTRACT_VERSION]);
  assert.deepEqual(doc.features.providerBinding.defined, [BINDING_SCHEMA_VERSION]);
});

test('capability modules import no billing, wallet, ledger, database or disabled-contract module', () => {
  for (const file of ['../src/lib/capabilities.ts', '../src/routes/capabilities.ts']) {
    const source = readFileSync(new URL(file, import.meta.url), 'utf8');
    const imports = [...source.matchAll(/from '([^']+)'/g)].map(m => m[1]);
    assert.ok(imports.length > 0);
    for (const spec of imports) {
      assert.ok(['hono', '../lib/capabilities.js', '../types/noteWire.js'].includes(spec), `${file} imports ${spec}`);
    }
  }
});

test('the real entrypoint serves the document without a session or database', { timeout: 20000 }, async () => {
  const { default: realApp } = await import('../src/app.js');
  const res = await realApp.request('/api/capabilities');
  assert.equal(res.status, 200);
  assert.equal(pretty(await res.json()), fixtureText('document.v1.json'));
  const future = await realApp.request('/api/capabilities', { headers: { [CAPABILITY_HEADER]: 'capabilities=2' } });
  assert.equal(future.status, 406);
});

test('capability declarations authorize nothing on existing routes', { timeout: 20000 }, async () => {
  const { default: realApp } = await import('../src/app.js');
  const everything = { [CAPABILITY_HEADER]: 'capabilities=1;noteEnvelope=0,1;logoutRecovery=1;identity=1;providerBinding=1;delegation=1' };
  // The logout rollout gate is checked before any database access and ignores declarations.
  for (const headers of [{}, everything]) {
    const res = await realApp.request('/api/notes/logout-attempt/complete', { method: 'POST',
      headers: { ...headers, authorization: 'Bearer synthetic-unknown-session', 'content-type': 'application/json' },
      body: JSON.stringify({ attemptId: '00000000-0000-4000-8000-000000000000' }) });
    assert.equal(res.status, 404);
    assert.deepEqual(await res.json(), { error: 'logout_sync_unavailable' });
  }
  // Without a session, writes and wallet reads are refused exactly as before.
  for (const [method, path] of [['POST', '/api/notes/push'], ['GET', '/api/energy'], ['GET', '/api/notes/logout-capability']]) {
    const plain = await realApp.request(path, { method });
    const declared = await realApp.request(path, { method, headers: everything });
    assert.equal(declared.status, plain.status, path);
    assert.equal(plain.status, 401, path);
    assert.equal(await declared.text(), await plain.text(), path);
  }
});
