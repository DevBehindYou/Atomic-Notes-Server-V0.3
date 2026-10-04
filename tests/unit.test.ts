import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { Hono } from 'hono';
import { z } from 'zod';
import { mapConcurrent } from '../src/lib/concurrency';
import { escapeRegex } from '../src/lib/validation';
import { registerErrorHandler } from '../src/middleware/errorHandler';
import { requireAdmin } from '../src/middleware/adminAuth';
import { encryptToken, decryptToken } from '../src/lib/crypto';
import { remoteNoteRowSchema } from '../src/types/noteWire';
import { createNoteFileWith } from '../src/lib/googleDrive';
import { assertProductionEnvironment, getEnvIssues } from '../src/lib/env';
import { isDriveNotFound, isDriveRetryable, withDriveRetry } from '../src/lib/googleDrive';
import { isInvalidGrant } from '../src/lib/googleOAuth';
import { httpError } from '../src/lib/httpError';
import { SUPPORT_URL, WELCOME_NOTIFICATIONS } from '../src/lib/welcomeNotifications';
import { retentionArguments } from '../src/db/syncRetention';

test('retention tooling defaults to inspection and requires an explicit database for apply', () => {
  assert.deepEqual(retentionArguments([]), { apply: false });
  assert.deepEqual(retentionArguments(['--apply', '--database', 'disposable_test']), { apply: true, database: 'disposable_test' });
  for (const args of [['--apply'], ['--apply', '--database', ''], ['--apply', '--database', '--other'],
    ['--database', 'test'], ['--apply', '--database', 'test', '--force'], ['--force']]) {
    assert.throws(() => retentionArguments(args), /usage:/);
  }
});

test('current Flutter push payload omits updated_at and cannot choose its owner', () => {
  const row = remoteNoteRowSchema.parse({
    id: 'cfded5cb-1027-43a6-9f16-563a8132995e', user_id: 'untrusted-user-id',
    kind: 'text', title: 'App note', body: 'content', items: [], pinned: false,
    deleted: false, created_at: '2026-09-14T18:00:00.123456Z', enc_v: 0, payload: null,
  });
  assert.equal(row.updated_at, undefined);
  assert.equal('user_id' in row, false);
  assert.equal(row.body, 'content');
});

test('Drive scheduling is bounded and results keep their input order', async () => {
  let active = 0, peak = 0;
  const result = await mapConcurrent([4, 3, 2, 1, 0], 2, async (n) => {
    peak = Math.max(peak, ++active);
    await delay(n * 2);
    active--;
    return n;
  });
  assert.deepEqual(result, [4, 3, 2, 1, 0]);
  assert.equal(peak, 2);
});

test('failed Drive work settles in-flight operations before returning', async () => {
  let settled = false;
  await assert.rejects(mapConcurrent([0, 1, 2], 2, async (n) => {
    if (n === 0) { await delay(1); throw new Error('drive_failure'); }
    await delay(20); settled = true;
  }), /drive_failure/);
  assert.ok(settled);
});

test('email lookup treats regex characters literally', () => {
  const pattern = new RegExp(`^${escapeRegex('a+b@example.com')}$`, 'i');
  assert.ok(pattern.test('A+B@EXAMPLE.COM'));
  assert.equal(pattern.test('ab@exampleXcom'), false);
  assert.equal(new RegExp(`^${escapeRegex('.*')}$`).test('someone@example.com'), false);
});

test('invalid payloads and malformed JSON produce 400', async () => {
  const app = new Hono();
  registerErrorHandler(app);
  app.post('/validate', async (c) => c.json(z.object({ value: z.number() }).parse(await c.req.json())));
  assert.equal((await app.request('/validate', { method: 'POST', body: '{}' })).status, 400);
  assert.equal((await app.request('/validate', { method: 'POST', body: '{' })).status, 400);
});

test('admin key checks reject wrong byte lengths without throwing', async () => {
  process.env.ADMIN_API_KEY = 'aa';
  const app = new Hono();
  app.use('*', requireAdmin);
  app.get('/', (c) => c.json({ ok: true }));
  for (const key of ['', 'bb', 'éé']) {
    assert.equal((await app.request('/', { headers: { 'x-admin-api-key': key } })).status, 401);
  }
  assert.equal((await app.request('/', { headers: { 'x-admin-api-key': 'aa' } })).status, 200);
});

test('Google tokens round-trip encrypted and reject tampered ciphertext', () => {
  process.env.TOKEN_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');
  const encrypted = encryptToken('test-refresh-token');
  assert.notEqual(encrypted, 'test-refresh-token');
  assert.equal(decryptToken(encrypted), 'test-refresh-token');
  const parts = encrypted.split('.');
  const cipher = Buffer.from(parts[2], 'base64'); cipher[0] ^= 1;
  parts[2] = cipher.toString('base64');
  assert.throws(() => decryptToken(parts.join('.')));
});

test('real Server entrypoint exposes health and rejects anonymous protected calls without MongoDB', async () => {
  process.env.MONGODB_URI = 'mongodb://127.0.0.1:27017';
  const { default: app } = await import('../src/app');
  assert.equal((await app.request('/api/health')).status, 200);
  for (const [path, method] of [
    ['/notes/push', 'POST'], ['/notes/pull', 'GET'], ['/vault', 'GET'],
    ['/energy', 'GET'], ['/atomicuser', 'PATCH'], ['/auth/logout', 'POST'],
    ['/admin/notifications', 'GET'],
  ]) assert.equal((await app.request(`/api${path}`, { method })).status, 401, path);
  assert.equal((await app.request('/api/auth/google/mobile', { method: 'POST', body: '{}' })).status, 400);
});

test('Drive create reuses an existing file with the same name instead of leaving a second copy', async () => {
  const calls: string[] = [];
  const fakeDrive = (existingId: string | null) => ({ files: {
    async list(args: { q: string }) { calls.push(`list:${args.q}`); return { data: { files: existingId ? [{ id: existingId }] : [] } }; },
    async update(args: { fileId: string }) { calls.push(`update:${args.fileId}`); return { data: { id: args.fileId, headRevisionId: '2' } }; },
    async create(args: { requestBody: { name: string; parents: string[] } }) { calls.push(`create:${args.requestBody.name}:${args.requestBody.parents[0]}`); return { data: { id: 'new-file', headRevisionId: '1' } }; },
  } }) as unknown as Parameters<typeof createNoteFileWith>[0];

  const reused = await createNoteFileWith(fakeDrive('file-9'), 'folder-1', 'note.atomic', { a: 1 });
  assert.equal(reused.id, 'file-9');
  assert.deepEqual(calls.map((call) => call.split(':')[0]), ['list', 'update']);
  assert.match(calls[0], /name = 'note\.atomic' and 'folder-1' in parents and trashed = false/);

  calls.length = 0;
  const created = await createNoteFileWith(fakeDrive(null), "fold'er", 'note.atomic', { a: 1 });
  assert.equal(created.id, 'new-file');
  assert.deepEqual(calls.map((call) => call.split(':')[0]), ['list', 'create']);
  assert.ok(calls[0].includes("'fold\\'er' in parents"));
});

test('encrypted and plaintext note content cannot be mixed', () => {
  const base = { id: 'cfded5cb-1027-43a6-9f16-563a8132995e', kind: 'text', title: '', body: '', items: [], pinned: false,
    deleted: false, created_at: '2026-09-14T18:00:00Z' };
  assert.equal(remoteNoteRowSchema.safeParse({ ...base, enc_v: 1, payload: 'ciphertext' }).success, true);
  assert.equal(remoteNoteRowSchema.safeParse({ ...base, enc_v: 1, payload: null }).success, false);
  assert.equal(remoteNoteRowSchema.safeParse({ ...base, enc_v: 1, payload: 'ciphertext', body: 'leak' }).success, false);
  assert.equal(remoteNoteRowSchema.safeParse({ ...base, enc_v: 0, payload: 'ciphertext' }).success, false);
  assert.equal(remoteNoteRowSchema.safeParse({ ...base, enc_v: 0, payload: null, body: 'x'.repeat(131073) }).success, false);
});

test('configuration issues name variables without exposing values', () => {
  const secret = 'super-secret-value-that-must-not-leak-into-output';
  const good = {
    MONGODB_URI: 'mongodb+srv://user:pass@cluster.example.net', TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString('base64'),
    GOOGLE_CLIENT_ID: 'id', GOOGLE_CLIENT_SECRET: 'secret', ADMIN_API_KEY: 'k'.repeat(32),
    GOOGLE_REDIRECT_URI: 'https://atomic-notes-server-gde2e.vercel.app/api/auth/callback',
  } as NodeJS.ProcessEnv;
  assert.deepEqual(getEnvIssues(good), []);
  const bad = { ...good, TOKEN_ENCRYPTION_KEY: secret, ADMIN_API_KEY: 'short', GOOGLE_CLIENT_ID: '', GOOGLE_REDIRECT_URI: 'http://localhost/cb' } as NodeJS.ProcessEnv;
  const issues = getEnvIssues(bad);
  assert.deepEqual(issues.map((issue) => issue.name).sort(), ['ADMIN_API_KEY', 'GOOGLE_CLIENT_ID', 'GOOGLE_REDIRECT_URI', 'TOKEN_ENCRYPTION_KEY']);
  assert.equal(JSON.stringify(issues).includes(secret), false);
  assert.doesNotThrow(() => assertProductionEnvironment({ ...bad, VERCEL_ENV: 'preview' } as NodeJS.ProcessEnv));
  assert.throws(() => assertProductionEnvironment({ ...bad, VERCEL_ENV: 'production' } as NodeJS.ProcessEnv), /TOKEN_ENCRYPTION_KEY/);
  assert.throws(() => assertProductionEnvironment({ ...bad, NODE_ENV: 'production' } as NodeJS.ProcessEnv), (error: Error) => !error.message.includes(secret));
});

test('Google error shapes are recognised: missing Drive file and revoked or expired grant', () => {
  for (const missing of [{ code: 404 }, { code: '404' }, { status: 404 }, { response: { status: 404 } }]) {
    assert.equal(isDriveNotFound(missing), true, JSON.stringify(missing));
  }
  for (const other of [{ code: 500 }, { status: 403 }, new Error('boom'), null, undefined, 'text']) {
    assert.equal(isDriveNotFound(other), false);
  }
  assert.equal(isInvalidGrant({ response: { data: { error: 'invalid_grant' } } }), true);
  assert.equal(isInvalidGrant(new Error('invalid_grant: Token has been expired or revoked.')), true);
  assert.equal(isInvalidGrant(new Error('socket hang up')), false);
  assert.equal(isInvalidGrant(null), false);
});

test('only our own errors show their code; Google errors with a status never leak', async () => {
  const app = new Hono();
  registerErrorHandler(app);
  app.get('/reauth', () => { throw httpError('google_reauth_required', 401); });
  app.get('/busy', () => { throw httpError('operation_in_progress', 409); });
  // A Google client error also has a numeric status and a message that may contain request details.
  app.get('/google', () => { throw Object.assign(new Error('Bearer ya29.secret-token in request'), { status: 401 }); });
  const reauth = await app.request('/reauth');
  assert.deepEqual([reauth.status, await reauth.json()], [401, { error: 'google_reauth_required' }]);
  const busy = await app.request('/busy');
  assert.deepEqual([busy.status, await busy.json()], [409, { error: 'operation_in_progress' }]);
  const google = await app.request('/google');
  assert.equal(google.status, 500);
  assert.deepEqual(await google.json(), { error: 'internal_error' });
});

test('a revoked Google grant answers 401 google_reauth_required and logs no request headers', async () => {
  const app = new Hono();
  registerErrorHandler(app);
  app.get('/revoked', () => {
    throw Object.assign(new Error('invalid_grant'), {
      response: { data: { error: 'invalid_grant' } },
      config: { headers: { Authorization: 'Bearer ya29.super-secret-token' } },
    });
  });
  app.get('/boom', () => {
    throw Object.assign(new Error('Request failed with status code 500'), { config: { headers: { Authorization: 'Bearer ya29.super-secret-token' } } });
  });
  const logged: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => { logged.push(args.map(String).join(' ')); };
  try {
    const revoked = await app.request('/revoked');
    assert.deepEqual([revoked.status, await revoked.json()], [401, { error: 'google_reauth_required' }]);
    assert.equal((await app.request('/boom')).status, 500);
  } finally { console.error = original; }
  assert.ok(logged.length >= 1);
  assert.equal(logged.join('\n').includes('ya29.super-secret-token'), false);
});

test('relative imports name .js files so the compiled output runs under plain Node ESM', () => {
  // tsx (used by these tests) forgives extensionless imports; the compiled output on Vercel does not.
  const offenders: string[] = [];
  const specifier = /(?:\bfrom\s+|^\s*import\s+|\bimport\s*\(\s*)(['"])(\.{1,2}\/[^'"]*)\1/gm;
  const scan = (file: string) => {
    for (const match of readFileSync(file, 'utf8').matchAll(specifier)) {
      if (!/\.(js|mjs|cjs|json)$/.test(match[2])) offenders.push(`${file}: ${match[2]}`);
    }
  };
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      else if (path.endsWith('.ts') && !path.endsWith('.d.ts')) scan(path);
    }
  };
  walk('src'); walk('api');
  assert.deepEqual(offenders, []);
});

test('Drive rate limits and 5xx are retryable; not-found, auth and bad requests are not', () => {
  const rateLimited = (reason: string) => ({ response: { status: 403, data: { error: { errors: [{ reason }] } } } });
  assert.equal(isDriveRetryable({ response: { status: 429 } }), true);
  assert.equal(isDriveRetryable({ status: 503 }), true);
  assert.equal(isDriveRetryable({ code: 500 }), true);
  assert.equal(isDriveRetryable(rateLimited('userRateLimitExceeded')), true);
  assert.equal(isDriveRetryable({ status: 403, errors: [{ reason: 'rateLimitExceeded' }] }), true);
  assert.equal(isDriveRetryable(rateLimited('insufficientFilePermissions')), false);
  for (const status of [400, 401, 404]) assert.equal(isDriveRetryable({ response: { status } }), false);
  assert.equal(isDriveRetryable(new Error('simulated_drive_failure')), false);
  assert.equal(isDriveRetryable(null), false);
});

test('withDriveRetry backs off on rate limits, then gives up; final errors are not retried', async () => {
  const waits: number[] = [];
  const sleep = async (ms: number) => { waits.push(ms); };
  let calls = 0;
  const flaky = async () => { if (++calls < 3) throw { response: { status: 429 } }; return 'written'; };
  assert.equal(await withDriveRetry(flaky, { sleep, baseMs: 100 }), 'written');
  assert.equal(calls, 3);
  assert.equal(waits.length, 2);
  assert.ok(waits[0] >= 100 && waits[0] < 200 && waits[1] >= 200 && waits[1] < 300);

  calls = 0;
  await assert.rejects(withDriveRetry(async () => { calls++; throw { status: 503 }; }, { sleep, attempts: 3 }));
  assert.equal(calls, 3);

  calls = 0;
  await assert.rejects(withDriveRetry(async () => { calls++; throw Object.assign(new Error('gone'), { code: 404 }); }, { sleep }), /gone/);
  assert.equal(calls, 1);
});

test('the welcome notifications have fixed, unique ids and point where the App can go', () => {
  const ids = WELCOME_NOTIFICATIONS.map((n) => n._id);
  assert.equal(new Set(ids).size, 3);
  for (const id of ids) assert.ok(z.string().uuid().safeParse(id).success, id);
  assert.deepEqual(WELCOME_NOTIFICATIONS.map((n) => n.actionUrl), [SUPPORT_URL, '/energypage', null]);
  assert.equal(new URL(SUPPORT_URL).protocol, 'https:');
  for (const n of WELCOME_NOTIFICATIONS) assert.equal(/[—;]/.test(n.description + n.subject), false, n.subject);
  // No payment platform by name: the website's support page says where to go.
  for (const n of WELCOME_NOTIFICATIONS) {
    assert.equal(/patreon|ko-?fi|paypal|buy ?me ?a ?coffee/i.test(`${n.subject} ${n.description} ${n.action ?? ''}`), false, n.subject);
  }
});

// New-policy contract tests; these are additions, not claims of a pre-existing bug fix.
import { coinExpiry, coinPolicyActivation } from '../src/lib/coinPolicy';
test('coin expiry uses six UTC calendar months, clamped, retaining milliseconds', () => {
  for (const [start, end] of [
    ['2026-08-30T23:59:59.123Z', '2027-02-28T23:59:59.123Z'],
    ['2026-09-15T00:00:00.000Z', '2027-03-15T00:00:00.000Z'],
    ['2027-08-31T12:34:56.789Z', '2028-02-29T12:34:56.789Z'],
    ['2026-12-31T00:00:00.000Z', '2027-06-30T00:00:00.000Z'],
  ]) assert.equal(coinExpiry(new Date(start)).toISOString(), end);
});
test('coin policy is inactive by default and requires an unambiguous activation instant', () => {
  const previous = process.env.COIN_EXPIRY_ACTIVATED_AT;
  try {
    delete process.env.COIN_EXPIRY_ACTIVATED_AT;
    assert.equal(coinPolicyActivation(), null);
    process.env.COIN_EXPIRY_ACTIVATED_AT = '2026-10-01T00:00:00.000Z';
    assert.equal(coinPolicyActivation(new Date('2026-09-30T23:59:59.999Z')), null);
    assert.equal(coinPolicyActivation(new Date('2026-10-01T00:00:00.000Z'))?.toISOString(), '2026-10-01T00:00:00.000Z');
    for (const bad of ['tomorrow', '2026-10-01', '2026-02-30T00:00:00.000Z']) {
      process.env.COIN_EXPIRY_ACTIVATED_AT = bad;
      assert.throws(() => coinPolicyActivation(), /Invalid COIN_EXPIRY_ACTIVATED_AT/);
    }
  } finally {
    if (previous === undefined) delete process.env.COIN_EXPIRY_ACTIVATED_AT;
    else process.env.COIN_EXPIRY_ACTIVATED_AT = previous;
  }
});


// Independent full-ledger oracle for the proposed retention statistics projection.
import { projectArchivedStatistics, combineLedgerStatistics, LEDGER_WINDOW_MS } from '../src/lib/ledgerStatistics';
import type { EnergyLedgerDoc } from '../src/db/collections';
const statsTime = Date.parse('2026-10-03T12:00:00.000Z');
function statisticsFixture(count: number): EnergyLedgerDoc[] {
  const kinds: EnergyLedgerDoc['kind'][] = ['daily_grant', 'convert', 'spend', 'purchase', 'admin_adjust'];
  return Array.from({ length: count }, (_, i) => ({ _id: `fixture-${i}`, userId: 'fixture-owner',
    kind: kinds[i % kinds.length], coinsDelta: i % 3 === 0 ? 5 : -2, energyDelta: i % 2 ? -10 : 20,
    resultingCoins: 50, resultingEnergy: 100, note: 'Not retained in statistics',
    createdAt: new Date(statsTime - Math.floor(i / 3) * 1000) }));
}
function fullLedgerOracle(rows: EnergyLedgerDoc[], at: number) {
  const result = { tx_24h: 0, coins_granted_24h: 0, energy_spent_24h: 0,
    ledger_by_kind: {} as Record<string, number> };
  for (const row of rows) {
    result.ledger_by_kind[row.kind] = (result.ledger_by_kind[row.kind] ?? 0) + 1;
    if (row.createdAt.getTime() >= at - 86400000) {
      result.tx_24h++;
      if (row.coinsDelta > 0) result.coins_granted_24h += row.coinsDelta;
      if (row.energyDelta < 0) result.energy_spent_24h -= row.energyDelta;
    }
  }
  return result;
}
for (const size of [0, 49, 50, 51, 1000, 10000]) {
  test(`retention statistics equal full ledger after keeping 50 of ${size} entries`, () => {
    const rows = statisticsFixture(size), keep = rows.slice(0, 50), remove = rows.slice(50);
    const archived = projectArchivedStatistics('fixture-owner', remove, statsTime);
    for (const at of [statsTime, statsTime + 1000, statsTime + LEDGER_WINDOW_MS, statsTime + LEDGER_WINDOW_MS + 1]) {
      assert.deepEqual(combineLedgerStatistics(keep, archived, at), fullLedgerOracle(rows, at));
    }
    assert.equal(JSON.stringify(archived).includes('Not retained'), false);
    assert.equal(JSON.stringify(archived).includes('resultingCoins'), false);
  });
}
test('statistics preserve inclusive millisecond cutoff, ties and future legacy timestamps', () => {
  const rows = statisticsFixture(5);
  const times = [statsTime - LEDGER_WINDOW_MS - 1, statsTime - LEDGER_WINDOW_MS,
    statsTime - LEDGER_WINDOW_MS + 1, statsTime - LEDGER_WINDOW_MS, statsTime + 1000];
  rows.forEach((row, i) => { row.createdAt = new Date(times[i]); });
  const archived = projectArchivedStatistics('fixture-owner', rows, statsTime);
  assert.equal(archived.recent.length, 3);
  assert.deepEqual(combineLedgerStatistics([], archived, statsTime), fullLedgerOracle(rows, statsTime));
  assert.deepEqual(combineLedgerStatistics([], archived, statsTime + 1), fullLedgerOracle(rows, statsTime + 1));
});
test('statistics reject mixed owners, duplicate rows and invalid dates', () => {
  const rows = statisticsFixture(1);
  assert.throws(() => projectArchivedStatistics('different-owner', rows, statsTime), /owner_mismatch/);
  assert.throws(() => projectArchivedStatistics('fixture-owner', [rows[0], rows[0]], statsTime), /duplicate/);
  assert.throws(() => projectArchivedStatistics('fixture-owner', [{ ...rows[0], createdAt: new Date(NaN) }], statsTime), /invalid_statistics_time/);
});

test('statistics refuse historical queries older than their projection', () => {
  const archived = projectArchivedStatistics('fixture-owner', statisticsFixture(2), statsTime);
  assert.throws(() => combineLedgerStatistics([], archived, statsTime - 1), /statistics_time_regression/);
});

import { ledgerInspectionArguments, ledgerOrderingIndexReady } from '../src/db/ledgerRetentionInspection';
test('ledger history inspection has no apply mode and refuses every unknown argument', () => {
  assert.equal(ledgerInspectionArguments([]), undefined);
  for (const args of [['--apply'], ['--apply', '--database', 'fixture'], ['--force'], ['--limit', '100'], ['--database', 'fixture']]) {
    assert.throws(() => ledgerInspectionArguments(args), /inspection only/);
  }
});

test('ordering readiness requires full usable non-TTL indexes and legacy-compatible sequence uniqueness', () => {
  for (const mode of ['legacy', 'sequence'] as const) {
    const key = mode === 'legacy' ? { userId: 1, createdAt: -1, _id: -1 } : { userId: 1, historySequence: -1 };
    assert.equal(ledgerOrderingIndexReady([], mode), false);
    assert.equal(ledgerOrderingIndexReady([{ key }], mode), true);
    assert.equal(ledgerOrderingIndexReady([{ key: { ...key, extra: 1 } }], mode), false);
    assert.equal(ledgerOrderingIndexReady([{ key: Object.fromEntries(Object.entries(key).reverse()) }], mode), false);
    for (const options of [{ partialFilterExpression: { historySequence: { $exists: true } } },
      { sparse: true }, { hidden: true }, { collation: { locale: 'en' } }, { expireAfterSeconds: 0 }]) {
      assert.equal(ledgerOrderingIndexReady([{ key, ...options }], mode), false);
    }
    assert.equal(ledgerOrderingIndexReady([{ key, unique: true }], mode), mode === 'legacy');
  }
});

import { ledgerWalletIssues } from '../src/db/ledgerIntegrityInspection';
test('wallet diagnostics accept legacy and contiguous ordered histories without returning account values', () => {
  const id = randomUUID(), wallet = { _id: id };
  assert.deepEqual(ledgerWalletIssues(wallet, []), []);
  assert.deepEqual(ledgerWalletIssues({ ...wallet, historyRetentionVersion: 1, historySequence: 0 }, []), []);
  const rows = [5, 3, 4].map(historySequence => ({ userId: id, historySequence }));
  assert.deepEqual(ledgerWalletIssues({ ...wallet, historyRetentionVersion: 1, historySequence: 5 }, rows), []);
  assert.deepEqual(ledgerWalletIssues({ ...wallet, historyRetentionVersion: 1, historySequence: Number.MAX_SAFE_INTEGER },
    [{ userId: id, historySequence: Number.MAX_SAFE_INTEGER }]), []);
});

test('wallet diagnostics distinguish partial metadata, invalid tails and the active history bound', () => {
  const id = randomUUID(), wallet = { _id: id, historyRetentionVersion: 1, historySequence: 3 };
  for (const fields of [{ historySequence: 2 }, { historyRetentionVersion: 2 }, { historyRetentionVersion: null },
    { historySequence: null }]) {
    assert.deepEqual(ledgerWalletIssues({ _id: id, ...fields }, []), ['partial_wallet_metadata']);
  }
  for (const counter of [undefined, null, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '3']) {
    assert.ok(ledgerWalletIssues({ ...wallet, historySequence: counter }, []).includes('invalid_ordered_history'));
  }
  for (const sequences of [[], [3, 3], [3, 1], [4], [undefined], [0], [-1], [1.5], ['3']]) {
    assert.ok(ledgerWalletIssues(wallet, sequences.map(historySequence => ({ userId: id, historySequence })))
      .includes('invalid_ordered_history'));
  }
  assert.ok(ledgerWalletIssues(wallet, [{ userId: randomUUID(), historySequence: 3 }]).includes('invalid_ordered_history'));
  assert.deepEqual(ledgerWalletIssues({ _id: 'invalid-owner' }, []), ['invalid_wallet_identity']);
  const tooMany = Array.from({ length: 51 }, (_, index) => ({ userId: id, historySequence: index + 1 }));
  assert.deepEqual(ledgerWalletIssues({ ...wallet, historySequence: 51 }, tooMany), ['ordered_history_over_limit']);
  const printed = JSON.stringify(ledgerWalletIssues({ ...wallet, historySequence: -1 }, tooMany));
  assert.equal(printed.includes(id), false);
});
