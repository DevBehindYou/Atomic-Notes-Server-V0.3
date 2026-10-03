import type { ClientSession, Db } from 'mongodb';
import { collections, type EnergyLedgerDoc } from '../db/collections.js';

/** Single financial-history write boundary. The caller owns balance changes and commit/retry. */
export async function appendLedger(db: Db, session: ClientSession, entry: EnergyLedgerDoc): Promise<void> {
  if (!session.inTransaction()) throw new Error('ledger_transaction_required');
  await collections.energyLedger(db).insertOne(entry, { session });
}
