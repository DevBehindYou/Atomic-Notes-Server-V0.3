import { getDb, closeDb } from '../db/mongo.js';
import { auditCoinBalances } from '../lib/coinLots.js';
// Read-only: do not initialize wallets, settle expiry, build indexes, or expose account identifiers.
try {
  const result = await auditCoinBalances(await getDb());
  console.log(JSON.stringify(result));
  if (result.mismatchedWallets || result.invalidLots) process.exitCode = 1;
} finally { await closeDb(); }
