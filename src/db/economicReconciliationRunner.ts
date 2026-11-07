import { MongoClient, type AbstractCursor, type ClientSession, type Db, type Document } from 'mongodb';
import {
  SYNC_REFUND_NOTE, Tally, reconcileOwner, summarizeInvariants, type InvariantId, type InvariantTally, type OwnerBundle,
} from './economicReconciliation.js';
import { monetaryTtlCounts } from './ledgerProvenanceInspection.js';
import { assertSanitized, assertUriAllowed, commandViolation } from './queryDiagnostics.js';

// C27 runner. Streams each monetary collection once, ordered by owner, and
// merge-joins them so that memory holds one owner's records at a time. Sends
// reads only; the guarded runner fails on any other command (C25 allowlist).

const MAX_TIME_MS = 120_000;
const BATCH = 200;
const OWNER_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type ReconciliationReport = {
  version: 1; tool: 'c27-economic-reconciliation'; mode: 'read-only' | 'in-process';
  database: 'operator-selected' | 'caller-selected'; scope: 'all-owners' | 'single-owner'; asOf: string;
  snapshot: boolean;
  population: { wallets: number; ownersWithoutWallet: number; ledgerRows: number; syncOperations: number;
    coinLots: number; coinReceipts: number; archivedOwners: number; malformedOwnerRows: number };
  catalog: { ledgerTtlIndexes: number; syncOperationTtlIndexes: number };
  invariants: Record<InvariantId, InvariantTally>;
  summary: ReturnType<typeof summarizeInvariants>;
};

type Stream = { name: keyof Omit<OwnerBundle, 'archived'> | 'archives'; key: '_id' | 'userId'; cursor: AbstractCursor<Document> };

function streams(db: Db, session: ClientSession | undefined, owner: string | undefined): Stream[] {
  const options = { session, batchSize: BATCH, maxTimeMS: MAX_TIME_MS, allowDiskUse: false };
  const byOwner = (key: '_id' | 'userId'): Document => ({ [key]: owner ?? { $type: 'string' } });
  const run = (collection: string, key: '_id' | 'userId', project: Document) => db.collection(collection).aggregate([
    { $match: byOwner(key) }, { $sort: { [key]: 1 } }, { $project: project }], options);
  return [
    { name: 'wallet', key: '_id', cursor: run('atomic_users', '_id',
      { coins: 1, energy: 1, coinLotsVersion: 1, coinPolicyActivatedAt: 1, historyRetentionVersion: 1 }) },
    // Note text stays on the server: only '' (string) or the non-string value, plus the refund-writer flag.
    { name: 'ledger', key: 'userId', cursor: run('energy_ledger', 'userId', {
      userId: 1, kind: 1, coinsDelta: 1, energyDelta: 1, resultingCoins: 1, resultingEnergy: 1, createdAt: 1,
      historySequence: 1, coinOperationId: 1, lotIds: 1, reason: 1,
      note: { $cond: [{ $eq: [{ $type: '$note' }, 'string'] }, '', '$note'] },
      syncRefund: { $eq: ['$note', SYNC_REFUND_NOTE] } }) },
    { name: 'operations', key: 'userId', cursor: run('sync_operations', 'userId', {
      userId: 1, mode: 1, rowIds: 1, charged: 1, refunded: 1, status: 1, createdAt: 1, 'results.id': 1, 'results.ok': 1,
      logoutTagged: { $ne: [{ $type: '$logoutAttemptId' }, 'missing'] } }) },
    { name: 'lots', key: 'userId', cursor: run('coin_lots', 'userId', { userId: 1, amount: 1, remaining: 1, expiresAt: 1 }) },
    { name: 'receipts', key: 'userId', cursor: run('coin_operations', 'userId', { userId: 1, allocations: 1, createdAt: 1 }) },
    // Retention keeps an archive document even when nothing was archived; only positive counts mean trimmed history.
    { name: 'archives', key: '_id', cursor: run('ledger_history_archives', '_id', { archivedRows: { $sum: {
      $map: { input: { $objectToArray: { $ifNull: ['$byKind', {}] } }, as: 'k',
        in: { $cond: [{ $isNumber: '$$k.v' }, '$$k.v', 0] } } } } }) },
  ];
}

type Head = { stream: Stream; current: Document | null; last: string | null };
async function advance(head: Head) {
  const next = await head.stream.cursor.next();
  if (next) {
    const key = String(next[head.stream.key]);
    // String owners sort by code unit in both MongoDB (simple collation) and here for the ASCII ids in use.
    if (head.last !== null && key < head.last) throw new Error('reconciliation_owner_order_violation');
    head.last = key;
  }
  head.current = next;
}

/** Read-only. With a snapshot session every stream reads the same point in time. */
export async function reconcileEconomy(db: Db, options: { asOf: Date; owner?: string; session?: ClientSession;
  samples?: number; mode?: ReconciliationReport['mode']; database?: ReconciliationReport['database'] }): Promise<ReconciliationReport> {
  if (options.owner !== undefined && !OWNER_ID.test(options.owner)) throw new Error('reconciliation_owner_invalid');
  if (!(options.asOf instanceof Date) || !Number.isFinite(options.asOf.getTime())) throw new Error('reconciliation_as_of_invalid');
  // Catalog reads never create a missing collection.
  const catalog = { ledgerTtlIndexes: 0, syncOperationTtlIndexes: 0 };
  for (const [name, field] of [['energy_ledger', 'ledgerTtlIndexes'], ['sync_operations', 'syncOperationTtlIndexes']] as const) {
    if (await db.listCollections({ name }, { nameOnly: true }).hasNext()) {
      catalog[field] = monetaryTtlCounts(name, await db.collection(name).indexes()).ttlIndexes;
    }
  }
  const session = options.session;
  // Records whose owner is not a string cannot be grouped by owner; counted globally (all-owners scope only).
  let malformedOwnerRows = 0;
  if (!options.owner) {
    for (const name of ['energy_ledger', 'sync_operations', 'coin_lots', 'coin_operations']) {
      malformedOwnerRows += await db.collection(name).countDocuments({ userId: { $not: { $type: 'string' } } }, { session, maxTimeMS: MAX_TIME_MS });
    }
    malformedOwnerRows += await db.collection('atomic_users')
      .countDocuments({ _id: { $not: { $type: 'string' } } } as Document, { session, maxTimeMS: MAX_TIME_MS });
  }
  const tally = new Tally(options.samples ?? 10);
  const population = { wallets: 0, ownersWithoutWallet: 0, ledgerRows: 0, syncOperations: 0, coinLots: 0, coinReceipts: 0,
    archivedOwners: 0, malformedOwnerRows };
  const heads: Head[] = streams(db, session, options.owner).map(stream => ({ stream, current: null, last: null }));
  try {
    for (const head of heads) await advance(head);
    const context = { asOf: options.asOf, ledgerMayExpire: catalog.ledgerTtlIndexes > 0 };
    for (;;) {
      const live = heads.filter(head => head.current);
      if (!live.length) break;
      const owner = live.map(head => String(head.current![head.stream.key])).sort()[0];
      const bundle: OwnerBundle = { wallet: null, ledger: [], operations: [], lots: [], receipts: [], archived: false };
      for (const head of live) {
        while (head.current && String(head.current[head.stream.key]) === owner) {
          const row = head.current;
          if (head.stream.name === 'wallet') bundle.wallet = row as OwnerBundle['wallet'];
          else if (head.stream.name === 'archives') bundle.archived = typeof row.archivedRows === 'number' && row.archivedRows > 0;
          else (bundle[head.stream.name] as Document[]).push(row);
          await advance(head);
        }
      }
      if (bundle.wallet) population.wallets++; else population.ownersWithoutWallet++;
      population.ledgerRows += bundle.ledger.length; population.syncOperations += bundle.operations.length;
      population.coinLots += bundle.lots.length; population.coinReceipts += bundle.receipts.length;
      if (bundle.archived) population.archivedOwners++;
      reconcileOwner(bundle, context, tally);
    }
  } finally {
    for (const head of heads) await head.stream.cursor.close();
  }
  const invariants = tally.result();
  const report: ReconciliationReport = { version: 1, tool: 'c27-economic-reconciliation', mode: options.mode ?? 'in-process',
    database: options.database ?? 'caller-selected', scope: options.owner ? 'single-owner' : 'all-owners',
    asOf: options.asOf.toISOString(), snapshot: session?.snapshotEnabled === true, population, catalog, invariants,
    summary: summarizeInvariants(invariants) };
  assertSanitized(report);
  return report;
}

export type ReconciliationArguments = { database: string; owner?: string; asOf?: Date };
export function reconciliationArguments(args: readonly string[]): ReconciliationArguments {
  const usage = new Error('usage: db:reconcile-economy -- --read-only --database <name> [--owner <uuid>] [--as-of <ISO-8601 UTC>]');
  if (args[0] !== '--read-only' || args[1] !== '--database' || !args[2] || !/^[A-Za-z0-9_-]{1,63}$/.test(args[2])) throw usage;
  const result: ReconciliationArguments = { database: args[2] };
  for (let i = 3; i < args.length; i += 2) {
    const value = args[i + 1];
    if (args[i] === '--owner' && result.owner === undefined && value && OWNER_ID.test(value)) result.owner = value;
    else if (args[i] === '--as-of' && result.asOf === undefined && value && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)
      && new Date(value).toISOString() === value) result.asOf = new Date(value);
    else throw usage;
  }
  return result;
}

/**
 * Connects with command monitoring, reads one snapshot and returns counts only.
 * Any command outside the C25 read allowlist, or outside the selected database, fails the run.
 */
export async function runReadOnlyReconciliation(uri: string | undefined, database: string,
  options: { owner?: string; asOf?: Date; samples?: number } = {}) {
  assertUriAllowed(uri, 'read-only');
  if (!/^[A-Za-z0-9_-]{1,63}$/.test(database)) throw new Error('reconciliation_database_invalid');
  const client = new MongoClient(uri!, { monitorCommands: true, maxPoolSize: 2, serverSelectionTimeoutMS: 10000,
    retryWrites: false, appName: 'atomic-c27-reconcile-read-only' });
  const violations: string[] = [];
  const counts = new Map<string, number>();
  client.on('commandStarted', event => {
    counts.set(event.commandName, (counts.get(event.commandName) ?? 0) + 1);
    const violation = commandViolation(event, 'read-only', database);
    if (violation) violations.push(`${violation}:${event.commandName}`);
  });
  try {
    await client.connect();
    const session = client.startSession({ snapshot: true });
    let report: ReconciliationReport;
    try {
      report = await reconcileEconomy(client.db(database), { asOf: options.asOf ?? new Date(), owner: options.owner, session,
        samples: options.samples, mode: 'read-only', database: 'operator-selected' });
    } finally { await session.endSession(); }
    if (violations.length) throw new Error('reconciliation_read_only_guard_violation');
    return { report, violations: [...violations],
      commands: Object.fromEntries([...counts].sort(([a], [b]) => a.localeCompare(b))) };
  } finally { await client.close(); }
}
