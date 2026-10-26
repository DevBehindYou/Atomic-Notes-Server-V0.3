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
