import type { ClientSession, Db } from 'mongodb';
import { collections, energyLedgerSchema, type AtomicUserDoc, type EnergyLedgerDoc } from '../db/collections.js';

export function validateOrderedHistory(wallet: AtomicUserDoc, rows: readonly EnergyLedgerDoc[]): void {
  if (!Number.isSafeInteger(wallet.historySequence) || wallet.historySequence! < 0 || rows.length > 51) {
    throw new Error('ledger_sequence_invariant');
  }
  const seen = new Set<number>();
  for (const row of rows) {
    if (row.userId !== wallet._id || !Number.isSafeInteger(row.historySequence) || row.historySequence! <= 0
      || row.historySequence! > wallet.historySequence! || seen.has(row.historySequence!)) throw new Error('ledger_sequence_invariant');
    seen.add(row.historySequence!);
  }
}

/** Operator primitive only; no route/command calls it. Caller must own the migration transaction. */
export async function initializeLedgerSequence(db: Db, userId: string, session: ClientSession): Promise<void> {
  if (!session.inTransaction()) throw new Error('ledger_transaction_required');
  const wallet = await collections.atomicUsers(db).findOneAndUpdate({ _id: userId },
    { $inc: { historyRevision: 1 } }, { session, returnDocument: 'after' });
  if (!wallet) throw new Error('ledger_wallet_missing');
  const rows = await collections.energyLedger(db).find({ userId }, { session })
    .sort({ createdAt: 1, _id: 1 }).limit(51).toArray();
  if (rows.length > 50) throw new Error('ledger_history_migration_required');
  if (wallet.historyRetentionVersion === 1) {
    validateOrderedHistory(wallet, rows);
    return;
  }
  for (const row of rows) {
    energyLedgerSchema.parse(row);
    if (row.historySequence !== undefined) throw new Error('ledger_partial_sequence_migration');
  }
  for (const [index, row] of rows.entries()) {
    await collections.energyLedger(db).updateOne({ _id: row._id, userId },
      { $set: { historySequence: index + 1 } }, { session });
  }
  await collections.atomicUsers(db).updateOne({ _id: userId },
    { $set: { historyRetentionVersion: 1, historySequence: rows.length } }, { session });
}
