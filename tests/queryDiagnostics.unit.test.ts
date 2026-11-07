import assert from 'node:assert/strict';
import test from 'node:test';
import {
  assertSanitized, assertUriAllowed, classify, commandViolation, describeFilter, examinedBudget, explainArguments,
  querySpecs, summarizeExplain, uriHosts, usesIndex, type ExplainSummary,
} from '../src/db/queryDiagnostics.js';
import { candidateIndexes, fixtureId } from '../src/db/queryDiagnosticsFixture.js';

const classicSort = {
  queryPlanner: { winningPlan: { stage: 'SORT', inputStage: { stage: 'FETCH',
    inputStage: { stage: 'IXSCAN', indexName: 'userId_1_syncSequence_1', keyPattern: { userId: 1, syncSequence: 1 } } } } },
  executionStats: { nReturned: 11, totalKeysExamined: 3000, totalDocsExamined: 2940 },
};
const sbeIndexed = {
  explainVersion: '2',
  queryPlanner: { winningPlan: { queryPlan: { stage: 'LIMIT', inputStage: { stage: 'FETCH',
    inputStage: { stage: 'IXSCAN', indexName: 'c25_candidate_owner_sequence_id' } } },
  slotBasedPlan: { slots: '$$RESULT=s1', stages: '[1] limit 11 [2] nlj ...' } } },
  executionStats: { nReturned: 11, totalKeysExamined: 11, totalDocsExamined: 11 },
};
const classicAggregateCollscan = {
  stages: [{ $cursor: { queryPlanner: { winningPlan: { stage: 'COLLSCAN', filter: { deleted: { $eq: false } } } },
    executionStats: { nReturned: 6000, totalKeysExamined: 0, totalDocsExamined: 7860 } } }, { $group: {} }],
};

test('explain summaries read classic, slot-based and aggregate output without values', () => {
  assert.deepEqual(summarizeExplain(classicSort), { stages: ['FETCH', 'IXSCAN', 'SORT'],
    indexes: ['userId_1_syncSequence_1'], nReturned: 11, keysExamined: 3000, docsExamined: 2940 });
  const sbe = summarizeExplain(sbeIndexed);
  assert.deepEqual(sbe.stages, ['FETCH', 'IXSCAN', 'LIMIT']);
  assert.deepEqual(sbe.indexes, ['c25_candidate_owner_sequence_id']);
  const aggregate = summarizeExplain(classicAggregateCollscan);
  assert.deepEqual(aggregate.stages, ['COLLSCAN']);
  assert.equal(aggregate.docsExamined, 7860);
  assert.equal(usesIndex(aggregate), false);
  assert.equal(usesIndex(sbe), true);
  assert.throws(() => summarizeExplain({ ok: 1 }), /explain_shape_unrecognised/);
});

test('classification separates unbounded hot scans from bounded pages and admin collection scans', () => {
  const pageSpec = { workload: 'hot' as const, bound: { kind: 'page' as const, limit: 11 }, limited: true };
  const counts = { owner: 3000, filtered: 2940 };
  const baseline = classify(pageSpec, summarizeExplain(classicSort), counts);
  assert.deepEqual(baseline.flags.map(f => f.code), ['BLOCKING_SORT', 'EXAMINED_EXCEEDS_BOUND']);
  assert.equal(baseline.verdict, 'problem');
  assert.deepEqual(classify(pageSpec, summarizeExplain(sbeIndexed), counts), { flags: [], verdict: 'ok' });
  // The same examined count is a warning, not a problem, for maintenance or inactive paths.
  assert.equal(classify({ ...pageSpec, workload: 'maintenance' }, summarizeExplain(classicSort), counts).verdict, 'warn');
  const admin = classify({ workload: 'admin', bound: { kind: 'global' }, limited: false }, summarizeExplain(classicAggregateCollscan),
    { owner: 0, filtered: 6000 });
  assert.deepEqual(admin.flags, [{ code: 'COLLSCAN', severity: 'warn' }]);
  const hotScan = classify({ workload: 'hot', bound: { kind: 'global' }, limited: true }, summarizeExplain(classicAggregateCollscan),
    { owner: 0, filtered: 6000 });
  assert.equal(hotScan.verdict, 'problem');
  // A small owner-scoped sort is informational only; an unpaginated owner read is visible as info.
  const owner: ExplainSummary = { stages: ['FETCH', 'IXSCAN', 'SORT'], indexes: ['userId_1'], nReturned: 5, keysExamined: 60, docsExamined: 60 };
  const ownerResult = classify({ workload: 'hot', bound: { kind: 'owner' }, limited: false }, owner, { owner: 60, filtered: 5 });
  assert.equal(ownerResult.verdict, 'ok');
  assert.deepEqual(ownerResult.flags.map(f => f.code), ['BLOCKING_SORT', 'RESULT_UNPAGINATED']);
  // Point lookups tolerate one extra key per $in interval, no more.
  const point = (keys: number, docs: number): ExplainSummary => ({ stages: ['FETCH', 'IXSCAN'], indexes: ['_id_'], nReturned: 10, keysExamined: keys, docsExamined: docs });
  assert.equal(classify({ workload: 'hot', bound: { kind: 'point', n: 10 }, limited: false }, point(20, 10), { owner: 9, filtered: 10 }).verdict, 'ok');
  assert.equal(classify({ workload: 'hot', bound: { kind: 'point', n: 10 }, limited: false }, point(22, 10), { owner: 9, filtered: 10 }).verdict, 'problem');
  assert.equal(examinedBudget({ kind: 'page', limit: 100, skip: 50 }, { owner: 1, filtered: 1 }), 150);
  assert.equal(examinedBudget({ kind: 'global' }, { owner: 1, filtered: 1 }), Number.POSITIVE_INFINITY);
});

test('filter outlines keep fields and operators but never values', () => {
  const userId = fixtureId('user:unit');
  const outline = describeFilter({ userId, syncSequence: { $gt: 4, $lte: 99 }, _id: { $in: [userId, 'x'] },
    $or: [{ createdAt: { $lt: new Date(0) } }, { createdAt: new Date(0), _id: { $lt: userId } }] });
  assert.equal(outline, '{userId:eq, syncSequence:$gt,$lte, _id:$in[2], $or[{createdAt:$lt} | {createdAt:eq, _id:$lt}]}');
  assert.ok(!outline.includes(userId));
});

test('sanitizer rejects identifiers, hashes, emails and connection strings', () => {
  assert.doesNotThrow(() => assertSanitized({ id: 'notes.pull.first', indexes: ['userId_1_syncSequence_1'], keys: 'userId:1,_id:-1' }));
  for (const leak of [fixtureId('user:leak'), 'a'.repeat(64), '65f1c0ffee0123456789abcd', 'synthetic-1@example.invalid',
    'mongodb://127.0.0.1:27017', 'mongodb+srv://cluster.example', 'synthetic-drive-1-2']) {
    assert.throws(() => assertSanitized({ nested: [{ value: leak }] }), /diagnostics_report_not_sanitized/);
  }
});

test('arguments require one explicit mode and never offer an apply mode', () => {
  assert.deepEqual(explainArguments(['--seed-disposable']), { mode: 'seed-disposable', withCandidates: false });
  assert.deepEqual(explainArguments(['--seed-disposable', '--with-candidates']), { mode: 'seed-disposable', withCandidates: true });
  assert.deepEqual(explainArguments(['--read-only', '--database', 'atomic_notes']), { mode: 'read-only', database: 'atomic_notes', maxPages: 30 });
  assert.deepEqual(explainArguments(['--read-only', '--database', 'atomic_notes', '--max-pages', '200']),
    { mode: 'read-only', database: 'atomic_notes', maxPages: 200 });
  for (const args of [[], ['--apply'], ['--read-only'], ['--read-only', '--database'], ['--read-only', '--database', 'a b'],
    ['--seed-disposable', '--read-only'], ['--read-only', '--database', 'x', '--max-pages', '0'],
    ['--read-only', '--database', 'x', '--max-pages', '201'], ['--seed-disposable', '--database', 'x'],
    ['--read-only', '--database', 'x', '--seed-disposable']]) {
    assert.throws(() => explainArguments(args), /^Error: usage:/);
  }
});

test('seeding is limited to local hosts; remote hosts need read-only mode', () => {
  assert.deepEqual(uriHosts('mongodb://user:p%40ss@127.0.0.1:27017,localhost:27018/?replicaSet=rs0'),
    { scheme: 'mongodb', hosts: ['127.0.0.1', 'localhost'] });
  assert.deepEqual(uriHosts('mongodb://[::1]:27017/'), { scheme: 'mongodb', hosts: ['[::1]'] });
  for (const local of ['mongodb://127.0.0.1:27017/?replicaSet=rs0&directConnection=true', 'mongodb://localhost', 'mongodb://[::1]:27017']) {
    assert.doesNotThrow(() => assertUriAllowed(local, 'seed-disposable'));
  }
  for (const remote of ['mongodb+srv://cluster0.example.mongodb.net/', 'mongodb://127.0.0.1:27017,db.example.com:27017/',
    'mongodb://localhost.example.com/', 'mongodb://127.0.0.1@evil.example/']) {
    assert.throws(() => assertUriAllowed(remote, 'seed-disposable'), /explain_seed_requires_local_host/);
    assert.doesNotThrow(() => assertUriAllowed(remote, 'read-only'));
  }
  assert.throws(() => assertUriAllowed(undefined, 'read-only'), /explain_uri_required/);
  assert.throws(() => assertUriAllowed('http://127.0.0.1', 'seed-disposable'), /explain_uri_invalid/);
});

test('command guard allows reads only, and seeding only inside the generated database', () => {
  const read = (commandName: string, command: Record<string, unknown> = {}, databaseName = 'atomic_notes') =>
    commandViolation({ commandName, databaseName, command }, 'read-only', 'atomic_notes');
  for (const name of ['find', 'aggregate', 'count', 'distinct', 'listIndexes', 'listCollections', 'getMore', 'killCursors']) {
    assert.equal(read(name), null);
  }
  assert.equal(read('hello', {}, 'admin'), null);
  assert.equal(read('explain', { explain: { find: 'notes' } }), null);
  for (const name of ['insert', 'update', 'delete', 'findAndModify', 'createIndexes', 'dropIndexes', 'collMod', 'drop',
    'dropDatabase', 'create', 'renameCollection', 'bulkWrite']) {
    assert.equal(read(name), 'non_read_command');
  }
  assert.equal(read('aggregate', { pipeline: [{ $match: {} }, { $out: 'copy' }] }), 'writing_pipeline');
  assert.equal(read('aggregate', { pipeline: [{ $merge: { into: 'copy' } }] }), 'writing_pipeline');
  assert.equal(read('explain', { explain: { update: 'notes' } }), 'non_read_explain');
  assert.equal(read('explain', { explain: { aggregate: 'notes', pipeline: [{ $out: 'x' }] } }), 'non_read_explain');
  assert.equal(read('find', {}, 'other_database'), 'read_outside_selected_database');
  const disposable = 'atomic_explain_0123456789abcdef0123';
  const seed = (commandName: string, databaseName: string) =>
    commandViolation({ commandName, databaseName, command: {} }, 'seed-disposable', disposable);
  assert.equal(seed('insert', disposable), null);
  assert.equal(seed('dropDatabase', disposable), null);
  assert.equal(seed('buildInfo', 'admin'), null);
  assert.equal(seed('insert', 'atomic_notes'), 'write_outside_disposable_database');
  assert.equal(seed('dropDatabase', 'atomic_notes'), 'write_outside_disposable_database');
  assert.equal(commandViolation({ commandName: 'insert', databaseName: 'atomic_notes', command: {} }, 'seed-disposable', 'atomic_notes'),
    'write_outside_disposable_database');
});

test('inventory ids are unique, cite sources and cover candidate-affected queries', () => {
  const ids = querySpecs.map(s => s.id);
  assert.equal(new Set(ids).size, ids.length);
  assert.ok(querySpecs.every(s => /^src\/[\w/.-]+\.ts:\d+/.test(s.source)));
  for (const candidate of candidateIndexes) for (const id of candidate.affects) assert.ok(ids.includes(id), id);
  for (const collection of ['notes', 'sessions', 'sync_operations', 'energy_ledger', 'coin_lots']) {
    assert.ok(querySpecs.some(s => s.collection === collection), collection);
  }
});
