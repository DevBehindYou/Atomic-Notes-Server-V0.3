import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { getStagingEnvIssues } from '../src/lib/stagingEnv.js';

// Public synthetic material, never loaded from a local/provider env file.
const synthetic = {
  NODE_ENV: 'production', VERCEL_ENV: 'preview',
  MONGODB_URI: 'mongodb://127.0.0.1:1/never_connect',
  MONGODB_DB_NAME: 'atomic_notes_app_staging_fixture',
  GOOGLE_CLIENT_ID: 'synthetic-client.apps.googleusercontent.com',
  GOOGLE_CLIENT_SECRET: 'synthetic-not-a-google-secret',
  GOOGLE_REDIRECT_URI: 'https://atomic-notes-app-server-staging.vercel.app/api/auth/callback',
  TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 3).toString('base64'),
  ADMIN_API_KEY: 'synthetic-deployment-smoke-admin-key-only',
};

test('staging preflight requires explicit staging database and callback, without returning values', () => {
  assert.deepEqual(getStagingEnvIssues(synthetic), []);
  assert.deepEqual(getStagingEnvIssues({ ...synthetic, ALLOWED_ORIGIN: 'https://staging.example.com' }), []);
  for (const [name, value] of [
    ['MONGODB_DB_NAME', 'atomic_notes'], ['MONGODB_DB_NAME', ''],
    ['GOOGLE_REDIRECT_URI', 'https://existing-production.example/api/auth/callback'],
    ['GOOGLE_REDIRECT_URI', `${synthetic.GOOGLE_REDIRECT_URI}?extra=1`],
    ['GOOGLE_REDIRECT_URI', 'https://atomic-notes-app-server-staging.vercel.app.evil.example/api/auth/callback'],
    ['ALLOWED_ORIGIN', '*'], ['ALLOWED_ORIGIN', 'https://*.example.com'],
    ['ALLOWED_ORIGIN', 'http://staging.example.com'],
    ['ALLOWED_ORIGIN', 'https://staging.example.com/path'], ['ALLOWED_ORIGIN', 'https://staging.example.com,'],
    ['ATOMIC_LOGOUT_SYNC_ENABLED', 'yes'], ['TOKEN_ENCRYPTION_KEY', 'invalid'],
    ['ADMIN_API_KEY', 'short'], ['GOOGLE_CLIENT_SECRET', ''],
  ]) {
    const issues = getStagingEnvIssues({ ...synthetic, [name]: value });
    assert.ok(issues.some(issue => issue.name === name), name);
    assert.ok(issues.every(issue => Object.keys(issue).join(',') === 'name,problem'));
  }
  const privateSentinel = 'synthetic-private-value-must-never-be-logged';
  assert.ok(!JSON.stringify(getStagingEnvIssues({ ...synthetic, TOKEN_ENCRYPTION_KEY: privateSentinel })).includes(privateSentinel));
});

test('deployment source retains explicit single-function Node 22 configuration and compiled artifact', () => {
  const config = JSON.parse(readFileSync('vercel.json', 'utf8'));
  const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
  assert.equal(pkg.engines.node, '22.x');
  assert.equal(config.framework, null);
  assert.equal(config.buildCommand, 'npm run build');
  assert.equal(config.installCommand, 'npm ci');
  assert.equal(config.outputDirectory, 'public');
  assert.deepEqual(Object.keys(config.functions), ['api/index.ts']);
  assert.deepEqual(config.rewrites, [{ source: '/api/(.*)', destination: '/api' }]);
  assert.deepEqual(readdirSync('api'), ['index.ts']);
  assert.ok(existsSync('dist/api/index.js'), 'run npm run check:deployment to build first');
  assert.match(readFileSync('public/robots.txt', 'utf8'), /Disallow: \//);
});

for (const entry of ['api/index.ts', 'dist/api/index.js']) {
  for (const mode of ['valid', 'invalid']) {
    // This is a functional import gate, not a cold-start performance budget.
    // Dependency loading on a busy Windows host can exceed 25 seconds.
    test(`${entry} ${mode} production cold start and health smoke with network blocked`, { timeout: 90_000 }, () => {
      const env: NodeJS.ProcessEnv = {};
      // Preserve only OS execution essentials. Do not inherit credentials, DB
      // settings, NODE_OPTIONS, or any user's application environment.
      for (const name of ['PATH', 'Path', 'SystemRoot', 'SYSTEMROOT', 'WINDIR', 'TEMP', 'TMP']) {
        if (process.env[name]) env[name] = process.env[name];
      }
      Object.assign(env, mode === 'valid' ? synthetic : { NODE_ENV: 'production', VERCEL_ENV: 'preview' });
      const args = entry.endsWith('.ts') ? ['--import', 'tsx'] : [];
      const result = spawnSync(process.execPath, [...args, 'tests/stagingEntrySmoke.mjs', entry, mode], {
        env, encoding: 'utf8', timeout: 60_000, maxBuffer: 64 * 1024,
      });
      assert.ifError(result.error);
      assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
      assert.match(result.stdout, /entrypoint smoke passed with network blocked/);
    });
  }
}
