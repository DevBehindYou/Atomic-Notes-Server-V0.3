import assert from 'node:assert/strict';
import { fork, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { cpus, totalmem } from 'node:os';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { NOTE_LIMITS, remoteNoteRowSchema } from '../src/types/noteWire.js';
import { sealFixtureContent, threeImageContent } from './noteImageBudgetFixtures.js';
import {
  LOAD_REPORT_FILE, LOAD_SCOPE, SUFFICIENT_SAMPLES, assertLoopbackOrigin, assertNumbersAndCodesOnly, codeOf, driveCallsOf,
  confirmCleanup, installLoopbackOnlyNetwork, ipcClient, latencySummary, loadDatabase, loadToken, mb, percentile, recovery, saturation,
} from './loadCharacterizeCore.js';

// C48: synthetic load and resource characterization of the App Server's sync routes.
//
//   MONGODB_URI=mongodb://127.0.0.1:27017/?replicaSet=rs0&directConnection=true npm run bench:load -- --smoke|--full
//
// Three processes: this load client, the App Server (tests/loadCharacterizeApp.ts: the real notes
// routes on a freshly named disposable database) and a loopback Google Drive stand-in
// (tests/loadCharacterizeDrive.ts). Every TCP connection is refused unless it goes to a loopback
// address. Writes ci-load-characterization.json: numbers and snake_case codes only. The numbers
// describe this harness on this machine; they are not a production capacity claim.

const variant = process.argv.includes('--full') ? 'full' : 'smoke';
if (process.argv.slice(2).some((arg) => arg !== '--full' && arg !== '--smoke')) throw new Error('load_invalid_arguments');
loadDatabase(process.env.MONGODB_URI, process.env.MONGODB_DB_NAME); // fail fast, before any helper starts
installLoopbackOnlyNetwork();

const USERS = 32, NOTES_PER_USER = 10, CREATED = '2026-11-08T00:00:00.000Z';
const ENVELOPES = ['plain_small', 'plain_medium', 'plain_images', 'plain_near_limit',
  'enc_small', 'enc_medium', 'enc_images', 'enc_near_limit'] as const;
type Envelope = (typeof ENVELOPES)[number];
/** Each synthetic account's ten notes: mostly small text, one of each heavier kind. Pull pages read all ten. */
const SLOTS: Envelope[] = ['plain_small', 'plain_small', 'plain_small', 'plain_medium', 'plain_images', 'plain_near_limit',
  'enc_small', 'enc_medium', 'enc_images', 'enc_near_limit'];

// ---- Synthetic envelopes ------------------------------------------------------------------------
type Content = { title: string; body: string; items: { text: string; done: boolean }[] };
const baseRow = { kind: 'text' as const, pinned: false, deleted: false, created_at: CREATED };
const small: Content = { title: 'Synthetic load note', body: 'Synthetic load body. '.repeat(10), items: [] };
const medium: Content = { title: 'Synthetic medium note', body: 'Synthetic medium load body. '.repeat(585), items: [] };
const images: Content = threeImageContent();
/** Plaintext as close to the 400 000-byte wire limit as a varying title allows. */
const nearLimit: Content = (() => {
  const empty = { ...baseRow, id: randomUUID(), title: 'Synthetic near-limit note 0000000', body: '', items: [],
    enc_v: 0, payload: null, base_version: 1000000, encV: 0 };
  const room = NOTE_LIMITS.wireBytes - 2048 - Buffer.byteLength(JSON.stringify(empty));
  return { title: 'Synthetic near-limit note', body: '€'.repeat(Math.floor(room / 3)), items: [] };
})();
/** Plaintext whose sealed payload is just under the 393 216-character payload limit. */
const nearLimitSecret: Content = { title: '', body: 'a'.repeat(Math.floor((NOTE_LIMITS.payload - 1024) / 4) * 3 - 28 - 64), items: [] };

function rowFor(envelope: Envelope, id: string, baseVersion: number, seq: number) {
  const plain = (content: Content) => ({ ...baseRow, id, title: `${content.title} ${seq}`, body: content.body, items: content.items,
    enc_v: 0 as const, payload: null, base_version: baseVersion });
  // The App's AES-GCM envelope with a fixed public fixture key; a fresh nonce makes every push new content.
  const sealed = (content: Content) => ({ ...baseRow, id, title: '', body: '', items: [], enc_v: 1 as const,
    payload: sealFixtureContent({ ...content, title: `${content.title} ${seq}` }), base_version: baseVersion });
  switch (envelope) {
    case 'plain_small': return plain(small);
    case 'plain_medium': return plain(medium);
    case 'plain_images': return plain(images);
    case 'plain_near_limit': return plain(nearLimit);
    case 'enc_small': return sealed(small);
    case 'enc_medium': return sealed(medium);
    case 'enc_images': return sealed(images);
    case 'enc_near_limit': return sealed(nearLimitSecret);
  }
}
const envelopeWireBytes = Object.fromEntries(ENVELOPES.map((envelope) => {
  const row = rowFor(envelope, randomUUID(), 999999, 9999999);
  const parsed = remoteNoteRowSchema.safeParse(row);
  assert.ok(parsed.success, `${envelope} must be a valid wire row`);
  return [envelope, Buffer.byteLength(JSON.stringify({ ...row, encV: row.enc_v }))];
}));

// ---- Helper processes ---------------------------------------------------------------------------
type Ready = { type: 'ready'; port: number; mongoMajor?: number };
function start(file: string, args: string[]) {
  const child = fork(fileURLToPath(new URL(file, import.meta.url)), args, {
    execArgv: ['--expose-gc', '--import', 'tsx'], stdio: ['ignore', 'inherit', 'inherit', 'ipc'] });
  const ready = new Promise<Ready>((resolve, reject) => {
    child.once('message', (message: Ready) => message?.type === 'ready' ? resolve(message) : reject(new Error('load_helper_not_ready')));
    child.once('exit', () => reject(new Error('load_helper_exited_before_ready')));
  });
  return { child, ready, ipc: ipcClient(child) };
}
type DriveStats = { requests: number; faulted: number; foreignAuth: number; maxInFlight: number; files: number;
  storedBytes: number; transportIn: number; transportOut: number };
type AppSnapshot = { rss: number; heapUsed: number; peakRss: number; peakHeapUsed: number; mongoCommands: number;
  transportIn: number; transportOut: number };

const children: ChildProcess[] = [];
const drive = start('./loadCharacterizeDrive.ts', []);
children.push(drive.child);
const driveOrigin = assertLoopbackOrigin(`http://127.0.0.1:${(await drive.ready).port}`);
const appProcess = start('./loadCharacterizeApp.ts', [driveOrigin, String(USERS)]);
children.push(appProcess.child);
const appReady = await appProcess.ready;
const appOrigin = assertLoopbackOrigin(`http://127.0.0.1:${appReady.port}`);

// ---- Load client --------------------------------------------------------------------------------
type Note = { id: string; slot: number; version: number };
const accounts = Array.from({ length: USERS }, (_, i) => ({
  token: loadToken(i), seq: 0,
  notes: SLOTS.map((_, slot): Note => ({ id: randomUUID(), slot, version: 0 })),
}));
type Account = (typeof accounts)[number];
type Outcome = { start: number; end: number; latency: number; ok: boolean; requestBytes: number; responseBytes: number;
  driveCalls: number; errors: string[] };

type Spec = { id: string; op: 'push' | 'pull'; envelope: Envelope | 'mix'; concurrency: number; samples: number;
  latencyMs: number; fault?: { status: 429 | 503; atMs: number; durationMs: number; tailMs: number } };

async function send(account: Account, spec: Pick<Spec, 'op' | 'envelope'>, t0: number, rows?: Note[]): Promise<Outcome> {
  const start = performance.now() - t0;
  let requestBytes = 0, responseBytes = 0, driveCalls = 0, ok = false;
  const errors: string[] = [];
  try {
    const headers: { [key: string]: string } = { authorization: `Bearer ${account.token}` };
    let response: Response;
    let notes: Note[] = [];
    if (spec.op === 'push') {
      notes = rows ?? [spec.envelope === 'mix'
        ? account.notes[account.seq % NOTES_PER_USER]
        : account.notes[SLOTS.indexOf(spec.envelope)]];
      const body = JSON.stringify({ requestId: randomUUID(), mode: 'instant',
        rows: notes.map((note) => rowFor(SLOTS[note.slot], note.id, note.version, ++account.seq)) });
      requestBytes = Buffer.byteLength(body);
      response = await fetch(`${appOrigin}/api/notes/push`, { method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body });
    } else {
      response = await fetch(`${appOrigin}/api/notes/pull?after=0`, { headers });
    }
    const buffer = Buffer.from(await response.arrayBuffer());
    responseBytes = buffer.length;
    driveCalls = driveCallsOf(response.headers.get('server-timing'));
    const json = JSON.parse(buffer.toString('utf8')) as { error?: unknown; results?: { id: string; ok: boolean; version?: number; error?: unknown }[];
      rows?: unknown[]; hasMore?: boolean };
    if (response.status !== 200) errors.push(`http_${response.status}_${codeOf(json.error)}`);
    else if (spec.op === 'push') {
      const byId = new Map(notes.map((note) => [note.id, note]));
      for (const result of json.results ?? []) {
        if (result.ok && typeof result.version === 'number') byId.get(result.id)!.version = result.version;
        else if (!result.ok) errors.push(`row_${codeOf(result.error)}`);
      }
      if ((json.results ?? []).length !== notes.length) errors.push('push_result_count_mismatch');
    } else if ((json.rows ?? []).length !== NOTES_PER_USER || json.hasMore) errors.push('pull_page_incomplete');
    ok = errors.length === 0;
  } catch {
    errors.push('client_request_failed');
  }
  const end = performance.now() - t0;
  return { start, end, latency: end - start, ok, requestBytes, responseBytes, driveCalls, errors };
}

/** Runs [concurrency] workers, worker i acting as account i, until [more] says stop. */
async function workers(concurrency: number, more: () => boolean, one: (account: Account) => Promise<void>) {
  await Promise.all(Array.from({ length: concurrency }, async (_, i) => { while (more()) await one(accounts[i]); }));
}

const round = (value: number, places = 2) => Math.round(value * 10 ** places) / 10 ** places;
const sum = (records: Outcome[], key: 'requestBytes' | 'responseBytes' | 'driveCalls') => records.reduce((total, r) => total + r[key], 0);
const HARD_LIMIT_MS = variant === 'full' ? 240000 : 90000;

async function run(spec: Spec) {
  await drive.ipc.call({ type: 'configure', latencyMs: spec.latencyMs });
  const warmups = Math.max(4, spec.concurrency * 2);
  let warmed = 0;
  await workers(spec.concurrency, () => warmed++ < warmups, async (account) => { await send(account, spec, performance.now()); });
  await appProcess.ipc.call({ type: 'reset' });
  await drive.ipc.call({ type: 'reset' });
  const app0 = await appProcess.ipc.call<AppSnapshot>({ type: 'snapshot' });
  const drive0 = await drive.ipc.call<DriveStats>({ type: 'stats' });
  const records: Outcome[] = [];
  const t0 = performance.now();
  let faultStart = -1, faultEnd = -1, truncated = 0;
  const faultTimer = spec.fault && setTimeout(() => {
    const sent = performance.now() - t0;
    void drive.ipc.call({ type: 'configure', latencyMs: spec.latencyMs, faultStatus: spec.fault!.status, faultMs: spec.fault!.durationMs })
      .then(() => { faultStart = (sent + performance.now() - t0) / 2; faultEnd = faultStart + spec.fault!.durationMs; });
  }, spec.fault.atMs);
  const runUntil = spec.fault ? spec.fault.atMs + spec.fault.durationMs + spec.fault.tailMs : 0;
  let taken = 0;
  await workers(spec.concurrency, () => {
    const elapsed = performance.now() - t0;
    if (elapsed > HARD_LIMIT_MS) { truncated = 1; return false; }
    if (taken < spec.samples || elapsed < runUntil) { taken++; return true; }
    return false;
  }, async (account) => { records.push(await send(account, spec, t0)); });
  if (faultTimer) clearTimeout(faultTimer);
  const durationMs = performance.now() - t0;
  const app1 = await appProcess.ipc.call<AppSnapshot>({ type: 'snapshot' });
  const drive1 = await drive.ipc.call<DriveStats>({ type: 'stats' });
  await drive.ipc.call({ type: 'configure', latencyMs: 0 });

  const latencies = records.map((r) => r.latency);
  const errors: { [code: string]: number } = {};
  for (const r of records) for (const code of r.errors) errors[code] = (errors[code] ?? 0) + 1;
  const failed = records.filter((r) => !r.ok).length;
  const n = Math.max(records.length, 1);
  const providerCalls = sum(records, 'driveCalls'), mongo = app1.mongoCommands - app0.mongoCommands;
  const providerRequests = drive1.requests - drive0.requests;
  return {
    id: spec.id, operation: spec.op, envelope: spec.envelope, concurrency: spec.concurrency,
    provider_latency_ms: spec.latencyMs, fault: spec.fault ? `http_${spec.fault.status}` : 'none', fault_ms: spec.fault?.durationMs ?? 0,
    samples: records.length, samples_target: spec.samples, samples_sufficient: records.length >= SUFFICIENT_SAMPLES ? 1 : 0,
    warmup_requests: warmups, truncated, duration_ms: round(durationMs, 0), throughput_rps: round(records.length / (durationMs / 1000)),
    latency_ms: latencySummary(latencies),
    error_rate: round(failed / n, 4), failed_requests: failed, errors,
    app_memory_mb: { rss_before: mb(app0.rss), rss_after: mb(app1.rss), rss_peak: mb(app1.peakRss),
      heap_used_before: mb(app0.heapUsed), heap_used_after: mb(app1.heapUsed), heap_used_peak: mb(app1.peakHeapUsed) },
    logical: { requests: records.length, provider_calls: providerCalls, provider_calls_per_request: round(providerCalls / n),
      mongo_commands: mongo, mongo_commands_per_request: round(mongo / n) },
    app_bytes: { request_payload: sum(records, 'requestBytes'), response_payload: sum(records, 'responseBytes'),
      request_payload_per_request: round(sum(records, 'requestBytes') / n, 0), response_payload_per_request: round(sum(records, 'responseBytes') / n, 0),
      transport_in: app1.transportIn - app0.transportIn, transport_out: app1.transportOut - app0.transportOut },
    provider_transport: { requests: providerRequests, requests_per_logical_call: round(providerRequests / Math.max(providerCalls, 1)),
      faulted_answers: drive1.faulted - drive0.faulted, max_in_flight: drive1.maxInFlight,
      bytes_in: drive1.transportIn - drive0.transportIn, bytes_out: drive1.transportOut - drive0.transportOut },
    ...(spec.fault ? { recovery: faultStart >= 0 ? recovery(records, faultStart, faultEnd) : { fault_not_started: 1 } } : {}),
    _foreignAuth: drive1.foreignAuth - drive0.foreignAuth,
  };
}

// ---- Scenarios ----------------------------------------------------------------------------------
const full = variant === 'full';
const points = full ? 240 : 40, envelopePoints = full ? 240 : 24, slowPoints = full ? 240 : 32;
const LEVELS = [1, 4, 16, 32];
const specs: Spec[] = [
  ...LEVELS.map((c): Spec => ({ id: `pull_mix_c${c}`, op: 'pull', envelope: 'mix', concurrency: c, samples: points, latencyMs: 0 })),
  ...LEVELS.map((c): Spec => ({ id: `push_mix_c${c}`, op: 'push', envelope: 'mix', concurrency: c, samples: points, latencyMs: 0 })),
  ...ENVELOPES.map((e): Spec => ({ id: `push_${e}_c4`, op: 'push', envelope: e, concurrency: 4, samples: envelopePoints, latencyMs: 0 })),
  { id: 'push_mix_c16_latency100', op: 'push', envelope: 'mix', concurrency: 16, samples: slowPoints, latencyMs: 100 },
  { id: 'push_mix_c16_latency500', op: 'push', envelope: 'mix', concurrency: 16, samples: slowPoints, latencyMs: 500 },
  { id: 'pull_mix_c16_latency100', op: 'pull', envelope: 'mix', concurrency: 16, samples: slowPoints, latencyMs: 100 },
  // A 429 burst shorter than the route's retry budget (4 attempts, 0.5/1/2 s backoff): absorbed by retries.
  { id: 'push_mix_c16_burst429', op: 'push', envelope: 'mix', concurrency: 16, samples: SUFFICIENT_SAMPLES, latencyMs: 0,
    fault: { status: 429, atMs: 1500, durationMs: 1000, tailMs: 6000 } },
  // A 503 outage longer than the retry budget: rows fail, then the route must recover on its own.
  { id: 'push_mix_c16_outage503', op: 'push', envelope: 'mix', concurrency: 16, samples: SUFFICIENT_SAMPLES, latencyMs: 0,
    fault: { status: 503, atMs: 1500, durationMs: 6000, tailMs: 6000 } },
  ...(full ? [{ id: 'pull_mix_c4_outage503', op: 'pull', envelope: 'mix', concurrency: 4, samples: SUFFICIENT_SAMPLES, latencyMs: 0,
    fault: { status: 503, atMs: 1500, durationMs: 6000, tailMs: 6000 } } satisfies Spec] : []),
];

let exitCode = 0;
let report: { outcome: string; checks: Record<string, number>; saturation: unknown; [key: string]: unknown } | undefined;
try {
  // Seed: every account pushes its ten notes in one request (the first-sync shape), eight accounts at a time.
  const seedStart = performance.now();
  let nextSeed = 0;
  const seedRecords: Outcome[] = [];
  await Promise.all(Array.from({ length: 8 }, async () => {
    while (nextSeed < USERS) {
      const account = accounts[nextSeed++];
      seedRecords.push(await send(account, { op: 'push', envelope: 'mix' }, seedStart, account.notes));
    }
  }));
  assert.ok(seedRecords.every((r) => r.ok), 'load_seed_failed');
  assert.ok(accounts.every((a) => a.notes.every((note) => note.version > 0)), 'load_seed_incomplete');
  const seedDurationMs = round(performance.now() - seedStart, 0);

  const scenarios: Awaited<ReturnType<typeof run>>[] = [];
  for (const spec of specs) {
    const result = await run(spec);
    scenarios.push(result);
    const { latency_ms: l } = result;
    console.log('LOAD_SCENARIO', JSON.stringify({ id: result.id, samples: result.samples, rps: result.throughput_rps, p50: l.p50, p99: l.p99,
      max: l.max, error_rate: result.error_rate, rss_peak_mb: result.app_memory_mb.rss_peak }));
  }
  const sweep = (op: 'push' | 'pull') => saturation(scenarios.filter((s) => s.operation === op && s.envelope === 'mix' &&
    s.provider_latency_ms === 0 && s.fault === 'none').map((s) => ({ concurrency: s.concurrency, throughputRps: s.throughput_rps,
    p99Ms: s.latency_ms.p99, errorRate: s.error_rate })));
  const foreignAuth = scenarios.reduce((total, s) => total + s._foreignAuth, 0);
  const checks = {
    foreign_provider_auth: foreignAuth,
    empty_scenarios: scenarios.filter((s) => s.samples === 0).length,
    faults_not_injected: scenarios.filter((s) => s.fault !== 'none' && s.provider_transport.faulted_answers === 0).length,
    faults_not_recovered: scenarios.filter((s) => s.fault !== 'none' &&
      (!s.recovery || 'fault_not_started' in s.recovery || s.recovery.qualified !== 1)).length,
    truncated_scenarios: scenarios.filter((s) => s.truncated).length,
  };
  report = {
    version: 1, task: 'c48', scope: LOAD_SCOPE, variant, outcome: Object.values(checks).every((v) => v === 0) ? 'pass' : 'fail', checks,
    sufficient_samples_threshold: SUFFICIENT_SAMPLES,
    environment: { node_major: Number(process.versions.node.split('.')[0]), mongo_major: appReady.mongoMajor ?? 0, cpu_count: cpus().length,
      total_memory_mb: mb(totalmem()), accounts: USERS, notes_per_account: NOTES_PER_USER, push_rows_per_request: 1 },
    note_limits: { wire_bytes: NOTE_LIMITS.wireBytes, payload_chars: NOTE_LIMITS.payload, body_chars: NOTE_LIMITS.body },
    envelope_wire_bytes: envelopeWireBytes,
    seed: { requests: seedRecords.length, rows: USERS * NOTES_PER_USER, duration_ms: seedDurationMs,
      p50_ms: round(percentile(seedRecords.map((r) => r.latency), 0.5)), request_payload_per_request: round(sum(seedRecords, 'requestBytes') / USERS, 0) },
    scenarios: scenarios.map(({ _foreignAuth, ...rest }) => rest),
    saturation: { push_mix: sweep('push'), pull_mix: sweep('pull') },
  };
  if (report.outcome !== 'pass') exitCode = 1;
} catch (error) {
  console.error('load_characterization_failed', error instanceof Error ? error.message : 'unknown');
  exitCode = 1;
} finally {
  const cleanupOk = await confirmCleanup(() => appProcess.ipc.call({ type: 'close' }));
  if (!cleanupOk) { exitCode = 1; console.error('load_cleanup_failed'); }
  for (const child of children) if (child.exitCode === null) child.kill();
  if (report) {
    report.checks.cleanup_failed = cleanupOk ? 0 : 1;
    report.outcome = exitCode === 0 ? 'pass' : 'fail';
    assertNumbersAndCodesOnly(report);
    writeFileSync(LOAD_REPORT_FILE, JSON.stringify(report, null, 2) + '\n');
    console.log('LOAD_SUMMARY', JSON.stringify({ outcome: report.outcome, checks: report.checks, saturation: report.saturation }));
  }
}
process.exit(exitCode);
