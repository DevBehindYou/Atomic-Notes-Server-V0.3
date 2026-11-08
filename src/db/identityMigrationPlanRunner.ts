import { MongoClient, type ClientSession, type Db, type Document } from 'mongodb';
import {
  MAX_LIMIT, planIdentityMigration, planReport, type AccountRow, type IdentityPlanReport, type IndexCatalog, type UserRow,
} from './identityMigrationPlan.js';
import { assertUriAllowed, commandViolation } from './queryDiagnostics.js';

// C28 runner. Reads users and google_accounts once, in one snapshot, with an explicit
// projection: encrypted tokens are never requested. Sends reads only; the guarded runner
// fails on any command outside the C25 read allowlist or the selected database.
// There is no apply, backfill or index mode.

const MAX_TIME_MS = 120_000;
const BATCH = 500;
/** Refuse rather than plan a partial population that would hide collisions. */
export const MAX_ROWS = 200_000;
const DATABASE = /^[A-Za-z0-9_-]{1,63}$/;

const USER_FIELDS = { _id: 1, email: 1, displayName: 1, createdAt: 1, updatedAt: 1 } as const;
const ACCOUNT_FIELDS = { _id: 1, userId: 1, googleAccountId: 1, driveRootFolderId: 1, createdAt: 1 } as const;

async function readAll<T>(db: Db, name: string, projection: Document, session: ClientSession | undefined): Promise<T[]> {
  // Catalog reads never join the snapshot session: snapshot reads support find/aggregate/distinct only.
  if (!await db.listCollections({ name }, { nameOnly: true }).hasNext()) return [];
  const rows: T[] = [];
  const cursor = db.collection(name).find({}, { projection, sort: { _id: 1 }, session, batchSize: BATCH, maxTimeMS: MAX_TIME_MS });
  try {
    for await (const row of cursor) {
      if (rows.length >= MAX_ROWS) throw new Error('identity_plan_population_exceeds_bound');
      rows.push(row as T);
    }
  } finally { await cursor.close(); }
  return rows;
}

const sameKey = (key: unknown, field: string) => typeof key === 'object' && key !== null
  && Object.keys(key).length === 1 && (key as Record<string, unknown>)[field] === 1;

async function catalog(db: Db): Promise<IndexCatalog> {
  const indexes = async (name: string) => await db.listCollections({ name }, { nameOnly: true }).hasNext()
    ? await db.collection(name).listIndexes().toArray() : [];
  const users = await indexes('users'), accounts = await indexes('google_accounts');
  const unique = (list: Document[], field: string) => list.find(index => sameKey(index.key, field) && index.unique === true);
  const email = unique(users, 'email');
  return {
    usersEmailUnique: Boolean(email),
    // The production index has no collation: uniqueness is exact-case, so case variants can coexist.
    usersEmailCaseInsensitive: Boolean(email?.collation && typeof email.collation.strength === 'number' && email.collation.strength <= 2),
    googleSubjectUnique: Boolean(unique(accounts, 'googleAccountId')),
    googleUserIdUnique: Boolean(unique(accounts, 'userId')),
  };
}

/** Read-only. With a snapshot session both collections are read at the same point in time. */
export async function planIdentityMigrationFromDb(db: Db, options: { limit?: number; resume?: string; session?: ClientSession;
  mode?: IdentityPlanReport['mode']; database?: IdentityPlanReport['database'] } = {}): Promise<IdentityPlanReport> {
  const session = options.session;
  const users = await readAll<UserRow>(db, 'users', USER_FIELDS, session);
  const accounts = await readAll<AccountRow>(db, 'google_accounts', ACCOUNT_FIELDS, session);
  const indexCatalog = await catalog(db);
  const plan = planIdentityMigration(users, accounts, { limit: options.limit, resume: options.resume });
  return planReport(plan, { mode: options.mode, database: options.database, snapshot: session?.snapshotEnabled === true,
    catalog: indexCatalog, resumed: options.resume !== undefined });
}

export type IdentityPlanArguments = { database: string; limit?: number; resume?: string };
export function identityPlanArguments(args: readonly string[]): IdentityPlanArguments {
  const usage = new Error('usage: db:plan-identity -- --read-only --database <name> [--limit <1-100000>] [--resume <checkpoint>]');
  if (args[0] !== '--read-only' || args[1] !== '--database' || !args[2] || !DATABASE.test(args[2])) throw usage;
  const result: IdentityPlanArguments = { database: args[2] };
  for (let i = 3; i < args.length; i += 2) {
    const value = args[i + 1];
    if (args[i] === '--limit' && result.limit === undefined && value && /^\d{1,6}$/.test(value) && +value >= 1 && +value <= MAX_LIMIT) {
      result.limit = +value;
    } else if (args[i] === '--resume' && result.resume === undefined && value && /^c28\.1\.[0-9a-f.]{1,80}$/.test(value)) {
      result.resume = value;
    } else throw usage;
  }
  return result;
}

/**
 * Connects with command monitoring, reads one snapshot and returns counts only.
 * Any command outside the C25 read allowlist, or outside the selected database, fails the run.
 */
export async function runReadOnlyIdentityPlan(uri: string | undefined, database: string,
  options: { limit?: number; resume?: string } = {}) {
  assertUriAllowed(uri, 'read-only');
  if (!DATABASE.test(database)) throw new Error('identity_plan_database_invalid');
  const client = new MongoClient(uri!, { monitorCommands: true, maxPoolSize: 2, serverSelectionTimeoutMS: 10000,
    retryWrites: false, appName: 'atomic-c28-identity-plan-read-only' });
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
    let report: IdentityPlanReport;
    try {
      report = await planIdentityMigrationFromDb(client.db(database), { ...options, session, mode: 'read-only',
        database: 'operator-selected' });
    } finally { await session.endSession(); }
    if (violations.length) throw new Error('identity_plan_read_only_guard_violation');
    return { report, violations: [...violations],
      commands: Object.fromEntries([...counts].sort(([a], [b]) => a.localeCompare(b))) };
  } finally { await client.close(); }
}
