import type { ClientSession, Db, Document } from 'mongodb';
import { z } from 'zod';
import { atomicUserSchema, energyLedgerSchema } from './collections.js';
import { isLegacySyncRetentionIndex } from './syncRetention.js';

type Matches = { total: number; owned: number };
type Index = { name?: string; key: Record<string, unknown>; expireAfterSeconds?: number;
  partialFilterExpression?: unknown; unique?: boolean; sparse?: boolean; hidden?: boolean; collation?: unknown };
const lotSchema = z.object({ _id: z.string().min(1), userId: z.guid(), source: z.enum(['legacy', 'welcome', 'controller']),
  creditedAt: z.date(), expiresAt: z.date().nullable(), amount: z.number().int().nonnegative().safe(),
  remaining: z.number().int().nonnegative().safe(), operationId: z.string().min(1) })
  .refine(lot => lot.remaining <= lot.amount);
const receiptSchema = z.object({ _id: z.string().min(1), userId: z.guid(), requestId: z.string(), fingerprint: z.string(),
  createdAt: z.date(), allocations: z.array(z.object({ lotId: z.string().min(1), amount: z.number().int().positive().safe() })),
  result: atomicUserSchema });
const recordOf = (value: unknown): Record<string, unknown> => value && typeof value === 'object'
  ? value as Record<string, unknown> : {};
const nonemptyString = (value: unknown): value is string => typeof value === 'string' && value.length > 0;

/** Only stored references count. A legitimate no-op receipt may have no ledger or allocations. */
export function coinReceiptIssues(receipt: unknown, ownerExists: boolean, allocations: Matches): string[] {
  const issues: string[] = [];
  const parsed = receiptSchema.safeParse(receipt);
  if (!parsed.success || parsed.data.result._id !== parsed.data.userId) issues.push('malformed_receipt');
  if (!ownerExists) issues.push('orphan_receipt_owner');
  const stored = recordOf(receipt).allocations;
  const references = Array.isArray(stored)
    ? new Set(stored.map(allocation => recordOf(allocation).lotId).filter(nonemptyString)).size : 0;
  if (allocations.total < references) issues.push('missing_allocation_lot');
  if (allocations.owned < allocations.total) issues.push('foreign_allocation_lot');
  return issues;
}

export function coinLotIssues(lot: unknown, ownerExists: boolean, operation: Matches): string[] {
  const issues: string[] = [];
  const parsed = lotSchema.safeParse(lot);
  if (!parsed.success) issues.push('malformed_lot');
  if (!ownerExists) issues.push('orphan_lot_owner');
  const stored = recordOf(lot);
  if (stored.source === 'legacy' || stored.source === 'controller') issues.push('unclassified_source');
  if (nonemptyString(stored.operationId)) {
    // Opening migration and welcome balances deliberately have no coin_operations receipt.
    if (!operation.total && z.guid().safeParse(stored.userId).success && stored.operationId === `${stored.userId}:opening` &&
      (stored.source === 'legacy' || stored.source === 'welcome')) issues.push('opening_receipt_not_required');
    else {
      if (!operation.total) issues.push('missing_referenced_operation');
      else if (!operation.owned) issues.push('foreign_referenced_operation');
    }
  }
  return issues;
}

export function ledgerProvenanceIssues(row: unknown, operation: Matches, lots: Matches): string[] {
  const issues: string[] = [];
  if (!energyLedgerSchema.safeParse(row).success) issues.push('invalid_provenance_row');
  const record = row && typeof row === 'object' ? row as Record<string, unknown> : {};
  const hasOperation = typeof record.coinOperationId === 'string' && record.coinOperationId.length > 0;
  const lotIds = Array.isArray(record.lotIds) ? [...new Set(record.lotIds.filter(id => typeof id === 'string' && id.length))] : [];
  if (!hasOperation && lotIds.length === 0) issues.push('no_explicit_references');
  if (hasOperation) {
    if (!operation.total) issues.push('missing_referenced_operation');
    else if (!operation.owned) issues.push('foreign_referenced_operation');
  }
  if (lotIds.length > lots.total) issues.push('missing_referenced_lot');
  if (lots.owned < lots.total) issues.push('foreign_referenced_lot');
  return issues;
}

/** Catalog only. The one recognized legacy sync TTL is handled by the existing separate transition. */
export function monetaryTtlCounts(collection: string, indexes: readonly Index[]) {
  const ttl = indexes.filter(index => index.expireAfterSeconds !== undefined);
  const legacySyncTtlIndexes = ttl.filter(index => collection === 'sync_operations'
    && isLegacySyncRetentionIndex(collection, index)).length;
  return { ttlIndexes: ttl.length, legacySyncTtlIndexes, unexpectedTtlIndexes: ttl.length - legacySyncTtlIndexes };
}

// Each lookup emits at most one count document, never all matching records. All joins
// run in the cursor command rather than issuing a network query per owner/reference.
function referenceCounts(from: string, references: unknown, as: string): Document[] {
  const localField = `__provenance_${as}`;
  return [{ $set: { [localField]: references } },
    { $lookup: { from, localField, foreignField: '_id', let: { owner: '$userId' }, pipeline: [
    // Empty local arrays can match a null foreign key. Only sanitized string IDs
    // are references, even if an invalid foreign document has an _id of null.
    { $match: { _id: { $type: 'string', $ne: '' } } },
    { $group: { _id: null, total: { $sum: 1 }, owned: { $sum: { $cond: [{ $eq: ['$userId', '$$owner'] }, 1, 0] } } } },
    { $project: { _id: 0 } },
  ], as } }, { $unset: localField }];
}
const ownerLookup: Document = { $lookup: { from: 'atomic_users', localField: 'userId', foreignField: '_id',
  pipeline: [{ $limit: 1 }, { $project: { _id: 0, exists: { $literal: true } } }], as: 'owners' } };
const stringIds = (input: unknown): Document => ({ $filter: { input: { $cond: [{ $isArray: input }, input, []] },
  as: 'id', cond: { $and: [{ $eq: [{ $type: '$$id' }, 'string'] }, { $ne: ['$$id', ''] }] } } });
const operationIds = (field: string): Document => stringIds([field]);
const matchCounts = (counts: Matches[] | undefined): Matches => counts?.[0] ?? { total: 0, owned: 0 };
type Joined = Document & { operationCounts?: Matches[]; lotCounts?: Matches[]; owners?: { exists: boolean }[] };

/** Streaming, count-only audit inside the caller's snapshot. No historical links are inferred. */
export async function inspectLedgerProvenance(db: Db, session: ClientSession) {
  if (!session.inTransaction()) throw new Error('ledger_transaction_required');
  const result = { retainedRowsWithExplicitReferences: 0, retainedRowsWithoutExplicitReferences: 0,
    invalidProvenanceRows: 0, missingReferencedOperations: 0, foreignReferencedOperations: 0,
    missingReferencedLots: 0, foreignReferencedLots: 0, coinReceipts: 0, malformedCoinReceipts: 0,
    orphanCoinReceiptOwners: 0, missingAllocationLots: 0, foreignAllocationLots: 0,
    coinLots: 0, malformedCoinLots: 0, orphanCoinLotOwners: 0, unclassifiedCoinLotSources: 0,
    openingLotsWithoutReceipt: 0, missingLotOperations: 0, foreignLotOperations: 0,
    scalarLotMismatchAccounts: 0, archivedAggregateRows: 0,
    archivedDailyGrants: 0, archivedConverts: 0, archivedSpends: 0, archivedPurchases: 0, archivedAdminAdjusts: 0 };
  const count = (issues: string[], issue: string, field: keyof typeof result) => { if (issues.includes(issue)) result[field]++; };
  const rows = db.collection('energy_ledger').aggregate<Joined>([
    ...referenceCounts('coin_operations', operationIds('$coinOperationId'), 'operationCounts'),
    ...referenceCounts('coin_lots', stringIds('$lotIds'), 'lotCounts'),
  ], { session, batchSize: 100 });
  try { for await (const row of rows) {
    const issues = ledgerProvenanceIssues(row, matchCounts(row.operationCounts), matchCounts(row.lotCounts));
    result[issues.includes('no_explicit_references') ? 'retainedRowsWithoutExplicitReferences' : 'retainedRowsWithExplicitReferences']++;
    count(issues, 'invalid_provenance_row', 'invalidProvenanceRows');
    count(issues, 'missing_referenced_operation', 'missingReferencedOperations');
    count(issues, 'foreign_referenced_operation', 'foreignReferencedOperations');
    count(issues, 'missing_referenced_lot', 'missingReferencedLots');
    count(issues, 'foreign_referenced_lot', 'foreignReferencedLots');
  } } finally { await rows.close(); }
  const receipts = db.collection('coin_operations').aggregate<Joined>([
    ...referenceCounts('coin_lots', stringIds({ $map: { input: { $cond: [{ $isArray: '$allocations' }, '$allocations', []] },
      as: 'allocation', in: '$$allocation.lotId' } }), 'lotCounts'), ownerLookup,
  ], { session, batchSize: 100 });
  try { for await (const receipt of receipts) {
    result.coinReceipts++;
    const issues = coinReceiptIssues(receipt, !!receipt.owners?.length, matchCounts(receipt.lotCounts));
    count(issues, 'malformed_receipt', 'malformedCoinReceipts');
    count(issues, 'orphan_receipt_owner', 'orphanCoinReceiptOwners');
    count(issues, 'missing_allocation_lot', 'missingAllocationLots');
    count(issues, 'foreign_allocation_lot', 'foreignAllocationLots');
  } } finally { await receipts.close(); }
  const lots = db.collection('coin_lots').aggregate<Joined>([
    ...referenceCounts('coin_operations', operationIds('$operationId'), 'operationCounts'), ownerLookup,
  ], { session, batchSize: 100 });
  try { for await (const lot of lots) {
    result.coinLots++;
    const issues = coinLotIssues(lot, !!lot.owners?.length, matchCounts(lot.operationCounts));
    count(issues, 'malformed_lot', 'malformedCoinLots');
    count(issues, 'orphan_lot_owner', 'orphanCoinLotOwners');
    count(issues, 'unclassified_source', 'unclassifiedCoinLotSources');
    count(issues, 'opening_receipt_not_required', 'openingLotsWithoutReceipt');
    count(issues, 'missing_referenced_operation', 'missingLotOperations');
    count(issues, 'foreign_referenced_operation', 'foreignLotOperations');
  } } finally { await lots.close(); }
  const wallets = db.collection('atomic_users').aggregate<Document & { totals: { sum: number; invalid: number }[] }>([
    { $match: { coinLotsVersion: 1 } }, { $project: { _id: 1, coins: 1 } },
    { $lookup: { from: 'coin_lots', localField: '_id', foreignField: 'userId', pipeline: [
      { $group: { _id: null, sum: { $sum: { $cond: [{ $isNumber: '$remaining' }, '$remaining', 0] } },
        invalid: { $sum: { $cond: [{ $and: [{ $isNumber: '$remaining' }, { $gte: ['$remaining', 0] }] }, 0, 1] } } } },
      { $project: { _id: 0 } },
    ], as: 'totals' } },
  ], { session, batchSize: 100 });
  try { for await (const wallet of wallets) {
    const totals = wallet.totals;
    if (!(totals[0]?.invalid ?? 0) && (totals[0]?.sum ?? 0) !== wallet.coins)
      result.scalarLotMismatchAccounts++;
  } } finally { await wallets.close(); }
  const archives = db.collection('ledger_history_archives').find({}, { session, batchSize: 100,
    projection: { byKind: 1 } });
  const kinds = { daily_grant: 'archivedDailyGrants', convert: 'archivedConverts', spend: 'archivedSpends',
    purchase: 'archivedPurchases', admin_adjust: 'archivedAdminAdjusts' } as const;
  try { for await (const archive of archives) {
    result.archivedAggregateRows++;
    if (archive.byKind && typeof archive.byKind === 'object') for (const [kind, field] of Object.entries(kinds)) {
      const value = (archive.byKind as Record<string, unknown>)[kind];
      if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) result[field] += value;
    }
  } } finally { await archives.close(); }
  return result;
}

export async function inspectMonetaryTtl(db: Db) {
  const result = { monetaryTtlIndexes: 0, legacySyncTtlIndexes: 0, unexpectedMonetaryTtlIndexes: 0 };
  for (const name of ['energy_ledger', 'coin_operations', 'coin_lots', 'sync_operations']) {
    if (!(await db.listCollections({ name }, { nameOnly: true }).hasNext())) continue;
    const counts = monetaryTtlCounts(name, await db.collection(name).indexes());
    result.monetaryTtlIndexes += counts.ttlIndexes;
    result.legacySyncTtlIndexes += counts.legacySyncTtlIndexes;
    result.unexpectedMonetaryTtlIndexes += counts.unexpectedTtlIndexes;
  }
  return result;
}
