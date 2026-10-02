import { applySyncRetention, inspectSyncRetention, retentionArguments } from '../db/syncRetention.js';

// No connection on invalid arguments, and read-only inspection unless explicitly applied.
let close: (() => Promise<void>) | undefined;
try {
  const args = retentionArguments(process.argv.slice(2));
  const { getDb, closeDb } = await import('../db/mongo.js');
  close = closeDb;
  const db = await getDb();
  const plan = args.apply
    ? await applySyncRetention(db, args.database!)
    : await inspectSyncRetention(db);
  console.log(JSON.stringify({ mode: args.apply ? 'applied' : 'inspect-only', ...plan }));
} catch {
  // Driver messages can contain connection information. Emit no exception/URI values.
  console.error('Sync retention inspection/transition failed. Check arguments, database identity, connectivity and index definitions. A partial transition can be inspected and rerun; do not restore TTLs.');
  process.exitCode = 1;
} finally {
  try { await close?.(); } catch { process.exitCode = 1; }
}
