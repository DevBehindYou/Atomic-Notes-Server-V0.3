import { createHash, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { Server as HttpServer } from 'node:http';
import { pathToFileURL } from 'node:url';
import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import type { Db } from 'mongodb';
import type { DriveAdapter } from '../src/routes/notes.js';
import { assertFixtureCleanup, fixtureDatabase } from './clientFixtureSafety.js';
import { fixtureFailureIds, fixtureReadFault } from './clientFixtureFaults.js';

// Public, synthetic credentials valid only in this generated test database.
export const FIXTURE_TOKENS = {
  a: 'atomic-disposable-client-a', b: 'atomic-disposable-client-b', other: 'atomic-disposable-other',
  batch: 'atomic-disposable-batch',
} as const;
let started = false;

export async function startClientFixture(uri: string | undefined, selectedDatabase?: string) {
  const database = fixtureDatabase(uri, selectedDatabase);
  if (started) throw new Error('fixture_one_instance_per_process');
  started = true;
  process.env.MONGODB_URI = uri;
  process.env.MONGODB_DB_NAME = database;
  // Never load .env; override test-process encryption policy with dummy material.
  process.env.TOKEN_ENCRYPTION_KEY = Buffer.alloc(32, 3).toString('base64');
  delete process.env.COIN_EXPIRY_ACTIVATED_AT;
  const { getDb, closeDb } = await import('../src/db/mongo.js');
  let db: Db | undefined;
  let server: ReturnType<typeof serve> | undefined;
  let cleanup: Promise<void> | undefined;
  let mayDrop = false;
  const close = () => cleanup ??= (async () => {
    try {
      if (server) {
        if (server instanceof HttpServer) server.closeAllConnections();
        await new Promise<void>((resolve, reject) => server!.close((error) => error ? reject(error) : resolve()));
      }
    } finally {
      try {
        if (db && mayDrop) {
          assertFixtureCleanup(db.databaseName, database);
          await db.dropDatabase();
        }
      } finally { await closeDb(); }
    }
  })();
  try {
    db = await getDb();
    assertFixtureCleanup(db.databaseName, database);
    if (!(await db.admin().command({ hello: 1 })).setName) throw new Error('fixture_requires_replica_set');
    // Never drop a colliding/preexisting database, including failed setup.
    if (await db.listCollections().hasNext()) throw new Error('fixture_database_already_exists');
    mayDrop = true;
    const { collections, ensureIndexes } = await import('../src/db/collections.js');
    const { encryptToken } = await import('../src/lib/crypto.js');
    const { energyEnsure } = await import('../src/lib/energy.js');
    const { createNotesRoute } = await import('../src/routes/notes.js');
    const { registerErrorHandler } = await import('../src/middleware/errorHandler.js');
    await ensureIndexes(db);
    const owner = randomUUID(), other = randomUUID(), batchOwner = randomUUID();
    for (const userId of [owner, other, batchOwner]) {
      const now = new Date();
      await collections.users(db).insertOne({ _id: userId, email: `${userId}@example.test`, displayName: null, createdAt: now, updatedAt: now });
      await collections.googleAccounts(db).insertOne({ _id: randomUUID(), userId, googleAccountId: randomUUID(),
        encryptedAccessToken: encryptToken('fixture-access'), encryptedRefreshToken: encryptToken('fixture-refresh'),
        tokenExpiry: new Date(now.getTime() + 86400000), driveRootFolderId: 'fixture-folder', createdAt: now });
      await energyEnsure(db, userId);
      await collections.atomicUsers(db).updateOne({ _id: userId }, { $set: { energy: 100, lastDailyGrantAt: now } });
      // A separate synthetic existing 100-note tier, not a purchase or policy
      // change. Its wallet/window cannot depend on earlier wire scenarios.
      if (userId === batchOwner) await collections.atomicUsers(db).updateOne({ _id: userId }, { $set: { noteLimit: 100 } });
    }
    for (const [device, token] of Object.entries(FIXTURE_TOKENS)) {
      const now = new Date();
      await collections.sessions(db).insertOne({ _id: createHash('sha256').update(token).digest('hex'),
        userId: device === 'other' ? other : device === 'batch' ? batchOwner : owner, createdAt: now,
        expiresAt: new Date(now.getTime() + 86400000), revoked: false, userAgent: 'disposable-fixture' });
    }
    const files = new Map<string, Record<string, unknown>>();
    let writes = 0, reads = 0;
    let writeAttempts = 0, writeFailures = 0;
    let failedIds = new Set<string>();
    let readFault: ReturnType<typeof fixtureReadFault> | undefined;
    const checkWrite = (content: object) => {
      writeAttempts++;
      if ('id' in content && typeof content.id === 'string' && failedIds.has(content.id)) {
        writeFailures++;
        throw new Error('fixture_drive_write_failed');
      }
    };
    const notFound = () => Object.assign(new Error('fixture_file_missing'), { code: 404 });
    const drive: DriveAdapter = {
      async createNoteFile(_a, _r, _folder, _name, content) {
        checkWrite(content);
        const id = randomUUID(); files.set(id, structuredClone(content) as Record<string, unknown>); writes++;
        return { id, headRevisionId: 'fixture-revision' };
      },
      async updateNoteFile(_a, _r, id, content) {
        checkWrite(content);
        if (!files.has(id)) throw notFound();
        files.set(id, structuredClone(content) as Record<string, unknown>); writes++;
        return { id, headRevisionId: 'fixture-revision' };
      },
      async deleteNoteFile(_a, _r, id) {
        if (!files.delete(id)) throw notFound();
        writes++;
      },
      async getNoteFileContent(_a, _r, id) {
        const content = files.get(id);
        if (!content) throw notFound();
        reads++;
        const fault = readFault;
        if (fault && fault.noteId === content.id) {
          if (fault.mode === 'missing') throw notFound();
          if (fault.mode === 'corrupt') return { fixture_invalid_file: true };
          if (fault.mode === 'mismatch') return { ...structuredClone(content), body: 'Synthetic inconsistent body' };
        }
        return structuredClone(content);
      },
      async ensureAppFolders() { return { notesId: 'fixture-folder' }; },
    };
    const app = new Hono();
    registerErrorHandler(app);
    app.route('/api/notes', createNotesRoute(drive));
    // Read-only fixture diagnostics. No such endpoints exist in production.
    app.get('/__fixture/ready', (c) => c.json({ owner, other, batchOwner, database }));
    // Fault controls exist only in this guarded loopback test assembly.
    app.post('/__fixture/fail-writes', async (c) => {
      if (c.req.header('authorization') !== `Bearer ${FIXTURE_TOKENS.a}`) return c.json({ error: 'fixture_control_denied' }, 401);
      try { failedIds = fixtureFailureIds(await c.req.json()); }
      catch { return c.json({ error: 'fixture_invalid_failure_ids' }, 400); }
      return c.json({ armed: failedIds.size });
    });
    // One simulated read fault at a time. Restore disables the response fault;
    // it never deletes or rewrites the underlying fake file or metadata.
    app.post('/__fixture/read-fault', async (c) => {
      if (c.req.header('authorization') !== `Bearer ${FIXTURE_TOKENS.a}`) return c.json({ error: 'fixture_control_denied' }, 401);
      try { readFault = fixtureReadFault(await c.req.json()); }
      catch { return c.json({ error: 'fixture_invalid_read_fault' }, 400); }
      return c.json({ armed: readFault.mode !== 'none' });
    });
    app.get('/__fixture/state', async (c) => {
      const users = await Promise.all([owner, other, batchOwner].map(async (userId) => ({
        userId,
        energy: (await collections.atomicUsers(db!).findOne({ _id: userId }))!.energy,
        notes: await collections.notes(db!).countDocuments({ userId, deleted: false }),
        ledger: await collections.energyLedger(db!).find({ userId }, { projection: { _id: 0, kind: 1, energyDelta: 1 } }).toArray(),
      })));
      return c.json({ writes, reads, writeAttempts, writeFailures, liveFiles: files.size, users });
    });
    server = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: 0 });
    if (!server.listening) await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string' || address.address !== '127.0.0.1') throw new Error('fixture_requires_loopback');
    return { origin: `http://127.0.0.1:${address.port}`, database, owner, other, batchOwner, close };
  } catch (error) {
    await close();
    throw error;
  }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  try {
    const fixture = await startClientFixture(process.env.MONGODB_URI, process.env.MONGODB_DB_NAME);
    console.log(JSON.stringify({ origin: fixture.origin, database: fixture.database }));
    const stop = () => { void fixture.close().then(() => process.exit(0), () => process.exit(1)); };
    process.once('SIGINT', stop); process.once('SIGTERM', stop);
  } catch { console.error('disposable_client_fixture_start_failed'); process.exitCode = 1; }
}
