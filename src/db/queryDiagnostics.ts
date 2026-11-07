import type { CommandStartedEvent, Db, Document, Filter, Sort } from 'mongodb';
import { MAX_ACTIVE_SESSIONS } from '../lib/session.js';
import { FEED_LIMIT } from '../lib/notificationFeed.js';

// C25: read-only query/explain/index diagnostics. Every query shape below is a
// copy of a production call site (file:line in `source`). This module never
// creates, changes or drops an index or document; the only writes in this
// feature live in queryDiagnosticsFixture.ts and are restricted to a database
// that the fixture generated itself.

/** Diagnostics read heterogeneous collections whose _id is a string, not an ObjectId. */
export type AnyDoc = { _id: string; [field: string]: unknown };
export type Workload = 'hot' | 'admin' | 'maintenance' | 'inactive';
export type Bound =
  | { kind: 'point'; n: number }
  | { kind: 'page'; limit: number; skip?: number }
  | { kind: 'filtered' }
  | { kind: 'owner' }
  | { kind: 'global' };
export type Shape =
  | { kind: 'find'; filter: Filter<AnyDoc>; sort?: Sort; limit?: number; skip?: number; projection?: Document }
  | { kind: 'count'; filter: Filter<AnyDoc> }
  | { kind: 'distinct'; key: string; filter: Filter<AnyDoc> };

export type ProbeContext = {
  userId: string; asOf: Date; sessionHash: string | null; email: string | null; userCreatedAt: Date | null;
  upper: number; after: number | null; noteIds: string[]; operationIds: string[];
  coinCursor: { at: Date; id: string } | null; coinOperationId: string | null;
  logoutAttempt: { id: string; sessionHash: string } | null;
  notificationCursor: { at: Date; id: string } | null; recipientOf: string[];
};

export type QuerySpec = {
  id: string; collection: string; source: string; workload: Workload; bound: Bound;
  shape: (p: ProbeContext) => Shape | null;
};

const DAY = 24 * 60 * 60 * 1000;
// Not exported by the route module, which also opens the shared client on import. Keep in step with it.
export const PULL_PAGE = 10; // src/routes/notes.ts:44

const pullFilter = (p: ProbeContext, extra: Document = {}, after: number | null = null): Filter<AnyDoc> =>
  ({ userId: p.userId, syncSequence: { ...(after !== null ? { $gt: after } : {}), $lte: p.upper }, ...extra });
const reachFilter = (p: ProbeContext): Filter<AnyDoc> => ({
  status: 'active',
  $and: [
    { $or: [{ expiresAt: null }, { expiresAt: { $gt: p.asOf } }] },
    { $or: [
      { targetUserId: p.userId },
      { targetUserId: null, targetAudience: { $in: ['all', null] } },
      { _id: { $in: p.recipientOf } },
      ...(p.userCreatedAt ? [{ targetUserId: null, targetAudience: 'new', createdAt: { $lte: p.userCreatedAt } }] : []),
    ] },
  ],
});

/** Hot and supporting query inventory. Shapes mirror the cited source lines exactly. */
export const querySpecs: readonly QuerySpec[] = [
  { id: 'auth.verifySession', collection: 'sessions', source: 'src/lib/session.ts:47 (requireAuth, every request)',
    workload: 'hot', bound: { kind: 'point', n: 1 },
    shape: p => p.sessionHash ? { kind: 'find', filter: { _id: p.sessionHash }, limit: 1 } : null },
  { id: 'sessions.liveCurrent', collection: 'sessions', source: 'src/lib/sessionManagement.ts:41',
    workload: 'hot', bound: { kind: 'point', n: 1 },
    shape: p => p.sessionHash ? { kind: 'find', filter: { _id: p.sessionHash, userId: p.userId, revoked: false,
      expiresAt: { $gt: p.asOf } }, limit: 1 } : null },
  { id: 'sessions.inventory', collection: 'sessions', source: 'src/lib/sessionManagement.ts:49',
    workload: 'hot', bound: { kind: 'owner' },
    shape: p => ({ kind: 'find', filter: { userId: p.userId, revoked: false, expiresAt: { $gt: p.asOf } },
      projection: { _id: 1, userId: 1, createdAt: 1, expiresAt: 1, revoked: 1, userAgent: 1, logoutAttemptId: 1,
        logoutAttemptRevision: 1 }, sort: { createdAt: -1, _id: -1 }, limit: MAX_ACTIVE_SESSIONS + 1 }) },
  { id: 'sessions.limitActive', collection: 'sessions', source: 'src/lib/session.ts:40 (every sign-in)',
    workload: 'hot', bound: { kind: 'owner' },
    shape: p => ({ kind: 'find', filter: { userId: p.userId, revoked: false }, projection: { _id: 1 },
      sort: { createdAt: -1 }, skip: MAX_ACTIVE_SESSIONS }) },
  { id: 'logout.attemptById', collection: 'logout_attempts', source: 'src/lib/logoutAttempt.ts:42',
    workload: 'hot', bound: { kind: 'point', n: 1 },
    shape: p => p.logoutAttempt ? { kind: 'find', filter: { _id: p.logoutAttempt.id, userId: p.userId,
      sessionHash: p.logoutAttempt.sessionHash }, limit: 1 } : null },
  { id: 'notes.list', collection: 'notes', source: 'src/routes/notes.ts:191 (GET /notes)',
    workload: 'hot', bound: { kind: 'filtered' },
    shape: p => ({ kind: 'find', filter: { userId: p.userId, deleted: false } }) },
  { id: 'notes.count', collection: 'notes', source: 'src/routes/notes.ts:198,286; recoveryWireAdapter.ts:51',
    workload: 'hot', bound: { kind: 'filtered' },
    shape: p => ({ kind: 'count', filter: { userId: p.userId, deleted: false } }) },
  { id: 'notes.byIdOwner', collection: 'notes', source: 'src/routes/notes.ts:206',
    workload: 'hot', bound: { kind: 'point', n: 1 },
    shape: p => p.noteIds.length ? { kind: 'find', filter: { _id: p.noteIds[0], userId: p.userId }, limit: 1 } : null },
  { id: 'notes.pushLookup', collection: 'notes', source: 'src/routes/notes.ts:272 (POST /notes/push batch)',
    workload: 'hot', bound: { kind: 'point', n: 10 },
    shape: p => p.noteIds.length ? { kind: 'find', filter: { _id: { $in: p.noteIds } } } : null },
  { id: 'notes.pullCounter', collection: 'sync_counters', source: 'src/routes/notes.ts:507',
    workload: 'hot', bound: { kind: 'point', n: 1 },
    shape: p => ({ kind: 'find', filter: { _id: p.userId }, limit: 1 }) },
  { id: 'notes.pull.first', collection: 'notes', source: 'src/routes/notes.ts:516 (GET /notes/pull, after omitted)',
    workload: 'hot', bound: { kind: 'page', limit: PULL_PAGE + 1 },
    shape: p => p.upper ? { kind: 'find', filter: pullFilter(p), sort: { syncSequence: 1, _id: 1 }, limit: PULL_PAGE + 1 } : null },
  { id: 'notes.pull.next', collection: 'notes', source: 'src/routes/notes.ts:516 (GET /notes/pull?after=)',
    workload: 'hot', bound: { kind: 'page', limit: PULL_PAGE + 1 },
    shape: p => p.after !== null ? { kind: 'find', filter: pullFilter(p, {}, p.after), sort: { syncSequence: 1, _id: 1 },
      limit: PULL_PAGE + 1 } : null },
  { id: 'notes.pull.since', collection: 'notes', source: 'src/routes/notes.ts:513 (legacy since= without after)',
    workload: 'hot', bound: { kind: 'filtered' },
    shape: p => p.upper ? { kind: 'find', filter: pullFilter(p, { updatedAt: { $gte: new Date(p.asOf.getTime() - 7 * DAY) } }),
      sort: { syncSequence: 1, _id: 1 }, limit: PULL_PAGE + 1 } : null },
  { id: 'notes.pull.encOnly', collection: 'notes', source: 'src/routes/notes.ts:514 (encOnly=true)',
    workload: 'maintenance', bound: { kind: 'owner' },
    shape: p => p.upper ? { kind: 'find', filter: pullFilter(p, { encV: 0 }), sort: { syncSequence: 1, _id: 1 },
      limit: PULL_PAGE + 1 } : null },
  { id: 'notes.wipeScan', collection: 'notes', source: 'src/routes/notes.ts:573 (DELETE /notes)',
    workload: 'maintenance', bound: { kind: 'owner' },
    shape: p => ({ kind: 'find', filter: { userId: p.userId } }) },
  { id: 'sync.findOperation', collection: 'sync_operations', source: 'src/lib/syncOperation.ts:40',
    workload: 'hot', bound: { kind: 'point', n: 1 },
    shape: p => p.operationIds.length ? { kind: 'find', filter: { _id: p.operationIds[0] }, limit: 1 } : null },
  { id: 'sync.pendingExists', collection: 'sync_operations', source: 'src/lib/logoutAttempt.ts:61; recoveryAdmission.ts:57',
    workload: 'hot', bound: { kind: 'point', n: 1 },
    shape: p => ({ kind: 'find', filter: { userId: p.userId, status: 'pending' }, limit: 1 }) },
  { id: 'sync.pendingList', collection: 'sync_operations', source: 'src/lib/syncOperation.ts:115',
    workload: 'hot', bound: { kind: 'filtered' },
    shape: p => ({ kind: 'find', filter: { userId: p.userId, status: 'pending' } }) },
  { id: 'logout.receipts', collection: 'sync_operations', source: 'src/lib/logoutRecovery.ts:93',
    workload: 'hot', bound: { kind: 'point', n: 10 },
    shape: p => p.operationIds.length ? { kind: 'find', filter: { userId: p.userId, _id: { $in: p.operationIds } } } : null },
  { id: 'ledger.historyLegacy', collection: 'energy_ledger', source: 'src/lib/energy.ts:329 (unmarked wallet)',
    workload: 'hot', bound: { kind: 'page', limit: 50 },
    shape: p => ({ kind: 'find', filter: { userId: p.userId }, sort: { createdAt: -1, _id: -1 }, limit: 50 }) },
  { id: 'ledger.historySequenced', collection: 'energy_ledger', source: 'src/lib/energy.ts:329 (historyRetentionVersion 1)',
    workload: 'hot', bound: { kind: 'page', limit: 52 },
    shape: p => ({ kind: 'find', filter: { userId: p.userId }, sort: { historySequence: -1 }, limit: 52 }) },
  { id: 'ledger.appendWindow', collection: 'energy_ledger', source: 'src/lib/ledger.ts:20',
    workload: 'hot', bound: { kind: 'page', limit: 52 },
    shape: p => ({ kind: 'find', filter: { userId: p.userId }, limit: 52 }) },
  { id: 'ledger.retentionBatch', collection: 'energy_ledger', source: 'src/lib/ledgerRetention.ts:27',
    workload: 'maintenance', bound: { kind: 'page', limit: 100, skip: 50 },
    shape: p => ({ kind: 'find', filter: { userId: p.userId }, sort: { createdAt: -1, _id: -1 }, skip: 50, limit: 100 }) },
  { id: 'coins.dueLots', collection: 'coin_lots', source: 'src/lib/coinLots.ts:34 (expiry policy not activated)',
    workload: 'inactive', bound: { kind: 'filtered' },
    shape: p => ({ kind: 'find', filter: { userId: p.userId, remaining: { $gt: 0 }, expiresAt: { $ne: null, $lte: p.asOf } },
      sort: { expiresAt: 1, _id: 1 } }) },
  { id: 'coins.activeLots', collection: 'coin_lots', source: 'src/lib/coinLots.ts:57,135',
    workload: 'inactive', bound: { kind: 'filtered' },
    shape: p => ({ kind: 'find', filter: { userId: p.userId, remaining: { $gt: 0 } } }) },
  { id: 'coins.detailsFirst', collection: 'coin_lots', source: 'src/lib/coinLots.ts:132',
    workload: 'inactive', bound: { kind: 'page', limit: 51 },
    shape: p => ({ kind: 'find', filter: { userId: p.userId }, sort: { creditedAt: -1, _id: -1 }, limit: 51 }) },
  { id: 'coins.detailsNext', collection: 'coin_lots', source: 'src/lib/coinLots.ts:132 (before cursor)',
    workload: 'inactive', bound: { kind: 'page', limit: 51 },
    shape: p => p.coinCursor ? { kind: 'find', filter: { userId: p.userId, $or: [
      { creditedAt: { $lt: p.coinCursor.at } }, { creditedAt: p.coinCursor.at, _id: { $lt: p.coinCursor.id } },
    ] }, sort: { creditedAt: -1, _id: -1 }, limit: 51 } : null },
  { id: 'coins.operation', collection: 'coin_operations', source: 'src/lib/coinLots.ts:88',
    workload: 'inactive', bound: { kind: 'point', n: 1 },
    shape: p => p.coinOperationId ? { kind: 'find', filter: { _id: p.coinOperationId }, limit: 1 } : null },
  { id: 'feed.ordinary', collection: 'notifications', source: 'src/lib/notificationFeed.ts:93 (App feed)',
    workload: 'hot', bound: { kind: 'global' },
    shape: p => ({ kind: 'find', filter: { ...reachFilter(p), dismissible: { $ne: false } }, sort: { createdAt: -1 },
      limit: FEED_LIMIT * 2 }) },
  { id: 'feed.recipientOf', collection: 'notification_recipients', source: 'src/lib/notificationFeed.ts:59',
    workload: 'hot', bound: { kind: 'filtered' },
    shape: p => ({ kind: 'distinct', key: 'notificationId', filter: { userId: p.userId } }) },
  { id: 'admin.notificationsNext', collection: 'notifications', source: 'src/routes/admin.ts:265 (cursor page)',
    workload: 'admin', bound: { kind: 'page', limit: 51 },
    shape: p => p.notificationCursor ? { kind: 'find', filter: { $or: [
      { createdAt: { $lt: p.notificationCursor.at } }, { createdAt: p.notificationCursor.at, _id: { $lt: p.notificationCursor.id } },
    ] }, sort: { createdAt: -1, _id: -1 }, limit: 51 } : null },
  { id: 'admin.lastSession', collection: 'sessions', source: 'src/routes/admin.ts:64',
    workload: 'admin', bound: { kind: 'page', limit: 1 },
    shape: p => ({ kind: 'find', filter: { userId: p.userId }, sort: { createdAt: -1 }, limit: 1 }) },
  { id: 'admin.userByEmail', collection: 'users', source: 'src/routes/admin.ts:58 (case-insensitive exact)',
    workload: 'admin', bound: { kind: 'global' },
    shape: p => p.email ? { kind: 'find', filter: { email: { $regex: `^${p.email.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`,
      $options: 'i' } }, limit: 1 } : null },
  { id: 'admin.statsActiveNotes', collection: 'notes', source: 'src/lib/adminStats.ts:34',
    workload: 'admin', bound: { kind: 'global' },
    shape: () => ({ kind: 'count', filter: { deleted: false } }) },
  { id: 'admin.statsActive24h', collection: 'atomic_users', source: 'src/lib/adminStats.ts:32',
    workload: 'admin', bound: { kind: 'global' },
    shape: p => ({ kind: 'count', filter: { lastDailyGrantAt: { $gte: new Date(p.asOf.getTime() - DAY) } } }) },
  { id: 'admin.recentSessionOwners', collection: 'sessions', source: 'src/lib/notificationFeed.ts:21 (publish audience)',
    workload: 'admin', bound: { kind: 'global' },
    shape: p => ({ kind: 'distinct', key: 'userId', filter: { createdAt: { $gte: new Date(p.asOf.getTime() - 30 * DAY) } } }) },
];

// ---------------------------------------------------------------------------
// Pure explain summarisation and classification (unit tested without Mongo)
// ---------------------------------------------------------------------------
export type ExplainSummary = { stages: string[]; indexes: string[]; nReturned: number; keysExamined: number; docsExamined: number };
const INDEX_STAGES = new Set(['IXSCAN', 'COUNT_SCAN', 'IDHACK', 'EXPRESS_IXSCAN', 'EXPRESS_IDHACK',
  'EXPRESS_CLUSTERED_IXSCAN', 'DISTINCT_SCAN', 'CLUSTERED_IXSCAN']);

function firstKey(value: unknown, key: string): Record<string, unknown> | null {
  if (!value || typeof value !== 'object') return null;
  if (Array.isArray(value)) {
    for (const item of value) { const found = firstKey(item, key); if (found) return found; }
    return null;
  }
  const object = value as Record<string, unknown>;
  if (object[key] && typeof object[key] === 'object') return object[key] as Record<string, unknown>;
  for (const child of Object.values(object)) { const found = firstKey(child, key); if (found) return found; }
  return null;
}
function collect(value: unknown, key: string, into: Set<string>): Set<string> {
  if (!value || typeof value !== 'object') return into;
  if (Array.isArray(value)) { for (const item of value) collect(item, key, into); return into; }
  const object = value as Record<string, unknown>;
  if (typeof object[key] === 'string') into.add(object[key] as string);
  for (const child of Object.values(object)) collect(child, key, into);
  return into;
}
const integer = (value: unknown) => typeof value === 'number' && Number.isFinite(value) ? value : 0;

/** Works for classic and slot-based (SBE) find/aggregate/distinct explain output. */
export function summarizeExplain(explain: unknown): ExplainSummary {
  const planner = firstKey(explain, 'queryPlanner');
  const winning = planner ? (planner.winningPlan ?? null) : null;
  const stats = firstKey(explain, 'executionStats');
  if (!winning || !stats) throw new Error('explain_shape_unrecognised');
  // SBE nests the classic tree under winningPlan.queryPlan; slotBasedPlan has no `stage` keys.
  const tree = (winning as Record<string, unknown>).queryPlan ?? winning;
  return {
    stages: [...collect(tree, 'stage', new Set())].sort(),
    indexes: [...collect(tree, 'indexName', new Set())].sort(),
    nReturned: integer(stats.nReturned), keysExamined: integer(stats.totalKeysExamined),
    docsExamined: integer(stats.totalDocsExamined),
  };
}

export type Severity = 'info' | 'warn' | 'problem';
export type Flag = { code: 'COLLSCAN' | 'BLOCKING_SORT' | 'EXAMINED_EXCEEDS_BOUND' | 'RESULT_UNPAGINATED' | 'EMPTY_PLAN'; severity: Severity };
export type Verdict = 'ok' | 'warn' | 'problem';

/** Maximum documents the bound permits. Keys may read one entry past the end of each scanned range. */
export function examinedBudget(bound: Bound, counts: { owner: number; filtered: number }): number {
  switch (bound.kind) {
    case 'point': return bound.n;
    case 'page': return bound.limit + (bound.skip ?? 0);
    case 'filtered': return counts.filtered;
    case 'owner': return counts.owner;
    case 'global': return Number.POSITIVE_INFINITY;
  }
}

export function classify(spec: Pick<QuerySpec, 'workload' | 'bound'> & { limited: boolean }, summary: ExplainSummary,
  counts: { owner: number; filtered: number }): { flags: Flag[]; verdict: Verdict } {
  const flags: Flag[] = [];
  const serious: Severity = spec.workload === 'hot' ? 'problem' : 'warn';
  if (summary.stages.includes('COLLSCAN')) flags.push({ code: 'COLLSCAN', severity: serious });
  if (summary.stages.includes('SORT')) flags.push({ code: 'BLOCKING_SORT', severity: 'info' });
  const budget = examinedBudget(spec.bound, counts);
  // Index scans may read one key past each scanned interval (one per $in point, two for $or branches).
  const keySlack = spec.bound.kind === 'point' ? spec.bound.n + 1 : 2;
  if (summary.docsExamined > budget || summary.keysExamined > budget + keySlack) {
    flags.push({ code: 'EXAMINED_EXCEEDS_BOUND', severity: serious });
  }
  if (!spec.limited && (spec.bound.kind === 'filtered' || spec.bound.kind === 'owner') && spec.workload === 'hot') {
    flags.push({ code: 'RESULT_UNPAGINATED', severity: 'info' });
  }
  if (summary.stages.length === 1 && summary.stages[0] === 'EOF') flags.push({ code: 'EMPTY_PLAN', severity: 'info' });
  const verdict: Verdict = flags.some(f => f.severity === 'problem') ? 'problem'
    : flags.some(f => f.severity === 'warn') ? 'warn' : 'ok';
  return { flags, verdict };
}
export const usesIndex = (summary: ExplainSummary) => summary.stages.some(stage => INDEX_STAGES.has(stage));

/** Field/operator outline of a filter. Values are never included. */
export function describeFilter(filter: unknown): string {
  if (!filter || typeof filter !== 'object' || Array.isArray(filter)) return 'eq';
  const parts = Object.entries(filter as Record<string, unknown>).map(([key, value]) => {
    if (key === '$or' || key === '$and') {
      return `${key}[${(Array.isArray(value) ? value : []).map(describeFilter).join(' | ')}]`;
    }
    if (value && typeof value === 'object' && !Array.isArray(value) && !(value instanceof Date)) {
      const operators = Object.keys(value as Record<string, unknown>);
      if (operators.length && operators.every(op => op.startsWith('$'))) {
        return `${key}:${operators.map(op => op === '$in' && Array.isArray((value as Record<string, unknown>)[op])
          ? `$in[${((value as Record<string, unknown>)[op] as unknown[]).length}]` : op).join(',')}`;
      }
    }
    return `${key}:eq`;
  });
  return `{${parts.join(', ')}}`;
}
const describeSort = (sort: Sort | undefined) => sort ? Object.entries(sort as Record<string, number>)
  .map(([key, direction]) => `${key}:${direction}`).join(',') : null;

const FORBIDDEN = [
  /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i, // user, note and ledger ids
  /[0-9a-f]{24,}/i, // session hashes, fingerprints, ObjectIds
  /@/, // email addresses and URI credentials
  /mongodb(\+srv)?:/i,
  /synthetic-/i, // fixture driveFileIds and emails
];
/** Throws if a report could carry an identifier, email, token hash or connection string. */
export function assertSanitized(report: unknown): void {
  const text = JSON.stringify(report);
  for (const pattern of FORBIDDEN) if (pattern.test(text)) throw new Error('diagnostics_report_not_sanitized');
}

// ---------------------------------------------------------------------------
// Connection and command safety guards (pure; unit tested)
// ---------------------------------------------------------------------------
export type Mode = { mode: 'seed-disposable'; withCandidates: boolean } | { mode: 'read-only'; database: string; maxPages: number };

export function explainArguments(args: readonly string[]): Mode {
  const usage = new Error('usage: db:explain -- --seed-disposable [--with-candidates] | --read-only --database <name> [--max-pages <1-200>]');
  const rest = [...args];
  if (rest[0] === '--seed-disposable') {
    if (rest.length === 1) return { mode: 'seed-disposable', withCandidates: false };
    if (rest.length === 2 && rest[1] === '--with-candidates') return { mode: 'seed-disposable', withCandidates: true };
    throw usage;
  }
  if (rest[0] === '--read-only' && rest[1] === '--database' && rest[2] && /^[A-Za-z0-9_-]{1,63}$/.test(rest[2])) {
    if (rest.length === 3) return { mode: 'read-only', database: rest[2], maxPages: 30 };
    if (rest.length === 5 && rest[3] === '--max-pages' && /^\d{1,3}$/.test(rest[4]) && +rest[4] >= 1 && +rest[4] <= 200) {
      return { mode: 'read-only', database: rest[2], maxPages: +rest[4] };
    }
  }
  throw usage;
}

const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);
/** Host names from a mongodb:// or mongodb+srv:// string, without credentials. */
export function uriHosts(uri: string): { scheme: 'mongodb' | 'mongodb+srv'; hosts: string[] } {
  const match = /^(mongodb(?:\+srv)?):\/\/([^/?#]*)/i.exec(uri.trim());
  if (!match) throw new Error('explain_uri_invalid');
  const authority = match[2].slice(match[2].lastIndexOf('@') + 1);
  const hosts = authority.split(',').map(entry => {
    const host = entry.startsWith('[') ? entry.slice(0, entry.indexOf(']') + 1) : entry.split(':')[0];
    return host.toLowerCase();
  });
  if (!hosts.length || hosts.some(host => !host)) throw new Error('explain_uri_invalid');
  return { scheme: match[1].toLowerCase() as 'mongodb' | 'mongodb+srv', hosts };
}

/** Seeding is local-only. Non-local hosts are allowed only in explicit read-only mode. */
export function assertUriAllowed(uri: string | undefined, mode: Mode['mode']): void {
  if (!uri) throw new Error('explain_uri_required');
  const { scheme, hosts } = uriHosts(uri);
  const local = scheme === 'mongodb' && hosts.every(host => LOCAL_HOSTS.has(host));
  if (mode === 'seed-disposable' && !local) throw new Error('explain_seed_requires_local_host');
}

export const DISPOSABLE_DATABASE = /^atomic_explain_[a-f0-9]{20}$/;
const ADMIN_READS = new Set(['hello', 'ismaster', 'isMaster', 'ping', 'buildInfo', 'buildinfo', 'endSessions',
  'saslStart', 'saslContinue', 'getParameter']);
const READS = new Set([...ADMIN_READS, 'find', 'aggregate', 'count', 'distinct', 'explain', 'listIndexes',
  'listCollections', 'getMore', 'killCursors']);
const READ_EXPLAINED = new Set(['find', 'aggregate', 'count', 'distinct']);
const writesPipeline = (pipeline: unknown) => Array.isArray(pipeline) &&
  pipeline.some(stage => stage && typeof stage === 'object' && ('$out' in stage || '$merge' in stage));

/** Returns a violation code for a command the current mode must never send, else null. */
export function commandViolation(event: Pick<CommandStartedEvent, 'commandName' | 'databaseName' | 'command'>,
  mode: 'read-only' | 'seed-disposable', allowedDatabase: string): string | null {
  const command = event.command as Document;
  if (mode === 'seed-disposable') {
    if (event.databaseName === allowedDatabase && DISPOSABLE_DATABASE.test(allowedDatabase)) return null;
    return ADMIN_READS.has(event.commandName) ? null : 'write_outside_disposable_database';
  }
  if (!READS.has(event.commandName)) return 'non_read_command';
  if (event.commandName === 'aggregate' && writesPipeline(command.pipeline)) return 'writing_pipeline';
  if (event.commandName === 'explain') {
    const inner = command.explain as Document | undefined;
    const name = inner ? Object.keys(inner)[0] : '';
    if (!READ_EXPLAINED.has(name) || writesPipeline(inner?.pipeline)) return 'non_read_explain';
  }
  if (!ADMIN_READS.has(event.commandName) && event.databaseName !== allowedDatabase) return 'read_outside_selected_database';
  return null;
}

// ---------------------------------------------------------------------------
// Runner (read-only against the given Db)
// ---------------------------------------------------------------------------
const MAX_TIME_MS = 15000;
// Keyed by _id (owner id) or global: there is no userId field to count.
const OWNERLESS = new Set(['notifications', 'sync_counters', 'users', 'atomic_users']);
export type QueryResult = {
  id: string; collection: string; source: string; workload: Workload; bound: string;
  filter: string; sort: string | null; limit: number | null; skip: number | null;
  skipped?: 'no_probe_data';
  stages?: string[]; indexes?: string[]; nReturned?: number; keysExamined?: number; docsExamined?: number;
  ownerRows?: number; matchingRows?: number; flags?: Flag['code'][]; verdict?: Verdict;
};
export type PaginationWalk = {
  query: 'notes.pull'; pages: number; rows: number; uniqueRows: number; expectedRows: number; truncated: boolean;
  maxReturnedPerPage: number; maxDocsExaminedPerPage: number; totalKeysExamined: number; totalDocsExamined: number;
};
const boundLabel = (bound: Bound) => bound.kind === 'point' ? `point(${bound.n})`
  : bound.kind === 'page' ? `page(${bound.limit}${bound.skip ? `+skip ${bound.skip}` : ''})` : bound.kind;

async function explainShape(db: Db, collection: string, shape: Shape): Promise<unknown> {
  const col = db.collection<AnyDoc>(collection);
  if (shape.kind === 'find') {
    let cursor = col.find(shape.filter, { projection: shape.projection, maxTimeMS: MAX_TIME_MS });
    if (shape.sort) cursor = cursor.sort(shape.sort);
    if (shape.skip) cursor = cursor.skip(shape.skip);
    if (shape.limit) cursor = cursor.limit(shape.limit);
    return cursor.explain('executionStats');
  }
  if (shape.kind === 'count') {
    // Same pipeline the driver builds for countDocuments().
    return col.aggregate([{ $match: shape.filter }, { $group: { _id: 1, n: { $sum: 1 } } }], { maxTimeMS: MAX_TIME_MS })
      .explain('executionStats');
  }
  return db.command({ explain: { distinct: collection, key: shape.key, query: shape.filter }, verbosity: 'executionStats',
    maxTimeMS: MAX_TIME_MS });
}

export async function runQuery(db: Db, spec: QuerySpec, probe: ProbeContext): Promise<QueryResult> {
  const shape = spec.shape(probe);
  const base = { id: spec.id, collection: spec.collection, source: spec.source, workload: spec.workload,
    bound: boundLabel(spec.bound), filter: shape ? describeFilter(shape.filter) : 'n/a',
    sort: shape?.kind === 'find' ? describeSort(shape.sort) : null,
    limit: shape?.kind === 'find' ? shape.limit ?? null : null, skip: shape?.kind === 'find' ? shape.skip ?? null : null };
  if (!shape) return { ...base, skipped: 'no_probe_data' };
  const summary = summarizeExplain(await explainShape(db, spec.collection, shape));
  const col = db.collection<AnyDoc>(spec.collection);
  const ownerRows = OWNERLESS.has(spec.collection) ? 0
    : await col.countDocuments({ userId: probe.userId }, { maxTimeMS: MAX_TIME_MS });
  const matchingRows = await col.countDocuments(shape.filter, { maxTimeMS: MAX_TIME_MS });
  const limited = shape.kind === 'find' && shape.limit !== undefined;
  const { flags, verdict } = classify({ workload: spec.workload, bound: spec.bound, limited }, summary,
    { owner: ownerRows, filtered: matchingRows });
  return { ...base, ...summary, ownerRows, matchingRows, flags: flags.map(f => f.code), verdict };
}

/** Follows the pull cursor exactly like the route (limit 11, keep 10, next = last syncSequence). */
export async function walkPull(db: Db, probe: ProbeContext, maxPages: number): Promise<PaginationWalk> {
  const notes = db.collection<AnyDoc>('notes');
  const seen = new Set<string>();
  let after: number | null = null, pages = 0, rows = 0, maxReturned = 0, maxDocs = 0, keys = 0, docs = 0, truncated = false;
  const expectedRows = probe.upper ? await notes.countDocuments(pullFilter(probe), { maxTimeMS: MAX_TIME_MS }) : 0;
  while (probe.upper && (after === null || after < probe.upper)) {
    if (pages >= maxPages) { truncated = true; break; }
    const filter = pullFilter(probe, {}, after);
    const page = await notes.find(filter, { projection: { _id: 1, syncSequence: 1 }, maxTimeMS: MAX_TIME_MS })
      .sort({ syncSequence: 1, _id: 1 }).limit(PULL_PAGE + 1).toArray();
    const summary = summarizeExplain(await notes.find(filter, { maxTimeMS: MAX_TIME_MS })
      .sort({ syncSequence: 1, _id: 1 }).limit(PULL_PAGE + 1).explain('executionStats'));
    pages++; keys += summary.keysExamined; docs += summary.docsExamined;
    maxDocs = Math.max(maxDocs, summary.docsExamined); maxReturned = Math.max(maxReturned, page.length);
    const kept = page.slice(0, PULL_PAGE);
    for (const row of kept) seen.add(String(row._id));
    rows += kept.length;
    if (page.length <= PULL_PAGE) break;
    after = Number(kept[kept.length - 1].syncSequence);
  }
  return { query: 'notes.pull', pages, rows, uniqueRows: seen.size, expectedRows, truncated,
    maxReturnedPerPage: maxReturned, maxDocsExaminedPerPage: maxDocs, totalKeysExamined: keys, totalDocsExamined: docs };
}

/** Parameters for one owner, gathered with reads only. Nothing here enters the report. */
export async function probeContext(db: Db, userId: string, asOf: Date): Promise<ProbeContext> {
  const opts = { maxTimeMS: MAX_TIME_MS };
  const [session, user, counter, notes, operations, coinPage, coinOperation, attempt, notificationPage, recipientOf] = await Promise.all([
    db.collection<AnyDoc>('sessions').find({ userId }, { ...opts, projection: { _id: 1 } }).sort({ createdAt: -1 }).limit(1).next(),
    db.collection<AnyDoc>('users').findOne({ _id: userId }, { ...opts, projection: { email: 1, createdAt: 1 } }),
    db.collection<AnyDoc>('sync_counters').findOne({ _id: userId }, opts),
    db.collection<AnyDoc>('notes').find({ userId }, { ...opts, projection: { _id: 1 } }).sort({ _id: 1 }).limit(10).toArray(),
    db.collection<AnyDoc>('sync_operations').find({ userId }, { ...opts, projection: { _id: 1 } }).sort({ _id: 1 }).limit(10).toArray(),
    db.collection<AnyDoc>('coin_lots').find({ userId }, { ...opts, projection: { _id: 1, creditedAt: 1 } })
      .sort({ creditedAt: -1, _id: -1 }).skip(49).limit(1).next(),
    db.collection<AnyDoc>('coin_operations').find({ userId }, { ...opts, projection: { _id: 1 } }).sort({ _id: 1 }).limit(1).next(),
    db.collection<AnyDoc>('logout_attempts').find({ userId }, { ...opts, projection: { _id: 1, sessionHash: 1 } }).sort({ _id: 1 }).limit(1).next(),
    db.collection<AnyDoc>('notifications').find({}, { ...opts, projection: { _id: 1, createdAt: 1 } })
      .sort({ createdAt: -1, _id: -1 }).skip(49).limit(1).next(),
    db.collection<AnyDoc>('notification_recipients').distinct('notificationId', { userId }, opts),
  ]);
  const upper = typeof counter?.value === 'number' ? counter.value : 0;
  const tenth = upper ? await db.collection<AnyDoc>('notes').find(pullFilter({ userId, upper } as ProbeContext), { ...opts,
    projection: { syncSequence: 1 } }).sort({ syncSequence: 1, _id: 1 }).skip(PULL_PAGE - 1).limit(1).next() : null;
  return {
    userId, asOf, sessionHash: session ? String(session._id) : null,
    email: typeof user?.email === 'string' ? user.email : null,
    userCreatedAt: user?.createdAt instanceof Date ? user.createdAt : null,
    upper, after: typeof tenth?.syncSequence === 'number' && tenth.syncSequence < upper ? tenth.syncSequence : null,
    noteIds: notes.map(n => String(n._id)), operationIds: operations.map(o => String(o._id)),
    coinCursor: coinPage?.creditedAt instanceof Date ? { at: coinPage.creditedAt, id: String(coinPage._id) } : null,
    coinOperationId: coinOperation ? String(coinOperation._id) : null,
    logoutAttempt: attempt && typeof attempt.sessionHash === 'string' ? { id: String(attempt._id), sessionHash: attempt.sessionHash } : null,
    notificationCursor: notificationPage?.createdAt instanceof Date
      ? { at: notificationPage.createdAt, id: String(notificationPage._id) } : null,
    recipientOf: recipientOf.map(String).sort(),
  };
}

/** Largest owner by note metadata rows (read-only aggregation, bounded by maxTimeMS). */
export async function largestNoteOwner(db: Db): Promise<string | null> {
  const [top] = await db.collection<AnyDoc>('notes').aggregate<{ _id: string }>([
    { $group: { _id: '$userId', n: { $sum: 1 } } }, { $sort: { n: -1, _id: 1 } }, { $limit: 1 },
  ], { maxTimeMS: MAX_TIME_MS, allowDiskUse: false }).toArray();
  return top ? String(top._id) : null;
}

const INDEXED_COLLECTIONS = ['notes', 'sessions', 'sync_operations', 'sync_counters', 'energy_ledger', 'coin_lots',
  'coin_operations', 'logout_attempts', 'notifications', 'notification_recipients', 'users', 'atomic_users'] as const;

/** Index key patterns per collection (names omitted except for generated defaults). Missing collections are not created. */
export async function declaredIndexes(db: Db): Promise<Record<string, string[]>> {
  const existing = new Set((await db.listCollections({}, { nameOnly: true }).toArray()).map(c => c.name));
  const result: Record<string, string[]> = {};
  for (const name of INDEXED_COLLECTIONS) {
    if (!existing.has(name)) { result[name] = []; continue; }
    result[name] = (await db.collection<AnyDoc>(name).indexes()).map(index => {
      const key = Object.entries(index.key).map(([field, direction]) => `${field}:${direction}`).join(',');
      const extra = [index.unique ? 'unique' : '', index.expireAfterSeconds !== undefined ? 'ttl' : '',
        index.partialFilterExpression ? 'partial' : '', index.hidden ? 'hidden' : ''].filter(Boolean);
      return extra.length ? `${key} (${extra.join(',')})` : key;
    }).sort();
  }
  return result;
}

export type ProbeReport = { label: string; ownerRows: Record<string, number>; queries: QueryResult[]; pagination: PaginationWalk };
export async function diagnoseProbe(db: Db, label: string, userId: string, asOf: Date, maxPages: number,
  only?: (spec: QuerySpec) => boolean): Promise<ProbeReport> {
  const probe = await probeContext(db, userId, asOf);
  const ownerRows: Record<string, number> = {};
  for (const name of ['notes', 'sessions', 'sync_operations', 'energy_ledger', 'coin_lots']) {
    ownerRows[name] = await db.collection<AnyDoc>(name).countDocuments({ userId }, { maxTimeMS: MAX_TIME_MS });
  }
  const queries: QueryResult[] = [];
  for (const spec of querySpecs) if (!only || only(spec)) queries.push(await runQuery(db, spec, probe));
  return { label, ownerRows, queries, pagination: await walkPull(db, probe, maxPages) };
}

export function summarize(probes: readonly ProbeReport[]) {
  const all = probes.flatMap(p => p.queries.map(q => ({ ...q, probe: p.label })));
  const ran = all.filter(q => !q.skipped);
  return {
    queries: all.length, skipped: all.length - ran.length,
    ok: ran.filter(q => q.verdict === 'ok').length, warn: ran.filter(q => q.verdict === 'warn').length,
    problem: ran.filter(q => q.verdict === 'problem').length,
    problemIds: [...new Set(ran.filter(q => q.verdict === 'problem').map(q => `${q.probe}:${q.id}`))].sort(),
    warnIds: [...new Set(ran.filter(q => q.verdict === 'warn').map(q => `${q.probe}:${q.id}`))].sort(),
  };
}
