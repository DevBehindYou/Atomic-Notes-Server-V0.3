import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import type { Document } from 'mongodb';

const uri = process.env.MONGODB_URI;
if (!uri || !/^mongodb:\/\/(127\.0\.0\.1|localhost):\d+(?:[/?]|$)/.test(uri))
  throw new Error('Provenance integration test requires a disposable localhost replica set');
const databaseName = `atomic_test_${randomUUID().replaceAll('-', '').slice(0, 20)}`;
process.env.MONGODB_DB_NAME = databaseName;
const { getDb, closeDb } = await import('../src/db/mongo');
const { inspectLedgerRetention } = await import('../src/db/ledgerRetentionInspection');
const { mongoCommands } = await import('../src/lib/perf');

test('read-only provenance report counts only explicit surviving links and catalog TTLs', { timeout: 90000 }, async () => {
  const db = await getDb();
  let ownsDatabase = false;
  try {
    const emptyNames = await db.listCollections({}, { nameOnly: true }).toArray();
    assert.deepEqual(emptyNames, [], 'refuse a database namespace collision');
    ownsDatabase = true;
    const empty = await inspectLedgerRetention(db);
    assert.equal(empty.coinReceipts, 0);
    assert.equal(empty.coinLots, 0);
    assert.equal(empty.retainedRowsWithoutExplicitReferences, 0);
    assert.equal(empty.monetaryTtlIndexes, 0);
    assert.deepEqual(await db.listCollections({}, { nameOnly: true }).toArray(), emptyNames,
      'missing collections must not be auto-created');

    const owner = randomUUID(), other = randomUUID(), emptyOwner = randomUUID(), at = new Date();
    const wallets = db.collection('atomic_users');
    await wallets.insertMany([{ _id: owner, coins: 5, energy: 0, coinLotsVersion: 1, createdAt: at },
      { _id: other, coins: 1, energy: 0, coinLotsVersion: 1, createdAt: at },
      { _id: emptyOwner, coins: 0, energy: 0, coinLotsVersion: 1, createdAt: at }] as never[]);
    const receiptId = `${owner}:valid`, noOpId = `${owner}:noop`, foreignReceipt = `${other}:foreign`;
    const ownedLot = 'owned-lot', foreignLot = 'foreign-lot';
    const receipts = db.collection('coin_operations');
    const receipt = (_id: string, userId: string, allocations: unknown[]) => ({ _id, userId,
      requestId: 'fixture', fingerprint: 'private-fingerprint', allocations,
      result: { _id: userId, coins: 5, energy: 0, createdAt: at }, createdAt: at });
    await receipts.insertMany([receipt(receiptId, owner, [{ lotId: ownedLot, amount: 1 }]),
      receipt(noOpId, owner, []), receipt(foreignReceipt, other, [{ lotId: ownedLot, amount: 1 }]),
      receipt(`${owner}:broken`, owner, [{ lotId: 'private-missing-lot', amount: 1 }])] as never[]);
    const lots = db.collection('coin_lots');
    await lots.insertMany([
      { _id: ownedLot, userId: owner, source: 'controller', amount: 5, remaining: 5,
        creditedAt: at, expiresAt: null, operationId: receiptId },
      { _id: foreignLot, userId: other, source: 'welcome', amount: 1, remaining: 1,
        creditedAt: at, expiresAt: null, operationId: `${other}:opening` },
      { _id: `${owner}:opening`, userId: owner, source: 'legacy', amount: 0, remaining: 0,
        creditedAt: at, expiresAt: null, operationId: `${owner}:opening` },
    ] as never[]);
    const row = (extras: Record<string, unknown>) => ({ _id: randomUUID(), userId: owner,
      kind: 'admin_adjust', coinsDelta: 0, energyDelta: 0, resultingCoins: 5,
      resultingEnergy: 0, note: 'private financial note', createdAt: at, ...extras });
    await db.collection('energy_ledger').insertMany([row({ coinOperationId: receiptId, lotIds: [ownedLot] }),
      row({ coinOperationId: 'private-missing-receipt', lotIds: [foreignLot] }), row({})] as never[]);
    await db.collection('ledger_history_archives').insertOne({ _id: owner, projectedAt: at.getTime(),
      byKind: { spend: 4, purchase: 2 } } as never);
    await db.collection('sync_operations').createIndex({ createdAt: 1 },
      { expireAfterSeconds: 30 * 86400 });
    await db.collection('energy_ledger').createIndex({ createdAt: 1 },
      { expireAfterSeconds: 86400 });

    const names = await db.listCollections({}, { nameOnly: true }).toArray();
    const before = await Promise.all(['atomic_users', 'coin_operations', 'coin_lots', 'energy_ledger',
      'ledger_history_archives'].map(name => db.collection(name).find({}).sort({ _id: 1 }).toArray()));
    const indexes = await Promise.all(['sync_operations', 'energy_ledger'].map(name => db.collection(name).indexes()));
    // Capture the real inspector pipelines for executionStats checks below, rather
    // than explain a test-only approximation of the production reference joins.
    const referencePipelines = new Map<string, Document[]>();
    const inspectedDb = new Proxy(db, { get(target, property) {
      if (property === 'collection') return (name: string) => {
        const collection = target.collection(name);
        return new Proxy(collection, { get(inner, method) {
          if (method === 'aggregate') return (pipeline: Document[], options: Document) => {
            if (pipeline.some(stage => stage.$lookup?.as === 'operationCounts' || stage.$lookup?.as === 'lotCounts'))
              referencePipelines.set(name, structuredClone(pipeline));
            return inner.aggregate(pipeline, options);
          };
          const value = Reflect.get(inner, method);
          return typeof value === 'function' ? value.bind(inner) : value;
        } });
      };
      const value = Reflect.get(target, property);
      return typeof value === 'function' ? value.bind(target) : value;
    } });
    const report = await inspectLedgerRetention(inspectedDb);
    assert.equal(report.retainedRowsWithExplicitReferences, 2);
    assert.equal(report.retainedRowsWithoutExplicitReferences, 1);
    assert.equal(report.missingReferencedOperations, 1);
    assert.equal(report.foreignReferencedLots, 1);
    assert.equal(report.coinReceipts, 4, 'a no-op receipt has no ledger row and is still valid');
    assert.equal(report.malformedCoinReceipts, 0);
    assert.equal(report.missingAllocationLots, 1);
    assert.equal(report.foreignAllocationLots, 1);
    assert.equal(report.unclassifiedCoinLotSources, 2);
    assert.equal(report.openingLotsWithoutReceipt, 2);
    assert.equal(report.missingLotOperations, 0);
    assert.equal(report.scalarLotMismatchAccounts, 0);
    assert.equal(report.archivedAggregateRows, 1);
    assert.equal(report.archivedSpends, 4);
    assert.equal(report.archivedPurchases, 2);
    assert.equal(report.monetaryTtlIndexes, 2);
    assert.equal(report.legacySyncTtlIndexes, 1);
    assert.equal(report.unexpectedMonetaryTtlIndexes, 1);
    assert.equal(report.activationReady, false);
    for (const blocker of ['broken_explicit_provenance_requires_review', 'coin_source_classification_requires_review',
      'historical_provenance_incomplete', 'legacy_sync_ttl_requires_separate_transition',
      'unexpected_monetary_ttl_requires_review']) assert.ok(report.blockers.includes(blocker));
    const printed = JSON.stringify(report);
    for (const secret of [owner, other, emptyOwner, receiptId, noOpId, foreignReceipt, ownedLot, foreignLot,
      'private financial note', 'private-fingerprint', databaseName]) assert.equal(printed.includes(secret), false);
    assert.deepEqual(await db.listCollections({}, { nameOnly: true }).toArray(), names);
    assert.deepEqual(await Promise.all(['atomic_users', 'coin_operations', 'coin_lots', 'energy_ledger',
      'ledger_history_archives'].map(name => db.collection(name).find({}).sort({ _id: 1 }).toArray())), before);
    assert.deepEqual(await Promise.all(['sync_operations', 'energy_ledger'].map(name => db.collection(name).indexes())), indexes);

    await receipts.insertOne({ ...receipt(`${owner}:malformed`, owner, []), allocations: 'private malformed value' } as never);
    await lots.insertMany([{ _id: 'private-malformed-lot', userId: owner, source: 'controller', amount: 1,
      remaining: 2, creditedAt: at, expiresAt: null, operationId: 'private-missing-receipt' },
    { _id: 'private-foreign-operation-lot', userId: owner, source: 'controller', amount: -1,
      remaining: 0, creditedAt: at, expiresAt: null, operationId: foreignReceipt }] as never[]);
    await wallets.updateOne({ _id: owner } as never, { $set: { coins: 99 } });
    const damaged = await inspectLedgerRetention(db);
    assert.equal(damaged.malformedCoinReceipts, 1);
    assert.equal(damaged.malformedCoinLots, 2);
    assert.equal(damaged.missingLotOperations, 1, 'malformed amount does not hide an explicit missing operation');
    assert.equal(damaged.foreignLotOperations, 1);
    assert.equal(damaged.scalarLotMismatchAccounts, 1);
    assert.ok(damaged.blockers.includes('coin_record_integrity_requires_review'));
    assert.ok(damaged.blockers.includes('coin_scalar_lot_mismatch_requires_review'));
    assert.equal(JSON.stringify(damaged).includes('private malformed value'), false);

    await db.collection('energy_ledger').deleteMany({});
    const archiveOnly = await inspectLedgerRetention(db);
    assert.equal(archiveOnly.retainedRowsWithExplicitReferences, 0);
    assert.equal(archiveOnly.retainedRowsWithoutExplicitReferences, 0);
    assert.equal(archiveOnly.archivedPurchases, 2);
    assert.equal(archiveOnly.archivedSpends, 4);
    assert.ok(archiveOnly.blockers.includes('historical_provenance_incomplete'));

    // More than two cursor batches must not turn into one network query per receipt.
    await receipts.insertMany(Array.from({ length: 205 }, (_, index) => receipt(`${owner}:noop-${index}`, owner, [])) as never[]);
    await receipts.insertOne({ ...receipt(`${owner}:bad-items`, owner, []), allocations: [null, 1, {}, { lotId: 1 }] } as never);
    await db.collection('energy_ledger').insertMany([
      row({ coinOperationId: foreignReceipt, lotIds: ['private-missing-lot'] }),
      row({ lotIds: [ownedLot, ownedLot] }), row({ lotIds: [null, {}, 1] }),
    ] as never[]);
    const commandsBefore = mongoCommands.started;
    const streamed = await inspectLedgerRetention(db);
    assert.ok(mongoCommands.started - commandsBefore < 100, 'inspection uses aggregation cursors, not per-reference commands');
    assert.equal(streamed.coinReceipts, 211);
    assert.equal(streamed.malformedCoinReceipts, 2);
    assert.equal(streamed.foreignReferencedOperations, 1);
    assert.equal(streamed.missingReferencedLots, 1, 'duplicate owned references are not missing records');
    assert.equal(streamed.invalidProvenanceRows, 1);
    assert.equal(streamed.retainedRowsWithoutExplicitReferences, 1);

    const causalReceiptId = `${owner}:malformed-links`;
    await receipts.insertOne({ ...receipt(causalReceiptId, owner, [
      { lotId: 'private-missing-lot', amount: 'invalid' }, { lotId: foreignLot, amount: 1 },
    ]), result: null } as never);
    const malformedLinks = await inspectLedgerRetention(db);
    assert.equal(malformedLinks.malformedCoinReceipts, streamed.malformedCoinReceipts + 1);
    assert.equal(malformedLinks.missingAllocationLots, streamed.missingAllocationLots + 1);
    assert.equal(malformedLinks.foreignAllocationLots, streamed.foreignAllocationLots + 1);
    await receipts.replaceOne({ _id: causalReceiptId } as never, receipt(causalReceiptId, owner, [
      { lotId: 'private-missing-lot', amount: 1 }, { lotId: foreignLot, amount: 1 },
    ]) as never);
    const repairedShape = await inspectLedgerRetention(db);
    assert.equal(repairedShape.malformedCoinReceipts, streamed.malformedCoinReceipts);
    assert.equal(repairedShape.missingAllocationLots, malformedLinks.missingAllocationLots);
    assert.equal(repairedShape.foreignAllocationLots, malformedLinks.foreignAllocationLots);
    await receipts.replaceOne({ _id: causalReceiptId } as never,
      receipt(causalReceiptId, owner, [{ lotId: ownedLot, amount: 1 }]) as never);
    const repairedReferences = await inspectLedgerRetention(db);
    assert.equal(repairedReferences.missingAllocationLots, streamed.missingAllocationLots);
    assert.equal(repairedReferences.foreignAllocationLots, streamed.foreignAllocationLots);
    await lots.updateOne({ _id: 'private-foreign-operation-lot' } as never, { $set: { amount: 0 } });
    const repairedLotShape = await inspectLedgerRetention(db);
    assert.equal(repairedLotShape.malformedCoinLots, repairedReferences.malformedCoinLots - 1);
    assert.equal(repairedLotShape.foreignLotOperations, repairedReferences.foreignLotOperations);
    await lots.updateOne({ _id: 'private-foreign-operation-lot' } as never, { $set: { operationId: receiptId } });
    const repairedLotReference = await inspectLedgerRetention(db);
    assert.equal(repairedLotReference.foreignLotOperations, repairedLotShape.foreignLotOperations - 1);

    assert.equal(referencePipelines.size, 3, 'capture all three actual reference-scan pipelines');
    const sourceIds = new Map<string, string[]>(['energy_ledger', 'coin_operations', 'coin_lots'].map(name => [name, []]));
    const addJoinFixtures = async (start: number, end: number) => {
      for (let index = start; index < end; index++) {
        const id = `indexed-reference-source-${index}`;
        for (const ids of sourceIds.values()) ids.push(id);
        await db.collection('energy_ledger').insertOne(row({ _id: id, coinOperationId: receiptId, lotIds: [ownedLot] }) as never);
        await receipts.insertOne(receipt(id, owner, [{ lotId: ownedLot, amount: 1 }]) as never);
        await lots.insertOne({ _id: id, userId: owner, source: 'controller', amount: 0, remaining: 0,
          creditedAt: at, expiresAt: null, operationId: receiptId } as never);
      }
    };
    const addForeignDecoys = async (start: number, end: number) => {
      await receipts.insertMany(Array.from({ length: end - start }, (_, offset) =>
        receipt(`indexed-reference-decoy-${start + offset}`, other, [])) as never[]);
      await lots.insertMany(Array.from({ length: end - start }, (_, offset) => ({
        _id: `indexed-reference-decoy-${start + offset}`, userId: other, source: 'controller', amount: 0,
        remaining: 0, creditedAt: at, expiresAt: null, operationId: foreignReceipt,
      })) as never[]);
    };
    const explainReferences = async () => {
      const examined = new Map<string, number>();
      for (const [name, pipeline] of referencePipelines) {
        const ids = sourceIds.get(name)!;
        const plan = await db.collection(name).aggregate([
          { $match: { _id: { $in: ids } } }, ...pipeline,
        ]).explain('executionStats');
        const stages = (plan.stages as Document[] | undefined)?.filter(stage =>
          stage.$lookup?.as === 'operationCounts' || stage.$lookup?.as === 'lotCounts') ?? [];
        assert.equal(stages.length, name === 'energy_ledger' ? 2 : 1, 'MongoDB 7 must expose every reference lookup');
        for (const stage of stages) {
          assert.equal(stage.collectionScans, 0, 'reference joins must not scan the foreign collection per source record');
          assert.ok(Array.isArray(stage.indexesUsed) && stage.indexesUsed.includes('_id_'), 'reference joins use the foreign _id index');
          assert.ok(stage.totalDocsExamined > 0 && stage.totalDocsExamined <= ids.length * 2,
            'examined foreign documents follow matched references, not collection size');
          assert.ok(stage.totalKeysExamined > 0 && stage.totalKeysExamined <= ids.length * 4,
            'index work stays bounded by reference count');
          examined.set(`${name}:${stage.$lookup.as}`, stage.totalDocsExamined);
        }
      }
      return examined;
    };
    await addJoinFixtures(0, 24);
    await addForeignDecoys(0, 200);
    const smaller = await explainReferences();
    await addJoinFixtures(24, 48);
    await addForeignDecoys(200, 1600);
    const larger = await explainReferences();
    for (const [lookup, documents] of smaller) assert.ok(larger.get(lookup)! <= documents * 3,
      'doubling source references while greatly expanding unrelated foreign data must not cause quadratic document scans');
  } finally {
    assert.equal(db.databaseName, databaseName);
    if (ownsDatabase) await db.dropDatabase();
    await closeDb();
  }
});
