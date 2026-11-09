import assert from 'node:assert/strict';
import test from 'node:test';
import net from 'node:net';
import { randomUUID } from 'node:crypto';
import {
  LOAD_SCOPE, assertLoopbackOrigin, assertNumbersAndCodesOnly, codeOf, connectTarget, driveCallsOf, installLoopbackOnlyNetwork,
  latencySummary, loadDatabase, loadToken, percentile, recovery, saturation,
} from './loadCharacterizeCore.js';

// C48: the pure parts of the load characterization harness. No MongoDB, no network beyond loopback.

test('percentiles use nearest rank on an unsorted sample', () => {
  const values = Array.from({ length: 200 }, (_, i) => 200 - i); // 200..1
  assert.equal(percentile(values, 0.5), 100);
  assert.equal(percentile(values, 0.9), 180);
  assert.equal(percentile(values, 0.99), 198);
  assert.equal(percentile(values, 1), 200);
  assert.equal(percentile([7], 0.01), 7);
  assert.equal(percentile([], 0.5), 0);
  assert.throws(() => percentile(values, 0), RangeError);
  assert.throws(() => percentile(values, 1.5), RangeError);
  assert.deepEqual(latencySummary([1, 2, 3, 4]), { min: 1, mean: 2.5, p50: 2, p90: 4, p99: 4, max: 4 });
  assert.deepEqual(values.slice(0, 3), [200, 199, 198], 'input is not sorted in place');
});

test('only a single loopback MongoDB without credentials or a selected database is accepted', () => {
  for (const uri of ['mongodb://127.0.0.1:27017/?replicaSet=rs0&directConnection=true', 'mongodb://localhost:27017',
    'mongodb://127.0.0.1:27017/', 'mongodb://[::1]:27017/?directConnection=true']) {
    assert.match(loadDatabase(uri), /^atomic_test_[a-f0-9]{20}$/, uri);
  }
  assert.notEqual(loadDatabase('mongodb://127.0.0.1:27017'), loadDatabase('mongodb://127.0.0.1:27017'), 'a fresh name each run');
  for (const uri of [undefined, '', 'not a uri',
    'mongodb+srv://cluster0.example.mongodb.net/?retryWrites=true',
    'mongodb+srv://127.0.0.1/',
    'mongodb://cluster0-shard-00-00.example.mongodb.net:27017/?ssl=true',
    'mongodb://10.0.0.5:27017', 'mongodb://127.0.0.2:27017', 'mongodb://localhost.example.com:27017',
    'mongodb://user:pass@127.0.0.1:27017', 'mongodb://user@127.0.0.1:27017',
    'mongodb://127.0.0.1:27017,127.0.0.1:27018/?replicaSet=rs0', 'mongodb://127.0.0.1:27017,remote.example.com:27017',
    'mongodb://127.0.0.1:27017/atomic_notes', 'mongodb://127.0.0.1', 'mongodb://127.0.0.1:0',
    'mongodb://127.0.0.1:27017/?authSource=admin', 'mongodb://127.0.0.1:27017/?tls=true', 'http://127.0.0.1:27017']) {
    assert.throws(() => loadDatabase(uri), /load_requires_local_mongodb/, String(uri));
  }
  assert.throws(() => loadDatabase('mongodb://127.0.0.1:27017', 'atomic_notes'), /load_database_must_be_generated/);
  assert.throws(() => loadDatabase('mongodb://127.0.0.1:27017', ''), /load_database_must_be_generated/);
});

test('the Google stand-in must be plain HTTP on loopback; real Google hosts are refused', () => {
  assert.equal(assertLoopbackOrigin('http://127.0.0.1:41234'), 'http://127.0.0.1:41234');
  assert.equal(assertLoopbackOrigin('http://localhost:41234/'), 'http://localhost:41234');
  for (const origin of ['https://www.googleapis.com', 'https://oauth2.googleapis.com', 'https://accounts.google.com',
    'http://www.googleapis.com:80', 'https://127.0.0.1:443', 'http://127.0.0.1', 'http://127.0.0.1:4000/drive/v3',
    'http://127.0.0.1:4000/?x=1', 'http://user:pass@127.0.0.1:4000', 'http://10.1.2.3:4000', 'http://127.0.0.1.nip.io:4000', '']) {
    assert.throws(() => assertLoopbackOrigin(origin), /load_requires_loopback_google_fixture/, origin);
  }
});

test('the network guard reads every net.Socket#connect form and refuses non-loopback hosts', async () => {
  assert.equal(connectTarget([{ host: 'www.googleapis.com', port: 443 }]), 'www.googleapis.com');
  assert.equal(connectTarget([[{ host: '142.250.0.1', port: 443 }, () => undefined]]), '142.250.0.1');
  assert.equal(connectTarget([{ port: 27017 }]), 'localhost');
  assert.equal(connectTarget([443, 'oauth2.googleapis.com']), 'oauth2.googleapis.com');
  assert.equal(connectTarget(['443']), 'localhost');
  assert.equal(connectTarget([{ path: '/tmp/mongodb.sock' }]), null);
  assert.equal(connectTarget(['/tmp/mongodb.sock']), null);
  installLoopbackOnlyNetwork();
  installLoopbackOnlyNetwork(); // idempotent
  for (const target of [{ host: 'www.googleapis.com', port: 443 }, { host: '192.0.2.1', port: 443 }, { host: '::ffff:8.8.8.8', port: 53 }]) {
    assert.throws(() => net.connect(target), /load_non_loopback_connection_refused/, target.host);
  }
  assert.throws(() => net.connect(443, 'oauth2.googleapis.com'), /load_non_loopback_connection_refused/);
  // Loopback is allowed through: a closed port fails asynchronously, not with the guard error.
  const server = net.createServer().listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const { port } = server.address() as net.AddressInfo;
  const socket = net.connect(port, '127.0.0.1');
  await new Promise((resolve, reject) => { socket.once('connect', resolve); socket.once('error', reject); });
  socket.destroy();
  await new Promise((resolve) => server.close(resolve));
});

test('saturation is the first level where throughput stops growing 10% or errors pass 1%', () => {
  const point = (concurrency: number, throughputRps: number, p99Ms = 10, errorRate = 0) => ({ concurrency, throughputRps, p99Ms, errorRate });
  assert.deepEqual(saturation([point(1, 50), point(4, 180), point(16, 400), point(32, 410, 80)]),
    { concurrency: 32, reason: 'throughput_gain_below_10_percent', p99_ratio_vs_lowest: 8 });
  assert.deepEqual(saturation([point(4, 180), point(1, 50), point(16, 300, 20, 0.05)]),
    { concurrency: 16, reason: 'error_rate_above_1_percent' });
  assert.deepEqual(saturation([point(1, 50), point(4, 180)]), { concurrency: 0, reason: 'not_reached_within_tested_levels' });
  assert.deepEqual(saturation([]), { concurrency: 0, reason: 'not_reached_within_tested_levels' });
});

test('recovery measures disturbance after a fault window and the settled latency after it', () => {
  const s = (start: number, latency: number, ok = true) => ({ start, end: start + latency, latency, ok });
  const samples = [
    ...Array.from({ length: 100 }, (_, i) => s(i * 10, 10)), // baseline before the fault at 1000 ms
    s(1005, 3000), s(1010, 4000, false), s(2500, 2400), // retried, failed, retried past the window end (2000 ms)
    ...Array.from({ length: 50 }, (_, i) => s(5000 + i * 10, 12)),
  ];
  const result = recovery(samples, 1000, 2000, { graceMs: 3000, windowMs: 500, minSamples: 20 });
  assert.equal(result.pre_fault_samples, 100);
  assert.equal(result.pre_fault_p99_ms, 10);
  assert.equal(result.disturbed_threshold_ms, 60);
  assert.equal(result.disturbed_samples, 3);
  assert.equal(result.failed_samples, 1);
  assert.equal(result.first_failure_after_fault_start_ms, 4010);
  assert.equal(result.recovery_ms, 3010); // last disturbed request ends at 5010
  assert.equal(result.settled_samples, 50);
  assert.equal(result.settled_failed, 0);
  assert.equal(result.settled_p99_ms, 12);
  const calm = recovery([s(0, 10), s(1500, 10), s(3000, 10)], 1000, 2000,
    { graceMs: 0, windowMs: 1010, minSamples: 1 });
  assert.deepEqual([calm.recovery_ms, calm.disturbed_samples, calm.first_failure_after_fault_start_ms, calm.settled_samples], [0, 0, -1, 1]);
});

test('cleanup succeeds only with an explicit acknowledgement and is bounded on failure', async () => {
  const { confirmCleanup } = await import('./loadCharacterizeCore.js');
  assert.equal(await confirmCleanup(async () => ({ ok: true })), true);
  assert.equal(await confirmCleanup(async () => ({ ok: false })), false);
  assert.equal(await confirmCleanup(async () => undefined), false);
  assert.equal(await confirmCleanup(async () => { throw new Error('synthetic_cleanup_failure'); }), false);
  assert.equal(await confirmCleanup(() => new Promise(() => undefined), 5), false);
});

test('Server-Timing drive call counts are parsed, anything else is zero', () => {
  assert.equal(driveCallsOf('total;dur=12, drive;dur=7;desc="3 calls"'), 3);
  assert.equal(driveCallsOf('total;dur=1, drive;dur=0;desc="0 calls"'), 0);
  assert.equal(driveCallsOf(null), 0);
  assert.equal(driveCallsOf('total;dur=1'), 0);
});

test('recovery examines an independent window including errors before a final successful request', () => {
  const sample = (start: number, ok = true) => ({ start, end: start + 10, latency: 10, ok });
  const result = recovery([sample(0), sample(1100, false), sample(1200, false), sample(1300, false), sample(1490)],
    500, 1000, { graceMs: 0, windowMs: 500, minSamples: 3 });
  assert.equal(result.settled_samples, 4);
  assert.equal(result.settled_failed, 3);
  assert.equal(result.observation_complete, 1);
  assert.equal(result.qualified, 0);
});

test('recovery requires enough samples and the complete preselected observation duration', () => {
  const sample = (start: number) => ({ start, end: start + 10, latency: 10, ok: true });
  const options = { graceMs: 0, windowMs: 500, minSamples: 3 };
  const good = recovery([sample(0), sample(1100), sample(1200), sample(1490)], 500, 1000, options);
  assert.equal(good.qualified, 1);
  assert.equal(good.settled_samples, 3);
  const tooFew = recovery([sample(0), sample(1100), sample(1490)], 500, 1000, options);
  assert.equal(tooFew.qualified, 0);
  const tooShort = recovery([sample(0), sample(1100), sample(1200), sample(1300)], 500, 1000, options);
  assert.equal(tooShort.observation_complete, 0);
  assert.equal(tooShort.qualified, 0);
});

test('the report holds only numbers and snake_case codes: tokens, ids, text and non-finite numbers are refused', () => {
  const report = { version: 1, scope: LOAD_SCOPE, variant: 'smoke', scenarios: [{ id: 'push_mix_c16_outage503', operation: 'push',
    latency_ms: { p50: 1.5, p99: 20 }, errors: { http_500_internal_error: 3, row_note_write_failed: 2 }, recovery: { recovery_ms: 0 } }],
    saturation: { push_mix: { concurrency: 0, reason: 'not_reached_within_tested_levels' } } };
  assert.doesNotThrow(() => assertNumbersAndCodesOnly(report));
  assert.match(LOAD_SCOPE, /local/);
  for (const leak of [loadToken(0), randomUUID(), 'Bearer atomic-load-access', 'ya29.a0AfH6SMB', 'user@example.test',
    'Synthetic load note 12', 'QUJDREVGRw==', 'mongodb://127.0.0.1:27017', 'Error: connect ECONNREFUSED', '']) {
    assert.throws(() => assertNumbersAndCodesOnly({ ...report, extra: leak }), /load_report_free_text/, leak);
    assert.throws(() => assertNumbersAndCodesOnly({ ...report, errors: { [leak]: 1 } }), /load_report_free_text/, leak);
  }
  for (const value of [Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.throws(() => assertNumbersAndCodesOnly({ x: value }), /load_report_non_finite/);
  }
  for (const value of [null, true, undefined]) assert.throws(() => assertNumbersAndCodesOnly({ x: value }), /load_report_unsupported_value/);
  assert.equal(codeOf('note_write_failed'), 'note_write_failed');
  for (const value of ['Note exceeds 400 KB sync limit', 'internal-error', 42, undefined, 'x'.repeat(81)]) assert.equal(codeOf(value), 'other');
});
