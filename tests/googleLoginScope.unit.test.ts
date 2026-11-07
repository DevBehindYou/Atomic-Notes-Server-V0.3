import assert from 'node:assert/strict';
import test from 'node:test';
import type { Db } from 'mongodb';
import type { Credentials } from 'google-auth-library';

// Import the real login boundary without opening a database or loading local credentials.
process.env.MONGODB_URI = 'mongodb://127.0.0.1:27017';
const { completeGoogleLogin } = await import('../src/routes/auth.js');

const driveFile = 'https://www.googleapis.com/auth/drive.file';
const drive = 'https://www.googleapis.com/auth/drive';
const permissionError = {
  error: 'drive_permission_required',
  hint: 'Allow access to the specific Google Drive files used with this app, then sign in again.',
};

function fixture() {
  const calls = { identity: 0, profile: 0, database: 0, drive: 0 };
  const db = new Proxy({} as Db, { get() {
    calls.database++;
    throw new Error('No database access is allowed in this offline test');
  } });
  const verifier = { async verifyIdToken() {
    calls.identity++;
    return { getPayload: () => ({}) };
  } } as unknown as Parameters<typeof completeGoogleLogin>[1];
  const setup = async () => { calls.drive++; return { notesId: 'unused-notes' }; };
  const profile = async () => { calls.profile++; return {}; };
  return { calls, login: (tokens: Credentials) => completeGoogleLogin(db, verifier, tokens, 'test-agent', setup, profile) };
}

test('explicitly insufficient Drive grants return actionable error before either identity path or account access', async () => {
  const insufficientScopes = [
    '', ' \t\n ', 'openid email profile', `${drive}.readonly`, `${drive}.metadata`,
    `${drive}.metadata.readonly`, `${drive}.appdata`, `${driveFile}.readonly`,
    `${driveFile}.extra`, `prefix:${driveFile}`, driveFile.toUpperCase(),
  ];
  for (const scope of insufficientScopes) {
    for (const id_token of [undefined, 'synthetic-id-token']) {
      const { login, calls } = fixture();
      assert.deepEqual(await login({ access_token: 'synthetic-access', refresh_token: 'synthetic-refresh', scope, id_token }),
        permissionError, JSON.stringify({ scope, withIdToken: !!id_token }));
      assert.deepEqual(calls, { identity: 0, profile: 0, database: 0, drive: 0 });
    }
  }
});

test('missing access token keeps its existing error priority over insufficient scope', async () => {
  const { login, calls } = fixture();
  assert.deepEqual(await login({ scope: 'openid email profile', id_token: 'synthetic-id-token' }),
    { error: 'incomplete_token_response' });
  assert.deepEqual(calls, { identity: 0, profile: 0, database: 0, drive: 0 });
});

test('granted write scopes and unknown legacy scope continue through existing identity validation', async () => {
  for (const scope of [undefined, driveFile, drive, `openid\t${driveFile}\n email`, ` ${drive}.readonly  ${drive} `]) {
    for (const id_token of [undefined, 'synthetic-id-token']) {
      const { login, calls } = fixture();
      assert.deepEqual(await login({ access_token: 'synthetic-access', scope, id_token }), { error: 'invalid_id_token' });
      assert.deepEqual(calls, { identity: id_token ? 1 : 0, profile: id_token ? 0 : 1, database: 0, drive: 0 });
    }
  }
});

// ---------------------------------------------------------------------------
// ID-token rejection. Google's verifier puts the raw ID token or its decoded
// claims (subject, email, name) in its error message. A rejected token must be
// a bounded `invalid_id_token` refusal, never an exception that the global
// error handler would log (its stack carries the message) and answer with 500.
// These cases run the real google-auth-library verifier with a locally primed
// certificate cache, so no network or Google credential is involved.
// ---------------------------------------------------------------------------
const { generateKeyPairSync, createSign } = await import('node:crypto');
const { Hono } = await import('hono');
const { getOAuthClient } = await import('../src/lib/googleOAuth.js');
const { registerErrorHandler } = await import('../src/middleware/errorHandler.js');

const clientId = 'synthetic-client.apps.googleusercontent.com';
process.env.GOOGLE_CLIENT_ID = clientId;
const kid = 'synthetic-kid';
const signingKey = generateKeyPairSync('rsa', { modulusLength: 2048 });
const strangerKey = generateKeyPairSync('rsa', { modulusLength: 2048 });
const subject = 'synthetic-subject-918273645';
const email = 'synthetic.person@example.invalid';
const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url');
function signedIdToken(claims: object, key = signingKey.privateKey) {
  const signed = `${encode({ alg: 'RS256', kid, typ: 'JWT' })}.${encode(claims)}`;
  return `${signed}.${createSign('RSA-SHA256').update(signed).sign(key).toString('base64url')}`;
}
function primedVerifier() {
  const client = getOAuthClient();
  // The library's own cache fields: a fresh, unexpired PEM cache means no certificate fetch.
  Object.assign(client, { certificateCache: { [kid]: signingKey.publicKey.export({ type: 'spki', format: 'pem' }) },
    certificateExpiry: new Date(Date.now() + 3600000), certificateCacheFormat: 'PEM' });
  return client;
}
const now = Math.floor(Date.now() / 1000);
const claims = { iss: 'https://accounts.google.com', aud: clientId, sub: subject, email, email_verified: true,
  name: 'Synthetic Person', iat: now - 60, exp: now + 3600 };

function verifiedLogin(verifier: Parameters<typeof completeGoogleLogin>[1]) {
  const calls = { database: 0, drive: 0, profile: 0 };
  const db = new Proxy({} as Db, { get() {
    calls.database++;
    throw new Error('No database access is allowed in this offline test');
  } });
  const login = (id_token: string) => completeGoogleLogin(db, verifier, {
    access_token: 'synthetic-access', refresh_token: 'synthetic-refresh', scope: `openid email ${driveFile}`, id_token,
  }, 'test-agent', async () => { calls.drive++; return { notesId: 'unused-notes' }; },
  async () => { calls.profile++; return {}; });
  // Same result handling as POST /auth/google/mobile and GET /auth/callback, behind the real error handler.
  const app = new Hono();
  registerErrorHandler(app);
  app.post('/login', async (c) => {
    const result = await login(c.req.header('x-id-token')!);
    if ('error' in result) return c.json(result, 400);
    return c.json(result);
  });
  return { calls, login, app };
}

async function capturedErrors<T>(run: () => T | Promise<T>) {
  const logged: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => { logged.push(args.map(String).join(' ')); };
  try { return { value: await run(), logged: logged.join('\n') }; } finally { console.error = original; }
}

test('the primed real verifier accepts a correctly signed token and continues to the account step', async () => {
  const { login, calls } = verifiedLogin(primedVerifier());
  await assert.rejects(login(signedIdToken(claims)), /No database access/);
  assert.equal(calls.profile, 0); assert.equal(calls.drive, 0); assert.ok(calls.database > 0);
});

test('a rejected ID token is a bounded invalid_id_token refusal that logs neither the token nor its claims', async () => {
  const rejected: Record<string, string> = {
    expired: signedIdToken({ ...claims, iat: now - 7200, exp: now - 3600 }),
    not_yet_valid: signedIdToken({ ...claims, iat: now + 3600, exp: now + 7200 }),
    foreign_signature: signedIdToken(claims, strangerKey.privateKey),
    wrong_audience: signedIdToken({ ...claims, aud: 'another-client.apps.googleusercontent.com' }),
    wrong_issuer: signedIdToken({ ...claims, iss: 'https://issuer.example.invalid' }),
    unknown_key: (() => { const [, body, sig] = signedIdToken(claims).split('.');
      return `${encode({ alg: 'RS256', kid: 'rotated-away', typ: 'JWT' })}.${body}.${sig}`; })(),
    malformed: `${encode({ alg: 'RS256', kid })}.${encode(claims)}`,
  };
  for (const [name, idToken] of Object.entries(rejected)) {
    const { login, app, calls } = verifiedLogin(primedVerifier());
    assert.deepEqual(await login(idToken), { error: 'invalid_id_token' }, name);
    const { value: response, logged } = await capturedErrors(() => app.request('/login', {
      method: 'POST', headers: { 'x-id-token': idToken } }));
    assert.equal(response.status, 400, name);
    assert.deepEqual(await response.json(), { error: 'invalid_id_token' }, name);
    for (const secret of [idToken, idToken.split('.')[1], subject, email, 'Synthetic Person']) {
      assert.equal(logged.includes(secret), false, `${name} logged identity material`);
    }
    assert.deepEqual(calls, { database: 0, drive: 0, profile: 0 }, name);
  }
});

test('an unreachable certificate endpoint stays a server failure, not an invalid credential, and leaks nothing', async () => {
  const idToken = signedIdToken(claims);
  // Shape of the library's transport failure: a Gaxios error carrying its request configuration.
  const unreachable = { async verifyIdToken() {
    throw Object.assign(new Error('Failed to retrieve verification certificates: synthetic network failure'), {
      config: { url: 'https://www.googleapis.com/oauth2/v1/certs', headers: { authorization: `Bearer ${idToken}` } } });
  } } as unknown as Parameters<typeof completeGoogleLogin>[1];
  const { app, calls } = verifiedLogin(unreachable);
  const { value: response, logged } = await capturedErrors(() => app.request('/login', {
    method: 'POST', headers: { 'x-id-token': idToken } }));
  assert.equal(response.status, 500);
  assert.deepEqual(await response.json(), { error: 'internal_error' });
  assert.equal(logged.includes(idToken), false);
  assert.deepEqual(calls, { database: 0, drive: 0, profile: 0 });
});
