import { randomUUID } from 'node:crypto';
import net from 'node:net';
import type { ChildProcess } from 'node:child_process';

// Pure parts of the C48 load characterization harness (tests/loadCharacterize.ts).
// Unit tested in tests/loadCharacterize.unit.test.ts. Nothing here touches MongoDB or the network.

export const LOAD_SCOPE = 'local_disposable_services_only_not_production_capacity';
export const LOAD_REPORT_FILE = 'ci-load-characterization.json';
/** Points with fewer recorded samples than this are marked insufficient in the report. */
export const SUFFICIENT_SAMPLES = 200;
/** Synthetic session tokens, valid only in the generated disposable database. */
export const loadToken = (index: number) => `atomic-load-session-${index}`;

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);
export const isLoopbackHost = (host: string) => LOOPBACK_HOSTS.has(host.toLowerCase());

/**
 * The only MongoDB this harness may use: a single loopback host with no credentials and no selected
 * database. Atlas (mongodb+srv), remote hosts, seed lists and credentials are refused. Returns a fresh
 * disposable database name that matches the client fixture cleanup guard.
 */
export function loadDatabase(uri: string | undefined, selectedDatabase?: string): string {
  if (selectedDatabase !== undefined) throw new Error('load_database_must_be_generated');
  let parsed: URL;
  try { parsed = new URL(uri ?? ''); } catch { throw new Error('load_requires_local_mongodb'); }
  const options = [...parsed.searchParams.keys()];
  if (parsed.protocol !== 'mongodb:' || !isLoopbackHost(parsed.hostname) || (uri ?? '').includes(',') ||
      !/^\d{1,5}$/.test(parsed.port) || Number(parsed.port) < 1 || Number(parsed.port) > 65535 ||
      parsed.username || parsed.password || (parsed.pathname !== '' && parsed.pathname !== '/') || parsed.hash ||
      !options.every((key) => key === 'replicaSet' || key === 'directConnection')) {
    throw new Error('load_requires_local_mongodb');
  }
  return `atomic_test_${randomUUID().replaceAll('-', '').slice(0, 20)}`;
}

/** The stand-in Google origin must be plain HTTP on a loopback address. Real Google hosts are refused. */
export function assertLoopbackOrigin(origin: string): string {
  let parsed: URL;
  try { parsed = new URL(origin); } catch { throw new Error('load_requires_loopback_google_fixture'); }
  if (parsed.protocol !== 'http:' || !isLoopbackHost(parsed.hostname) || !parsed.port || parsed.pathname !== '/' ||
      parsed.search || parsed.username || parsed.password) {
    throw new Error('load_requires_loopback_google_fixture');
  }
  return parsed.origin;
}

/** Host of a net.Socket#connect call, or null for a local IPC path. Mirrors Node's argument forms. */
export function connectTarget(args: unknown[]): string | null {
  const first = Array.isArray(args[0]) ? args[0][0] : args[0];
  if (first && typeof first === 'object') {
    const options = first as { host?: unknown; path?: unknown };
    if (typeof options.path === 'string' && options.path) return null;
    return typeof options.host === 'string' && options.host ? options.host : 'localhost';
  }
  if (typeof first === 'number' || (typeof first === 'string' && /^\d+$/.test(first))) {
    return typeof args[1] === 'string' && args[1] ? args[1] : 'localhost';
  }
  return typeof first === 'string' && first ? null : 'localhost';
}

/** Process-wide guard: every TCP connection this process opens must go to a loopback address. */
export function installLoopbackOnlyNetwork(): void {
  const proto = net.Socket.prototype as unknown as { connect: (...args: unknown[]) => unknown; __loadGuard?: true };
  if (proto.__loadGuard) return;
  const original = proto.connect;
  proto.connect = function guardedConnect(this: unknown, ...args: unknown[]) {
    const host = connectTarget(args);
    if (host !== null && !isLoopbackHost(host)) throw new Error('load_non_loopback_connection_refused');
    return original.apply(this, args);
  };
  proto.__loadGuard = true;
}

/** Nearest-rank percentile of an unsorted sample. */
export function percentile(values: readonly number[], p: number): number {
  if (!values.length) return 0;
  if (!(p > 0 && p <= 1)) throw new RangeError('percentile_out_of_range');
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length, Math.max(1, Math.ceil(sorted.length * p))) - 1];
}

const round = (value: number, places = 2) => Math.round(value * 10 ** places) / 10 ** places;
export const mb = (bytes: number) => round(bytes / (1024 * 1024), 1);

export function latencySummary(values: readonly number[]) {
  return {
    min: round(values.length ? Math.min(...values) : 0), mean: round(values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0),
    p50: round(percentile(values, 0.5)), p90: round(percentile(values, 0.9)), p99: round(percentile(values, 0.99)),
    max: round(values.length ? Math.max(...values) : 0),
  };
}

const CODE = /^[a-z][a-z0-9_]{0,79}$/;
/** An error or reason code as recorded in the report. Anything that is not a short snake_case code is `other`. */
export const codeOf = (value: unknown) => typeof value === 'string' && CODE.test(value) ? value : 'other';

/** Throws unless every key and string value is a snake_case code and every number is finite. */
export function assertNumbersAndCodesOnly(value: unknown, path = 'report'): void {
  if (typeof value === 'number') { if (!Number.isFinite(value)) throw new Error(`load_report_non_finite:${path}`); return; }
  if (typeof value === 'string') { if (!CODE.test(value)) throw new Error(`load_report_free_text:${path}`); return; }
  if (Array.isArray(value)) { value.forEach((item, i) => assertNumbersAndCodesOnly(item, `${path}.${i}`)); return; }
  if (value && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) {
      if (!CODE.test(key)) throw new Error(`load_report_free_text_key:${path}`);
      assertNumbersAndCodesOnly(item, `${path}.${key}`);
    }
    return;
  }
  throw new Error(`load_report_unsupported_value:${path}`);
}

/** One completed request, timed by the load client in milliseconds since the scenario started. */
export type Sample = { start: number; end: number; ok: boolean };

export type SweepPoint = { concurrency: number; throughputRps: number; p99Ms: number; errorRate: number };

/**
 * The first tested concurrency at which adding in-flight requests stops paying: throughput grows by less
 * than 10% over the previous level, or more than 1% of requests fail. 0 when no tested level saturates.
 */
export function saturation(points: readonly SweepPoint[]) {
  const sorted = [...points].sort((a, b) => a.concurrency - b.concurrency);
  for (let i = 0; i < sorted.length; i++) {
    const point = sorted[i];
    if (point.errorRate > 0.01) return { concurrency: point.concurrency, reason: 'error_rate_above_1_percent' };
    if (i > 0 && point.throughputRps < sorted[i - 1].throughputRps * 1.1) {
      return { concurrency: point.concurrency, reason: 'throughput_gain_below_10_percent',
        p99_ratio_vs_lowest: round(point.p99Ms / Math.max(sorted[0].p99Ms, 0.001)) };
    }
  }
  return { concurrency: 0, reason: 'not_reached_within_tested_levels' };
}

/**
 * How a provider fault window disturbed the load and how long the App Server took to settle after it.
 * A request is disturbed when it failed or took longer than twice the pre-fault p99 (at least +50 ms).
 * recovery_ms is from the end of the fault window to the end of the last disturbed request (0 if none).
 */
export function recovery(samples: readonly (Sample & { latency: number })[], faultStart: number, faultEnd: number,
  observation = { graceMs: 4000, windowMs: 2000, minSamples: 20 }) {
  const before = samples.filter((s) => s.end <= faultStart);
  const baselineP99 = percentile(before.map((s) => s.latency), 0.99);
  const threshold = Math.max(baselineP99 * 2, baselineP99 + 50);
  const disturbed = samples.filter((s) => s.end > faultStart && (!s.ok || s.latency > threshold));
  const failed = samples.filter((s) => !s.ok);
  const lastDisturbedEnd = disturbed.reduce((max, s) => Math.max(max, s.end), faultEnd);
  // Pick the observation before looking at results. The last failure must not move
  // the window forward and thereby remove itself from the qualification sample.
  const observationStart = faultEnd + observation.graceMs;
  const observationEnd = observationStart + observation.windowMs;
  const settled = samples.filter((s) => s.start >= observationStart && s.start < observationEnd);
  const complete = samples.some((s) => s.end >= observationEnd);
  const settledFailed = settled.filter((s) => !s.ok).length;
  return {
    fault_window_ms: round(faultEnd - faultStart, 0),
    pre_fault_samples: before.length,
    pre_fault_p99_ms: round(baselineP99),
    disturbed_threshold_ms: round(threshold),
    disturbed_samples: disturbed.length,
    failed_samples: failed.length,
    first_failure_after_fault_start_ms: failed.length ? round(Math.min(...failed.map((s) => s.end)) - faultStart, 0) : -1,
    recovery_ms: round(Math.max(0, lastDisturbedEnd - faultEnd), 0),
    observation_start_ms: round(observationStart, 0),
    observation_end_ms: round(observationEnd, 0),
    observation_complete: complete ? 1 : 0,
    minimum_settled_samples: observation.minSamples,
    settled_samples: settled.length,
    settled_p50_ms: round(percentile(settled.map((s) => s.latency), 0.5)),
    settled_p99_ms: round(percentile(settled.map((s) => s.latency), 0.99)),
    settled_failed: settledFailed,
    qualified: complete && before.length > 0 && settled.length >= observation.minSamples && settledFailed === 0 ? 1 : 0,
  };
}

/** Cleanup must explicitly confirm success. Lost helpers or a stuck close fail closed. */
export async function confirmCleanup(close: () => Promise<unknown>, timeoutMs = 10000): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const reply = await Promise.race([
      close(),
      new Promise<undefined>((resolve) => { timer = setTimeout(() => resolve(undefined), timeoutMs); }),
    ]);
    return typeof reply === 'object' && reply !== null && (reply as { ok?: unknown }).ok === true;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/** Parses `drive;dur=…;desc="N calls"` from the notes route's Server-Timing header. */
export function driveCallsOf(serverTiming: string | null): number {
  const match = serverTiming?.match(/drive;dur=\d+;desc="(\d+) calls"/);
  return match ? Number(match[1]) : 0;
}

/** Request/response over IPC with a forked helper process. Replies carry the request's id. */
export function ipcClient(child: ChildProcess) {
  let next = 0;
  const pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  child.on('message', (message: { id?: unknown }) => {
    if (typeof message?.id !== 'number') return;
    pending.get(message.id)?.resolve(message);
    pending.delete(message.id);
  });
  child.on('exit', () => {
    for (const waiter of pending.values()) waiter.reject(new Error('load_helper_exited'));
    pending.clear();
  });
  return {
    call<T>(message: Record<string, unknown>): Promise<T> {
      const id = ++next;
      return new Promise<T>((resolve, reject) => {
        pending.set(id, { resolve: resolve as (value: unknown) => void, reject });
        child.send({ ...message, id }, (error) => { if (error) { pending.delete(id); reject(error); } });
      });
    },
  };
}

/** Byte counters for every socket a server ever accepted, including closed ones. */
export function socketMeter(server: net.Server) {
  const open = new Set<net.Socket>();
  let closedIn = 0, closedOut = 0;
  server.on('connection', (socket: net.Socket) => {
    open.add(socket);
    socket.once('close', () => { closedIn += socket.bytesRead; closedOut += socket.bytesWritten; open.delete(socket); });
  });
  return () => {
    let bytesIn = closedIn, bytesOut = closedOut;
    for (const socket of open) { bytesIn += socket.bytesRead; bytesOut += socket.bytesWritten; }
    return { bytesIn, bytesOut };
  };
}
