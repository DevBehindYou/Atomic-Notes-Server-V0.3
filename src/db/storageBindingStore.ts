import type { Collection, Db, Document } from 'mongodb';
import {
  bindingFromLegacyGoogle, checkRecordInvariants, type BindingRecord, type BindingStore, type CasOutcome,
  type LegacyGoogleAccountRow, type LegacyMappingError,
} from '../lib/storageBinding.js';

// C29 persistence for the storage-binding state machine. INTEGRATION DISABLED: no route imports this module,
// and the Mongo store refuses every target except an explicitly passed disposable collection in a generated
// test database. It never touches users, google_accounts or any other production collection. Activation (a
// production collection, its indexes and a backfill) needs separate approval.

const DISPOSABLE_DATABASE = /^atomic_test_[a-f0-9]{20}$/;
const DISPOSABLE_COLLECTION = /^disposable_storage_bindings(_[a-z0-9]{1,32})?$/;
export const OWNER_INDEX_NAME = 'binding_owner_reserved_unique';

export function assertDisposableBindingTarget(target: { dbName: string; collectionName?: string }): void {
  if (!DISPOSABLE_DATABASE.test(target.dbName) || (target.collectionName !== undefined
    && !DISPOSABLE_COLLECTION.test(target.collectionName))) {
    throw new Error('binding_store_disposable_target_required');
  }
}

type BindingDoc = BindingRecord & { _id: string };

function fromDoc(doc: Document | null): BindingRecord | null {
  if (!doc) return null;
  const { _id, ...record } = doc;
  if (_id !== record.accountId || checkRecordInvariants(record).length > 0) throw new Error('binding_record_invalid');
  return record as BindingRecord;
}

function assertWritable(accountId: string, next: BindingRecord): void {
  if (next.accountId !== accountId || checkRecordInvariants(next).length > 0) throw new Error('binding_record_invalid');
}

const duplicateOwner = (error: unknown) => {
  const e = error as { code?: number; keyPattern?: Record<string, unknown>; message?: string };
  return e.code === 11000 && (Boolean(e.keyPattern?.ownerKey) || String(e.message ?? '').includes(OWNER_INDEX_NAME));
};

/** Creates the reservation constraints on the disposable collection: `_id` is the account, plus one reservation per owner identity. */
export async function ensureBindingStoreIndexes(collection: Collection<Document>): Promise<void> {
  assertDisposableBindingTarget(collection);
  await collection.createIndex({ ownerKey: 1 }, { name: OWNER_INDEX_NAME, unique: true, partialFilterExpression: { reserved: true } });
}

/** Mongo CAS store over ONE explicitly passed disposable collection. */
export function createMongoBindingStore(collection: Collection<Document>): BindingStore {
  assertDisposableBindingTarget(collection);
  const bindings = collection as unknown as Collection<BindingDoc>;
  return {
    async get(accountId) { return fromDoc(await bindings.findOne({ _id: accountId })); },
    async compareAndSet(accountId, expectedGeneration, next): Promise<CasOutcome> {
      assertWritable(accountId, next);
      const doc: BindingDoc = { _id: accountId, ...next };
      try {
        if (expectedGeneration === null) {
          await bindings.insertOne(doc);
          return 'ok';
        }
        const result = await bindings.replaceOne({ _id: accountId, generation: expectedGeneration }, doc);
        return result.matchedCount === 1 ? 'ok' : 'conflict';
      } catch (error) {
        if (duplicateOwner(error)) return 'identity_conflict';
        if ((error as { code?: number }).code === 11000) return 'conflict'; // a concurrent insert of the same account won
        throw error;
      }
    },
  };
}

/** In-memory store with the same CAS and owner-uniqueness semantics, for unit and property tests. */
export function createMemoryBindingStore(): BindingStore & { snapshot(): BindingRecord[]; writes: number } {
  const records = new Map<string, BindingRecord>();
  const store = {
    writes: 0,
    async get(accountId: string) {
      const record = records.get(accountId);
      return record ? structuredClone(record) : null;
    },
    async compareAndSet(accountId: string, expectedGeneration: number | null, next: BindingRecord): Promise<CasOutcome> {
      assertWritable(accountId, next);
      const current = records.get(accountId);
      if (expectedGeneration === null ? current !== undefined : current?.generation !== expectedGeneration) return 'conflict';
      if (next.reserved) {
        for (const [other, record] of records) {
          if (other !== accountId && record.reserved && record.ownerKey === next.ownerKey) return 'identity_conflict';
        }
      }
      records.set(accountId, structuredClone(next));
      store.writes++;
      return 'ok';
    },
    snapshot() { return [...records.values()].map(record => structuredClone(record)); },
  };
  return store;
}

export type LegacyBindingProjection = {
  bindings: BindingRecord[];
  refused: Record<LegacyMappingError | 'user_missing', number>;
};

/**
 * Read-only adapter: projects the current users/google_accounts rows into binding records without writing.
 * Only projected, non-secret fields are read (never the encrypted tokens). Restricted to a generated test database
 * while integration is disabled.
 */
export async function readLegacyGoogleBindings(db: Db, observedAt: number, limit = 10000): Promise<LegacyBindingProjection> {
  assertDisposableBindingTarget({ dbName: db.databaseName });
  const rows = await db.collection('google_accounts')
    .find({}, { projection: { _id: 0, userId: 1, googleAccountId: 1, driveRootFolderId: 1 } }).limit(limit + 1).toArray();
  if (rows.length > limit) throw new Error('legacy_binding_projection_too_large');
  const byUser = new Map<string, LegacyGoogleAccountRow[]>();
  for (const row of rows) {
    const key = JSON.stringify([typeof row.userId, String(row.userId)]);
    byUser.set(key, [...(byUser.get(key) ?? []), { userId: row.userId, googleAccountId: row.googleAccountId,
      driveRootFolderId: row.driveRootFolderId ?? null }]);
  }
  const userIds = [...byUser.values()].map(group => group[0].userId).filter((id): id is string => typeof id === 'string');
  const users = new Set((await db.collection('users').find({ _id: { $in: userIds as never[] } }, { projection: { _id: 1 } }).toArray())
    .map(user => String(user._id)));
  const refused: LegacyBindingProjection['refused'] = { invalid_account_id: 0, invalid_subject: 0, folder_invalid: 0,
    multiple_google_accounts: 0, user_missing: 0 };
  const bindings: BindingRecord[] = [];
  for (const key of [...byUser.keys()].sort()) {
    const group = byUser.get(key)!;
    const mapped = bindingFromLegacyGoogle(group, observedAt);
    if (!mapped.ok) { refused[mapped.error]++; continue; }
    if (!users.has(mapped.record.accountId)) { refused.user_missing++; continue; }
    bindings.push(mapped.record);
  }
  return { bindings, refused };
}
