import { createHash } from 'node:crypto';
import type { Db } from 'mongodb';
import { withTransaction } from '../src/db/mongo.js';
import { archiveLedgerBatch } from '../src/lib/ledgerRetention.js';
import { initializeLedgerSequence } from '../src/lib/ledgerSequence.js';

type Progress = { _id: string; fingerprint: string; accountOffset: number; batches: number; removed: number };

/** Disposable-only rehearsal. Not compiled into the deployed server and not an operator command. */
export async function rehearseLedgerMigration(db: Db, options: {
  expectedDatabase: string; runId: string; users: string[]; asOf: number; batchBudget: number;
  initializeSequences?: boolean;
  afterCommit?: () => Promise<void>;
}) {
  if (!/^atomic_test_[0-9a-f]{20}$/.test(options.expectedDatabase) || db.databaseName !== options.expectedDatabase) {
    throw new Error('migration_rehearsal_database_mismatch');
  }
  if (!options.runId || !Number.isSafeInteger(options.asOf) || !Number.isInteger(options.batchBudget)
    || options.batchBudget < 1 || options.batchBudget > 10 || options.users.length > 5
    || new Set(options.users).size !== options.users.length) throw new Error('invalid_migration_rehearsal');
  if (options.initializeSequences !== undefined && typeof options.initializeSequences !== 'boolean') throw new Error('invalid_migration_rehearsal');
  const fingerprint = createHash('sha256').update(JSON.stringify({ users: options.users, asOf: options.asOf,
    limit: 50, initializeSequences: options.initializeSequences ?? false })).digest('hex');
  const checkpoints = db.collection<Progress>('test_ledger_migration_progress');
  await checkpoints.updateOne({ _id: options.runId }, { $setOnInsert: {
    fingerprint, accountOffset: 0, batches: 0, removed: 0,
  } }, { upsert: true });
  for (let i = 0; i < options.batchBudget; i++) {
    const finished = await withTransaction(async session => {
      const progress = (await checkpoints.findOne({ _id: options.runId }, { session }))!;
      if (progress.fingerprint !== fingerprint) throw new Error('migration_rehearsal_plan_mismatch');
      if (progress.accountOffset >= options.users.length) return true;
      const removed = await archiveLedgerBatch(db, options.users[progress.accountOffset], session, options.asOf);
      if (removed < 100 && options.initializeSequences) {
        await initializeLedgerSequence(db, options.users[progress.accountOffset], session);
      }
      await checkpoints.updateOne({ _id: options.runId }, { $inc: {
        batches: 1, removed, accountOffset: removed < 100 ? 1 : 0,
      } }, { session });
      return false;
    });
    if (finished) break;
    await options.afterCommit?.();
  }
  const progress = (await checkpoints.findOne({ _id: options.runId }))!;
  if (progress.fingerprint !== fingerprint) throw new Error('migration_rehearsal_plan_mismatch');
  return { completed: progress.accountOffset >= options.users.length, batches: progress.batches, removed: progress.removed };
}
