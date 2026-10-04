import { inspectLedgerRetention, ledgerInspectionArguments } from '../db/ledgerRetentionInspection.js';

let close: (() => Promise<void>) | undefined;
try {
  ledgerInspectionArguments(process.argv.slice(2));
  const { getDb, closeDb } = await import('../db/mongo.js');
  close = closeDb;
  console.log(JSON.stringify(await inspectLedgerRetention(await getDb())));
} catch {
  // No driver error, database identity, connection string or personal records are printed.
  console.error('Ledger history inspection failed. Check arguments, read access and connectivity. No apply mode is available.');
  process.exitCode = 1;
} finally {
  try { await close?.(); } catch { process.exitCode = 1; }
}
