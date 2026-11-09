import { createHash, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { serve } from '@hono/node-server';
import type { Db } from 'mongodb';
import { assertFixtureCleanup } from './clientFixtureSafety.js';
import { assertLoopbackOrigin, installLoopbackOnlyNetwork, loadDatabase, loadToken, socketMeter } from './loadCharacterizeCore.js';

// C48: the App Server under load, in its own process so its memory is measured alone. It serves the real
// notes routes (auth, push, pull, the same 4 MiB body cap and error handler as src/app.ts) on 127.0.0.1,
// with the production per-request Drive session pointed at the loopback fixture. It owns a freshly named
// disposable database on a loopback MongoDB, seeds synthetic users, and drops that database on close.
if (!process.send) throw new Error('load_app_requires_ipc');
installLoopbackOnlyNetwork();
const database = loadDatabase(process.env.MONGODB_URI, process.env.MONGODB_DB_NAME);
const driveOrigin = assertLoopbackOrigin(process.argv[2] ?? '');
const users = Number(process.argv[3]);
if (!Number.isInteger(users) || users < 1 || users > 64) throw new Error('load_invalid_user_count');
process.env.MONGODB_DB_NAME = database;
// Dummy key material for this process only; never load .env.
process.env.TOKEN_ENCRYPTION_KEY = Buffer.alloc(32, 5).toString('base64');
delete process.env.COIN_EXPIRY_ACTIVATED_AT;

const { getDb, closeDb } = await import('../src/db/mongo.js');
const { mongoCommands } = await import('../src/lib/perf.js');
let db: Db | undefined;
let mayDrop = false;
let server: ReturnType<typeof serve> | undefined;
let closing: Promise<void> | undefined;
const close = () => closing ??= (async () => {
  try {
    if (server) {
      if (server instanceof HttpServer) server.closeAllConnections();
      await new Promise<void>((resolve) => server!.close(() => resolve()));
    }
  } finally {
    try {
      if (db && mayDrop) { assertFixtureCleanup(db.databaseName, database); await db.dropDatabase(); }
    } finally { await closeDb(); }
  }
})();

const peak = { rss: 0, heapUsed: 0 };
const sample = () => {
  const usage = process.memoryUsage();
  peak.rss = Math.max(peak.rss, usage.rss); peak.heapUsed = Math.max(peak.heapUsed, usage.heapUsed);
  return usage;
};
const sampler = setInterval(sample, 20);
sampler.unref();

try {
  db = await getDb();
  assertFixtureCleanup(db.databaseName, database);
  if (!(await db.admin().command({ hello: 1 })).setName) throw new Error('load_requires_replica_set');
  if (await db.listCollections().hasNext()) throw new Error('load_database_already_exists');
  mayDrop = true;
  const mongoMajor = Number(String((await db.admin().command({ buildInfo: 1 })).version).split('.')[0]);
  const { collections, ensureIndexes } = await import('../src/db/collections.js');
  const { encryptToken } = await import('../src/lib/crypto.js');
  const { energyEnsure } = await import('../src/lib/energy.js');
  const { createNotesRoute } = await import('../src/routes/notes.js');
  const { registerErrorHandler } = await import('../src/middleware/errorHandler.js');
  const { driveSession } = await import('../src/lib/googleDrive.js');
  await ensureIndexes(db);
  const now = new Date();
  for (let i = 0; i < users; i++) {
    const userId = randomUUID();
    await collections.users(db).insertOne({ _id: userId, email: `${userId}@example.test`, displayName: null, createdAt: now, updatedAt: now });
    // A token far from expiry: the route never asks Google (or the fixture) to refresh it.
    await collections.googleAccounts(db).insertOne({ _id: randomUUID(), userId, googleAccountId: randomUUID(),
      encryptedAccessToken: encryptToken('atomic-load-access'), encryptedRefreshToken: encryptToken('atomic-load-refresh'),
      tokenExpiry: new Date(now.getTime() + 30 * 86400000), driveRootFolderId: 'atomic-load-folder', createdAt: now });
    await energyEnsure(db, userId);
    // Synthetic wallets in the disposable database: enough Energy that charging never limits the load,
    // and the existing 100-note tier. No pricing, charging or refund code is changed.
    await collections.atomicUsers(db).updateOne({ _id: userId },
      { $set: { energy: 1_000_000_000, energyCap: 1_000_000_000, lastDailyGrantAt: now, noteLimit: 100 } });
    await collections.sessions(db).insertOne({ _id: createHash('sha256').update(loadToken(i)).digest('hex'), userId,
      createdAt: now, expiresAt: new Date(now.getTime() + 86400000), revoked: false, userAgent: 'disposable-load' });
  }

  const unexpected = async () => { throw new Error('per-call Drive adapter used'); };
  const app = new Hono().basePath('/api');
  app.use('*', bodyLimit({ maxSize: 4 * 1024 * 1024, onError: (c) => c.json({ error: 'request_too_large' }, 413) }));
  registerErrorHandler(app);
  app.route('/notes', createNotesRoute({ createNoteFile: unexpected, updateNoteFile: unexpected, deleteNoteFile: unexpected,
    getNoteFileContent: unexpected, forRequest: (accessToken, refreshToken) => driveSession(accessToken, refreshToken, { origin: driveOrigin }) }));
  server = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: 0 });
  if (!server.listening) await once(server, 'listening');
  const address = server.address() as AddressInfo;
  if (address.address !== '127.0.0.1') throw new Error('load_requires_loopback');
  const transport = socketMeter(server as unknown as import('node:net').Server);

  process.on('message', (message: { id: number; type: string }) => {
    if (message.type === 'reset') {
      (globalThis as { gc?: () => void }).gc?.();
      const usage = process.memoryUsage();
      peak.rss = usage.rss; peak.heapUsed = usage.heapUsed;
      process.send!({ id: message.id, ok: true });
    } else if (message.type === 'snapshot') {
      const usage = sample();
      const { bytesIn, bytesOut } = transport();
      process.send!({ id: message.id, rss: usage.rss, heapUsed: usage.heapUsed, peakRss: peak.rss, peakHeapUsed: peak.heapUsed,
        mongoCommands: mongoCommands.started, transportIn: bytesIn, transportOut: bytesOut });
    } else if (message.type === 'close') {
      void close().then(() => process.send!({ id: message.id, ok: true }, () => process.exit(0)),
        () => process.send!({ id: message.id, ok: false }, () => process.exit(1)));
    }
  });
  process.on('disconnect', () => { void close().finally(() => process.exit(1)); });
  process.send({ type: 'ready', port: address.port, mongoMajor });
} catch (error) {
  console.error('load_app_start_failed', error instanceof Error ? error.message : 'unknown');
  await close();
  process.exit(1);
}
