import type { ClientSession, Db } from 'mongodb';
import { collections, type EnergyLedgerDoc, type AtomicUserDoc } from '../db/collections.js';
import { archiveLedgerBatch } from './ledgerRetention.js';
import { validateOrderedHistory } from './ledgerSequence.js';

/** Balance, sequence, history, statistics and trimming share the caller's commit/retry. */
export async function appendLedger(db: Db, session: ClientSession, entry: EnergyLedgerDoc, walletSnapshot?: AtomicUserDoc): Promise<void> {
  if (!session.inTransaction()) throw new Error('ledger_transaction_required');
  if (walletSnapshot && walletSnapshot._id !== entry.userId) throw new Error('ledger_wallet_owner_mismatch');
  // Real writers already read and mutate this wallet in their transaction. Migration contends on that same row.
  // Marked accounts reread the advancing high-water mark, including multiple expiry entries in one transaction.
  const wallet = walletSnapshot && walletSnapshot.historyRetentionVersion !== 1 ? walletSnapshot
    : await collections.atomicUsers(db).findOne({ _id: entry.userId }, { session });
  if (!wallet) throw new Error('ledger_wallet_missing');
  if (wallet.historyRetentionVersion !== 1) {
    if (entry.historySequence !== undefined) throw new Error('ledger_sequence_not_enabled');
    await collections.energyLedger(db).insertOne(entry, { session });
    return;
  }
  const rows = await collections.energyLedger(db).find({ userId: entry.userId }, { session }).limit(52).toArray();
  validateOrderedHistory(wallet, rows);
  if (rows.length > 50 || wallet.historySequence! >= Number.MAX_SAFE_INTEGER) throw new Error('ledger_sequence_invariant');
  const advanced = await collections.atomicUsers(db).findOneAndUpdate({ _id: entry.userId,
    historyRetentionVersion: 1, historySequence: wallet.historySequence }, { $inc: { historySequence: 1 } },
  { session, returnDocument: 'after' });
  if (!advanced) throw new Error('ledger_sequence_invariant');
  await collections.energyLedger(db).insertOne({ ...entry, historySequence: advanced.historySequence }, { session });
  await archiveLedgerBatch(db, entry.userId, session, Date.now());
}
