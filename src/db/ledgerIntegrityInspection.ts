import type { ClientSession, Db } from 'mongodb';
import { z } from 'zod';
import { energyLedgerSchema } from './collections.js';

type WalletOrder = { _id: unknown; historyRetentionVersion?: unknown; historySequence?: unknown };
type RowOrder = { userId?: unknown; historySequence?: unknown };
const ownerId = z.string().uuid();

/** Diagnostic only. No values or validation errors are returned. Rows are a bounded 51-row marked-owner sample. */
export function ledgerWalletIssues(wallet: WalletOrder, rows: readonly RowOrder[]): string[] {
  const issues: string[] = [];
  if (!ownerId.safeParse(wallet._id).success) issues.push('invalid_wallet_identity');
  if (wallet.historyRetentionVersion !== 1) {
    if (wallet.historyRetentionVersion !== undefined || wallet.historySequence !== undefined) issues.push('partial_wallet_metadata');
    return issues;
  }
  if (rows.length > 50) issues.push('ordered_history_over_limit');
  const counter = wallet.historySequence;
  let invalid = typeof counter !== 'number' || !Number.isSafeInteger(counter) || counter < 0;
  const seen = new Set<number>();
  for (const row of rows) {
    const sequence = row.historySequence;
    if (row.userId !== wallet._id || typeof sequence !== 'number' || !Number.isSafeInteger(sequence)
      || sequence <= 0 || typeof counter !== 'number' || sequence > counter || seen.has(sequence)) invalid = true;
    if (typeof sequence === 'number') seen.add(sequence);
  }
  if (rows.length === 0 && counter !== 0) invalid = true;
  if (typeof counter === 'number') for (let index = 0; index < rows.length; index++) {
    if (!seen.has(counter - index)) invalid = true;
  }
  if (invalid) issues.push('invalid_ordered_history');
  return issues;
}

/** Same caller snapshot as totals. Streaming records and bounded lookups avoid materializing full owner histories. */
export async function inspectLedgerIntegrity(db: Db, session: ClientSession) {
  if (!session.inTransaction()) throw new Error('ledger_transaction_required');
  const result = { walletAccounts: 0, orderedAccounts: 0, invalidWalletIdentities: 0, partialWalletAccounts: 0,
    invalidOrderedAccounts: 0, overLimitOrderedAccounts: 0, malformedRows: 0, orphanRows: 0, sequencedUnmarkedRows: 0 };
  const wallets = db.collection('atomic_users').aggregate<WalletOrder & { rows: RowOrder[] }>([
    { $project: { _id: 1, historyRetentionVersion: 1, historySequence: 1 } },
    { $lookup: { from: 'energy_ledger', let: { owner: '$_id', marked: '$historyRetentionVersion' }, pipeline: [
      { $match: { $expr: { $and: [{ $eq: ['$userId', '$$owner'] }, { $eq: ['$$marked', 1] }] } } },
      { $limit: 51 }, { $project: { _id: 0, userId: 1, historySequence: 1 } },
    ], as: 'rows' } },
  ], { session, batchSize: 100 });
  try {
    for await (const wallet of wallets) {
      result.walletAccounts++;
      if (wallet.historyRetentionVersion === 1) result.orderedAccounts++;
      const issues = ledgerWalletIssues(wallet, wallet.rows);
      if (issues.includes('invalid_wallet_identity')) result.invalidWalletIdentities++;
      if (issues.includes('partial_wallet_metadata')) result.partialWalletAccounts++;
      if (issues.includes('invalid_ordered_history')) result.invalidOrderedAccounts++;
      if (issues.includes('ordered_history_over_limit')) result.overLimitOrderedAccounts++;
    }
  } finally { await wallets.close(); }
  const rows = db.collection('energy_ledger').aggregate<{
    historySequence?: unknown; wallets: { historyRetentionVersion?: unknown }[];
  }>([{ $lookup: { from: 'atomic_users', localField: 'userId', foreignField: '_id',
    pipeline: [{ $project: { _id: 0, historyRetentionVersion: 1 } }], as: 'wallets' } }], { session, batchSize: 100 });
  try {
    for await (const row of rows) {
      if (!energyLedgerSchema.safeParse(row).success) result.malformedRows++;
      if (!row.wallets.length) result.orphanRows++;
      else if (row.historySequence !== undefined && row.wallets[0].historyRetentionVersion !== 1) result.sequencedUnmarkedRows++;
    }
  } finally { await rows.close(); }
  return result;
}
