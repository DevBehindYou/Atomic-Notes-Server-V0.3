import { createHash, randomUUID } from 'node:crypto';
import { MongoClient, type Db, type Document } from 'mongodb';
import { ensureIndexes } from './collections.js';
import {
  DISPOSABLE_DATABASE, assertSanitized, assertUriAllowed, commandViolation, declaredIndexes, diagnoseProbe,
  largestNoteOwner, summarize, type ProbeReport,
} from './queryDiagnostics.js';

// C25 disposable fixture. The only writes in this feature are here, and every
// one goes to a database whose generated name this process checked was empty.

/** Synthetic clock. Every expiry is after it and after any real run date, so no TTL monitor removes rows mid-run. */
export const FIXTURE_AS_OF = new Date('2036-01-01T00:00:00.000Z');
const DAY = 24 * 60 * 60 * 1000;

/** Realistic shape: many small accounts plus one long-lived heavy account (paid note limit, legacy ledger). */
export const FIXTURE_PROFILE = {
  typicalUsers: 400, typicalNotes: 12, heavyNotes: 3000, unsequencedHeavyNotes: 60,
  typicalSessions: 3, heavySessions: 60, heavyActiveSessions: 5,
  typicalOperations: 10, heavyOperations: 1500, heavyPendingOperations: 2,
  typicalLedger: 30, heavyLedger: 2000, typicalLots: 3, heavyLots: 400, heavyDueLots: 20,
  notifications: 300, heavyRecipients: 40,
} as const;

/** Deterministic 8-4-4-4-12 id; z.guid() accepts it. Only ever stored in the disposable database. */
export function fixtureId(label: string): string {
  const h = createHash('sha256').update(`c25-fixture:${label}`).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
}
const hex64 = (label: string) => createHash('sha256').update(`c25-fixture-hash:${label}`).digest('hex');
const at = (offsetMs: number) => new Date(FIXTURE_AS_OF.getTime() - offsetMs);

export const HEAVY_OWNER = fixtureId('user:heavy');
export const TYPICAL_OWNER = fixtureId('user:typical:1');

async function insert(db: Db, name: string, docs: Document[]) {
  for (let i = 0; i < docs.length; i += 1000) await db.collection(name).insertMany(docs.slice(i, i + 1000), { ordered: false });
}

function ownerDocs(userId: string, index: number, heavy: boolean) {
  const P = FIXTURE_PROFILE;
  const createdAt = at(400 * DAY + index * 1000);
  const sequenced = !heavy && index % 2 === 1; // odd typical accounts use ordered history (historyRetentionVersion 1)
  const user = { _id: userId, email: `synthetic-${index}@example.invalid`, displayName: null, createdAt, updatedAt: createdAt };
  const noteCount = heavy ? P.heavyNotes : P.typicalNotes;
  const notes: Document[] = [];
  let sequence = 0;
  for (let i = 0; i < noteCount; i++) {
    const unsequenced = heavy && i < P.unsequencedHeavyNotes; // written before syncSequence existed
    if (!unsequenced) sequence += 1 + (i % 3 === 0 ? 1 : 0); // superseded sequences leave gaps
    // Sequence order follows update order, so recently edited notes have the highest sequence.
    const updatedAt = at((noteCount - i) * 3 * 60 * 60 * 1000);
    notes.push({
      _id: fixtureId(`note:${index}:${i}`), userId, folderId: null, kind: i % 4 === 0 ? 'todo' : 'text',
      pinned: i % 25 === 0, deleted: i % 5 === 4, encV: i % 5 === 1 ? 1 : 0, driveFileId: `synthetic-drive-${index}-${i}`,
      driveRevisionId: null, localVersion: unsequenced ? 1 : sequence, ...(unsequenced ? {} : { syncSequence: sequence }),
      contentHash: hex64(`content:${index}:${i}`), syncStatus: 'synced', createdAt: at(500 * DAY), updatedAt,
      lastSyncedAt: updatedAt,
    });
  }
  const counter = { _id: userId, value: sequence + 7 }; // a few later sequences belong to wiped notes
  const sessions: Document[] = [];
  const sessionCount = heavy ? P.heavySessions : P.typicalSessions;
  for (let i = 0; i < sessionCount; i++) {
    const created = at((sessionCount - i) * 2 * DAY);
    const active = heavy ? i >= sessionCount - P.heavyActiveSessions : i === sessionCount - 1;
    sessions.push({ _id: hex64(`session:${index}:${i}`), userId, createdAt: created,
      expiresAt: new Date(created.getTime() + 180 * DAY), revoked: !active, userAgent: 'fixture-agent' });
  }
  const operations: Document[] = [];
  const operationCount = heavy ? P.heavyOperations : P.typicalOperations;
  for (let i = 0; i < operationCount; i++) {
    const pending = heavy ? i >= operationCount - P.heavyPendingOperations : index % 40 === 0 && i === operationCount - 1;
    operations.push({ _id: `${userId}:${fixtureId(`request:${index}:${i}`)}`, userId, fingerprint: hex64(`fp:${index}:${i}`),
      mode: i % 7 === 0 ? 'instant' : 'standard', rowIds: [], charged: 0, createdAt: at((operationCount - i) * 60 * 60 * 1000),
      previousStandardAt: null, status: pending ? 'pending' : 'complete', results: [], refunded: 0 });
  }
  const ledger: Document[] = [];
  const ledgerCount = heavy ? P.heavyLedger : P.typicalLedger;
  for (let i = 0; i < ledgerCount; i++) {
    // Writers in one transaction share a timestamp; ties are realistic and need the _id tie-breaker.
    const createdAt = at(Math.floor((ledgerCount - i) / 4) * 60 * 60 * 1000);
    ledger.push({ _id: fixtureId(`ledger:${index}:${i}`), userId, kind: i % 10 === 0 ? 'daily_grant' : 'spend',
      coinsDelta: 0, energyDelta: i % 10 === 0 ? 10 : -1, resultingCoins: 5, resultingEnergy: 50, note: null, createdAt,
      ...(sequenced ? { historySequence: i + 1 } : {}) });
  }
  const lots: Document[] = [];
  const lotCount = heavy ? P.heavyLots : P.typicalLots;
  for (let i = 0; i < lotCount; i++) {
    const creditedAt = at((lotCount - i) * 2 * DAY);
    const expiresAt = i % 9 === 0 ? null : new Date(creditedAt.getTime() + 182 * DAY);
    const expired = expiresAt !== null && expiresAt <= FIXTURE_AS_OF;
    const due = heavy ? expired && i >= lotCount - 200 && i < lotCount - 200 + P.heavyDueLots * 2 && i % 2 === 0 : false;
    lots.push({ _id: `${userId}:lot:${i}`, userId, source: 'controller', creditedAt, expiresAt, amount: 3,
      remaining: expired ? (due ? 3 : 0) : 2, operationId: `${userId}:op:${i}` });
  }
  const coinOperations = heavy ? Array.from({ length: 30 }, (_, i) => ({ _id: `${userId}:${fixtureId(`coin-request:${i}`)}`,
    userId, requestId: fixtureId(`coin-request:${i}`), fingerprint: hex64(`coin-fp:${i}`), createdAt: at(i * DAY),
    allocations: [], result: {} })) : [];
  const attempts = heavy || index % 50 === 0 ? [{ _id: fixtureId(`attempt:${index}`), userId,
    sessionHash: sessions[sessions.length - 1]._id, state: 'completed', createdAt: at(DAY) }] : [];
  const wallet = { _id: userId, username: '', noteLimit: heavy ? 5000 : 30, coins: 5, energy: 40, energyCap: 120,
    lastDailyGrantAt: index % 3 === 0 ? at(2 * 60 * 60 * 1000) : at(10 * DAY), lastStandardSyncAt: null, createdAt,
    ...(sequenced ? { historyRetentionVersion: 1, historySequence: ledgerCount } : {}), ...(heavy ? { coinLotsVersion: 1 } : {}) };
  return { user, wallet, notes, counter, sessions, operations, ledger, lots, coinOperations, attempts };
}

/** Seeds the generated, verified-empty database with production indexes and synthetic rows. */
export async function seedDisposableFixture(db: Db): Promise<Record<string, number>> {
  if (!DISPOSABLE_DATABASE.test(db.databaseName)) throw new Error('explain_fixture_database_not_generated');
  if (await db.listCollections({}, { nameOnly: true }).hasNext()) throw new Error('explain_fixture_database_not_empty');
  await ensureIndexes(db); // the same definitions production uses; nothing else is added here
  const owners = [{ id: HEAVY_OWNER, heavy: true }, ...Array.from({ length: FIXTURE_PROFILE.typicalUsers },
    (_, i) => ({ id: fixtureId(`user:typical:${i}`), heavy: false }))];
  const batches: Record<string, Document[]> = { users: [], atomic_users: [], notes: [], sync_counters: [], sessions: [],
    sync_operations: [], energy_ledger: [], coin_lots: [], coin_operations: [], logout_attempts: [] };
  owners.forEach((owner, i) => {
    const docs = ownerDocs(owner.id, owner.heavy ? 100000 : i - 1, owner.heavy);
    batches.users.push(docs.user); batches.atomic_users.push(docs.wallet); batches.notes.push(...docs.notes);
    batches.sync_counters.push(docs.counter); batches.sessions.push(...docs.sessions);
    batches.sync_operations.push(...docs.operations); batches.energy_ledger.push(...docs.ledger);
    batches.coin_lots.push(...docs.lots); batches.coin_operations.push(...docs.coinOperations);
    batches.logout_attempts.push(...docs.attempts);
  });
  batches.notifications = Array.from({ length: FIXTURE_PROFILE.notifications }, (_, i) => ({
    _id: fixtureId(`notification:${i}`), type: 'information', subject: 'Fixture notice', description: 'Disposable',
    priority: 'normal', status: (['active', 'resolved', 'expired'] as const)[i % 3], action: null, actionUrl: null, icon: null,
    targetAudience: i % 10 === 0 ? 'active' : 'all', targetUserId: null, minAppVersion: null, maxAppVersion: null,
    dismissible: i % 15 !== 0, createdAt: at(Math.floor(i / 3) * 60 * 60 * 1000), expiresAt: null,
  }));
  batches.notification_recipients = batches.notifications.filter((_, i) => i % 10 === 0)
    .slice(0, FIXTURE_PROFILE.heavyRecipients).map(n => ({ _id: `${n._id}:${HEAVY_OWNER}`, notificationId: n._id, userId: HEAVY_OWNER }));
  const counts: Record<string, number> = {};
  for (const [name, docs] of Object.entries(batches)) { await insert(db, name, docs); counts[name] = docs.length; }
  return Object.fromEntries(Object.entries(counts).sort(([a], [b]) => a.localeCompare(b)));
}

/** Proposed, NOT applied anywhere but the disposable database. See docs/proposals/INDEX_PROPOSAL_C25.md. */
export const candidateIndexes = [
  { collection: 'notes', name: 'c25_candidate_owner_sequence_id', key: { userId: 1, syncSequence: 1, _id: 1 },
    replaces: { userId: 1, syncSequence: 1 }, affects: ['notes.pull.first', 'notes.pull.next', 'notes.pull.encOnly', 'notes.pull.since'] },
  { collection: 'sessions', name: 'c25_candidate_owner_created_id', key: { userId: 1, createdAt: -1, _id: -1 },
    replaces: { userId: 1, createdAt: -1 }, affects: ['sessions.inventory', 'sessions.limitActive', 'admin.lastSession'] },
] as const;

const keyText = (key: Record<string, number>) => Object.entries(key).map(([f, d]) => `${f}:${d}`).join(',');

type GuardedClient = { client: MongoClient; violations: string[]; commands: () => Record<string, number> };
function guardedClient(uri: string, mode: 'read-only' | 'seed-disposable', database: string): GuardedClient {
  const client = new MongoClient(uri, { monitorCommands: true, maxPoolSize: 4, serverSelectionTimeoutMS: 10000,
    retryWrites: false, appName: `atomic-c25-explain-${mode}` });
  const violations: string[] = [];
  const counts = new Map<string, number>();
  client.on('commandStarted', event => {
    counts.set(event.commandName, (counts.get(event.commandName) ?? 0) + 1);
    const violation = commandViolation(event, mode, database);
    if (violation) violations.push(`${violation}:${event.commandName}`);
  });
  return { client, violations, commands: () => Object.fromEntries([...counts].sort(([a], [b]) => a.localeCompare(b))) };
}

async function mongoVersion(client: MongoClient) {
  return String((await client.db('admin').command({ buildInfo: 1 })).version);
}

export type DiagnosticsReport = {
  version: 1; tool: 'c25-query-diagnostics'; mode: 'seed-disposable' | 'read-only'; database: 'generated-disposable' | 'operator-selected';
  mongo: string; asOf: string; fixture: Record<string, number> | null; declaredIndexes: Record<string, string[]>;
  probes: ProbeReport[]; summary: ReturnType<typeof summarize>;
  candidates: null | { indexes: { collection: string; key: string; replaces: string }[];
    added: ProbeReport[]; replacement: ProbeReport[]; summaryAdded: ReturnType<typeof summarize>;
    summaryReplacement: ReturnType<typeof summarize> };
};

async function candidatePhase(db: Db, phase: 'added' | 'replacement'): Promise<ProbeReport[]> {
  const affected = new Set(candidateIndexes.map(c => c.collection) as string[]);
  const only = (spec: { collection: string }) => affected.has(spec.collection);
  return [await diagnoseProbe(db, `largest-owner:${phase}`, HEAVY_OWNER, FIXTURE_AS_OF, 1000, only),
    await diagnoseProbe(db, `typical-owner:${phase}`, TYPICAL_OWNER, FIXTURE_AS_OF, 1000, only)];
}

async function indexName(db: Db, collection: string, key: Record<string, number>) {
  const found = (await db.collection(collection).indexes()).find(i => keyText(i.key as Record<string, number>) === keyText(key));
  if (!found?.name) throw new Error('explain_replaced_index_missing');
  return found.name;
}

/**
 * Generates a database name, seeds it, explains every inventoried query, optionally measures
 * the candidate indexes inside that same database, and always drops only that database.
 */
export async function runDisposableDiagnostics(uri: string | undefined, options: { withCandidates?: boolean } = {}):
  Promise<{ report: DiagnosticsReport; violations: string[] }> {
  assertUriAllowed(uri, 'seed-disposable');
  const database = `atomic_explain_${randomUUID().replaceAll('-', '').slice(0, 20)}`;
  const guarded = guardedClient(uri!, 'seed-disposable', database);
  let mayDrop = false;
  try {
    await guarded.client.connect();
    const db = guarded.client.db(database);
    if (await db.listCollections({}, { nameOnly: true }).hasNext()) throw new Error('explain_fixture_database_not_empty');
    mayDrop = true;
    const fixture = await seedDisposableFixture(db);
    const probes = [await diagnoseProbe(db, 'largest-owner', HEAVY_OWNER, FIXTURE_AS_OF, 1000),
      await diagnoseProbe(db, 'typical-owner', TYPICAL_OWNER, FIXTURE_AS_OF, 1000)];
    let candidates: DiagnosticsReport['candidates'] = null;
    if (options.withCandidates) {
      for (const c of candidateIndexes) await db.collection(c.collection).createIndex({ ...c.key }, { name: c.name });
      const added = await candidatePhase(db, 'added');
      // Simulate the proposed replacement: hide (not drop) the superseded index, as the rollout would.
      const hidden: { collection: string; name: string }[] = [];
      for (const c of candidateIndexes) {
        const name = await indexName(db, c.collection, c.replaces);
        await db.command({ collMod: c.collection, index: { name, hidden: true } });
        hidden.push({ collection: c.collection, name });
      }
      const replacement = await candidatePhase(db, 'replacement');
      for (const h of hidden) await db.command({ collMod: h.collection, index: { name: h.name, hidden: false } });
      for (const c of candidateIndexes) await db.collection(c.collection).dropIndex(c.name);
      candidates = { indexes: candidateIndexes.map(c => ({ collection: c.collection, key: keyText(c.key), replaces: keyText(c.replaces) })),
        added, replacement, summaryAdded: summarize(added), summaryReplacement: summarize(replacement) };
    }
    const report: DiagnosticsReport = { version: 1, tool: 'c25-query-diagnostics', mode: 'seed-disposable',
      database: 'generated-disposable', mongo: await mongoVersion(guarded.client), asOf: FIXTURE_AS_OF.toISOString(), fixture,
      declaredIndexes: await declaredIndexes(db), probes, summary: summarize(probes), candidates };
    assertSanitized(report);
    return { report, violations: [...guarded.violations] };
  } finally {
    try {
      if (mayDrop && DISPOSABLE_DATABASE.test(database)) await guarded.client.db(database).dropDatabase();
    } finally { await guarded.client.close(); }
  }
}

/** Never writes: only reads and explains are sent; any other command is recorded as a violation and fails the run. */
export async function runReadOnlyDiagnostics(uri: string | undefined, database: string,
  options: { maxPages?: number; asOf?: Date } = {}): Promise<{ report: DiagnosticsReport; violations: string[]; commands: Record<string, number> }> {
  assertUriAllowed(uri, 'read-only');
  if (!/^[A-Za-z0-9_-]{1,63}$/.test(database)) throw new Error('explain_database_invalid');
  const guarded = guardedClient(uri!, 'read-only', database);
  try {
    await guarded.client.connect();
    const db = guarded.client.db(database);
    const asOf = options.asOf ?? new Date();
    const owner = await largestNoteOwner(db);
    const probes = owner ? [await diagnoseProbe(db, 'largest-owner', owner, asOf, options.maxPages ?? 30)] : [];
    const report: DiagnosticsReport = { version: 1, tool: 'c25-query-diagnostics', mode: 'read-only',
      database: 'operator-selected', mongo: await mongoVersion(guarded.client), asOf: asOf.toISOString(), fixture: null,
      declaredIndexes: await declaredIndexes(db), probes, summary: summarize(probes), candidates: null };
    assertSanitized(report);
    if (guarded.violations.length) throw new Error('explain_read_only_guard_violation');
    return { report, violations: [...guarded.violations], commands: guarded.commands() };
  } finally { await guarded.client.close(); }
}

/** Test support: seed a generated database and leave it for a read-only run; caller drops it with `drop`. */
export async function seedForReadOnlyCheck(uri: string | undefined) {
  assertUriAllowed(uri, 'seed-disposable');
  const database = `atomic_explain_${randomUUID().replaceAll('-', '').slice(0, 20)}`;
  const client = new MongoClient(uri!, { maxPoolSize: 2, serverSelectionTimeoutMS: 10000, retryWrites: false });
  await client.connect();
  const db = client.db(database);
  let seeded = false;
  try {
    if (await db.listCollections({}, { nameOnly: true }).hasNext()) throw new Error('explain_fixture_database_not_empty');
    seeded = true;
    const fixture = await seedDisposableFixture(db);
    return { database, fixture, db,
      drop: async () => { try { if (DISPOSABLE_DATABASE.test(database)) await db.dropDatabase(); } finally { await client.close(); } } };
  } catch (error) {
    try { if (seeded) await db.dropDatabase(); } finally { await client.close(); }
    throw error;
  }
}
