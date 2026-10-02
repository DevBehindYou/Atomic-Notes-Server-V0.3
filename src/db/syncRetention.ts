import { isDeepStrictEqual } from 'node:util';
import type { Db } from 'mongodb';

const targets = [
  { collection: 'notes', name: 'tombstone_ttl', key: { updatedAt: 1 }, partial: { deleted: true } },
  { collection: 'sync_operations', name: 'createdAt_1', key: { createdAt: 1 }, partial: undefined },
] as const;
const oldTtlSeconds = 30 * 24 * 60 * 60;
export type RetentionPlan = { database: string; drops: { collection: string; name: string }[] };

/** Read-only preflight of both collections. Unexpected TTL configuration requires review. */
export async function inspectSyncRetention(db: Db): Promise<RetentionPlan> {
  const drops: RetentionPlan['drops'] = [];
  for (const target of targets) {
    // Missing collections are a no-op; inspection must not create them.
    if (!(await db.listCollections({ name: target.collection }, { nameOnly: true }).hasNext())) continue;
    for (const index of await db.collection(target.collection).indexes()) {
      if (index.expireAfterSeconds === undefined) continue;
      if (index.name !== target.name || !isDeepStrictEqual(index.key, target.key)
        || index.expireAfterSeconds !== oldTtlSeconds
        || !isDeepStrictEqual(index.partialFilterExpression, target.partial)
        || index.unique || index.sparse || index.hidden || index.collation) {
        throw new Error('sync_retention_index_drift');
      }
      drops.push({ collection: target.collection, name: target.name });
    }
  }
  return { database: db.databaseName, drops };
}

/** Operator-only transition; never called by startup, requests or general index setup. */
export async function applySyncRetention(db: Db, expectedDatabase: string): Promise<RetentionPlan> {
  if (!expectedDatabase || db.databaseName !== expectedDatabase) throw new Error('sync_retention_database_mismatch');
  // Validate every target before dropping any index. Index DDL is not transactional;
  // the operator must prevent concurrent index changes and may safely rerun after failure.
  const plan = await inspectSyncRetention(db);
  for (const target of plan.drops) {
    // Recheck all remaining TTL definitions to catch drift since the initial preflight.
    const current = await inspectSyncRetention(db);
    if (current.drops.some((i) => i.collection === target.collection && i.name === target.name)) {
      await db.collection(target.collection).dropIndex(target.name);
    }
  }
  if ((await inspectSyncRetention(db)).drops.length !== 0) throw new Error('sync_retention_incomplete');
  return plan;
}

export function retentionArguments(args: string[]): { apply: boolean; database?: string } {
  if (args.length === 0) return { apply: false };
  if (args.length === 3 && args[0] === '--apply' && args[1] === '--database'
    && args[2].trim() && !args[2].startsWith('-')) {
    return { apply: true, database: args[2] };
  }
  throw new Error('usage: db:retain-sync-history [--apply --database <exact-database-name>]');
}
