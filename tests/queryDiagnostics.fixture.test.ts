import assert from 'node:assert/strict';
import test from 'node:test';
import { assertSanitized, usesIndex, type QueryResult } from '../src/db/queryDiagnostics.js';
import {
  FIXTURE_AS_OF, FIXTURE_PROFILE, HEAVY_OWNER, TYPICAL_OWNER, runDisposableDiagnostics, runReadOnlyDiagnostics,
  seedForReadOnlyCheck, type DiagnosticsReport,
} from '../src/db/queryDiagnosticsFixture.js';
import { fixtureDatabase } from './clientFixtureSafety.js';

// C25: explain evidence on generated disposable data only. Production indexes are created
// by the shared ensureIndexes(); candidate indexes exist only inside the generated database.
const uri = process.env.MONGODB_URI;
let baseline: DiagnosticsReport | undefined;

const byId = (queries: QueryResult[], id: string) => {
  const found = queries.find(q => q.id === id);
  assert.ok(found && !found.skipped, `${id} ran`);
  return found;
};
const stats = (q: QueryResult) => `${q.id}:${q.stages?.join('+')}:r${q.nReturned}:k${q.keysExamined}:d${q.docsExamined}`;

test('disposable explain baseline is repeatable, sanitized and bounds hot queries', { timeout: 600000 }, async (t) => {
  fixtureDatabase(uri); // canonical local replica set only; the run generates its own database name
  const first = await runDisposableDiagnostics(uri, { withCandidates: true });
  const second = await runDisposableDiagnostics(uri, { withCandidates: true });
  assert.deepEqual(first.violations, []);
  assert.deepEqual(second.violations, []);
  // Repeatable: two independently seeded databases yield the identical report (no timings, no random ids).
  assert.deepEqual(second.report, first.report);
  const report = baseline = first.report;
  t.diagnostic(`QUERY_DIAGNOSTICS_SUMMARY ${JSON.stringify({ mongo: report.mongo, fixture: report.fixture,
    summary: report.summary, candidates: report.candidates && { added: report.candidates.summaryAdded,
      replacement: report.candidates.summaryReplacement, ensureIndexesWhileHidden: report.candidates.ensureIndexesWhileHidden,
      stillHidden: report.candidates.stillHidden } })}`);
  for (const probe of [...report.probes, ...(report.candidates?.added ?? []), ...(report.candidates?.replacement ?? [])]) {
    t.diagnostic(`QUERY_DIAGNOSTICS_PROBE ${probe.label} ${JSON.stringify({ ownerRows: probe.ownerRows, pagination: probe.pagination })}`);
    for (const q of probe.queries) {
      t.diagnostic(`QUERY_DIAGNOSTICS_QUERY ${probe.label} ${JSON.stringify({ id: q.id, verdict: q.verdict, flags: q.flags,
        stages: q.stages, indexes: q.indexes, nReturned: q.nReturned, keys: q.keysExamined, docs: q.docsExamined,
        owner: q.ownerRows, matching: q.matchingRows, skipped: q.skipped })}`);
    }
  }
  t.diagnostic(`QUERY_DIAGNOSTICS_INDEXES ${JSON.stringify(report.declaredIndexes)}`);

  // Sanitized: no owner ids, session hashes, emails, Drive ids or connection strings.
  assertSanitized(report);
  const text = JSON.stringify(report);
  for (const secret of [HEAVY_OWNER, TYPICAL_OWNER, 'example.invalid', '127.0.0.1']) assert.ok(!text.includes(secret));

  // Realistic cardinality was actually seeded.
  const P = FIXTURE_PROFILE;
  assert.equal(report.fixture?.notes, P.heavyNotes + P.typicalUsers * P.typicalNotes);
  assert.equal(report.fixture?.energy_ledger, P.heavyLedger + P.typicalUsers * P.typicalLedger);
  assert.equal(report.fixture?.sync_operations, P.heavyOperations + P.typicalUsers * P.typicalOperations);
  assert.equal(report.fixture?.sessions, P.heavySessions + P.typicalUsers * P.typicalSessions);
  const [largest, typical] = report.probes;
  assert.equal(largest.ownerRows.notes, P.heavyNotes);
  assert.equal(typical.ownerRows.notes, P.typicalNotes);

  for (const probe of report.probes) {
    for (const q of probe.queries.filter(q => !q.skipped && q.workload === 'hot')) {
      // No hot path scans the collection; every one uses an index.
      assert.ok(!q.stages!.includes('COLLSCAN') && usesIndex({ stages: q.stages!, indexes: [], nReturned: 0, keysExamined: 0, docsExamined: 0 }), `${probe.label} ${stats(q)}`);
      // Point lookups stay point lookups.
      if (q.bound.startsWith('point')) assert.ok(q.docsExamined! <= Number(/\d+/.exec(q.bound)![0]), `${probe.label} ${stats(q)}`);
    }
    // Pagination is bounded per page and complete: every sequenced row exactly once, nothing skipped.
    const walk = probe.pagination;
    assert.equal(walk.truncated, false);
    assert.ok(walk.maxReturnedPerPage <= 11);
    assert.equal(walk.rows, walk.expectedRows);
    assert.equal(walk.uniqueRows, walk.expectedRows);
  }
  assert.equal(largest.pagination.expectedRows, P.heavyNotes - P.unsequencedHeavyNotes);
  // Only call sites that cannot run for that owner are skipped: ordered-history shapes for the legacy
  // heavy wallet; legacy history, logout attempts and later coin pages for the small ordered wallet.
  assert.deepEqual(largest.queries.filter(q => q.skipped).map(q => q.id), ['ledger.historySequenced', 'ledger.appendWindow']);
  assert.deepEqual(typical.queries.filter(q => q.skipped).map(q => q.id),
    ['logout.attemptById', 'ledger.historyLegacy', 'coins.detailsNext', 'coins.operation']);
  // Repeatable baseline gate: a plan regression or improvement changes this list and must be reviewed.
  assert.deepEqual(report.summary.problemIds, ['largest-owner:ledger.historyLegacy', 'largest-owner:notes.pull.first',
    'largest-owner:notes.pull.next', 'typical-owner:notes.pull.first']);
  assert.deepEqual(report.summary.warnIds, ['largest-owner:admin.notificationsNext', 'largest-owner:admin.recentSessionOwners',
    'largest-owner:admin.statsActive24h', 'largest-owner:admin.statsActiveNotes', 'largest-owner:coins.activeLots',
    'largest-owner:coins.detailsNext', 'largest-owner:coins.dueLots', 'largest-owner:ledger.retentionBatch',
    'typical-owner:admin.notificationsNext', 'typical-owner:admin.recentSessionOwners', 'typical-owner:admin.statsActive24h',
    'typical-owner:admin.statsActiveNotes']);

  // Finding: the pull page sort {syncSequence, _id} is not provided by {userId, syncSequence}, so each page
  // sorts every remaining owner row in memory. Examined rows grow with the account, not with the page.
  const pull = byId(largest.queries, 'notes.pull.first');
  assert.ok(pull.stages!.includes('SORT'), stats(pull));
  assert.ok(pull.docsExamined! >= P.heavyNotes - P.unsequencedHeavyNotes, stats(pull));
  assert.equal(pull.verdict, 'problem');
  assert.ok(largest.pagination.totalDocsExamined > 100 * largest.pagination.rows, JSON.stringify(largest.pagination));
  // Admin collection scans are reported as warnings, not hidden.
  assert.equal(byId(largest.queries, 'admin.statsActiveNotes').verdict, 'warn');

  // Candidate (disposable only): {userId, syncSequence, _id} removes the sort and bounds each page.
  const candidates = report.candidates!;
  assert.ok(candidates);
  for (const phase of [candidates.added, candidates.replacement]) {
    const [heavy] = phase;
    for (const id of ['notes.pull.first', 'notes.pull.next']) {
      const q = byId(heavy.queries, id);
      assert.ok(!q.stages!.includes('SORT') && q.docsExamined! <= 11 && q.keysExamined! <= 13, `${heavy.label} ${stats(q)}`);
      assert.equal(q.verdict, 'ok');
    }
    assert.ok(heavy.pagination.totalDocsExamined <= heavy.pagination.pages * 11, JSON.stringify(heavy.pagination));
    assert.equal(heavy.pagination.uniqueRows, heavy.pagination.expectedRows);
    assert.ok(!byId(heavy.queries, 'sessions.inventory').stages!.includes('SORT'));
  }
  // Replacing (hiding) the old indexes regresses none of the queries on those collections.
  assert.deepEqual(candidates.summaryAdded.problemIds, []);
  assert.deepEqual(candidates.summaryReplacement.problemIds, []);
});

test('read-only mode sends no writes and reproduces the disposable baseline', { timeout: 600000 }, async () => {
  fixtureDatabase(uri);
  const seeded = await seedForReadOnlyCheck(uri);
  try {
    const before = await seeded.db.command({ dbHash: 1 });
    const result = await runReadOnlyDiagnostics(uri, seeded.database, { maxPages: 1000, asOf: FIXTURE_AS_OF });
    const after = await seeded.db.command({ dbHash: 1 });
    assert.equal(after.md5, before.md5);
    assert.deepEqual(after.collections, before.collections);
    assert.deepEqual(result.violations, []);
    const allowed = new Set(['aggregate', 'buildInfo', 'count', 'distinct', 'endSessions', 'explain', 'find', 'getMore',
      'hello', 'isMaster', 'ismaster', 'killCursors', 'listCollections', 'listIndexes', 'ping', 'saslStart', 'saslContinue']);
    assert.deepEqual(Object.keys(result.commands).filter(name => !allowed.has(name)), []);
    assert.ok(result.commands.explain > 0);
    assertSanitized(result.report);
    // The read-only path selects the same largest owner and produces the same explain evidence.
    assert.ok(baseline, 'baseline test ran first');
    assert.deepEqual(result.report.probes[0], baseline.probes[0]);
    assert.deepEqual(result.report.declaredIndexes, baseline.declaredIndexes);
  } finally { await seeded.drop(); }
});
