import { explainArguments } from '../db/queryDiagnostics.js';
import { runDisposableDiagnostics, runReadOnlyDiagnostics } from '../db/queryDiagnosticsFixture.js';

// C25 query/index diagnostics. The connection string comes only from EXPLAIN_MONGODB_URI
// (never MONGODB_URI or .env). --seed-disposable is local-only and writes solely to a database
// it generated and verified empty, then drops it. --read-only sends reads/explains only, against an
// explicitly named database, and aborts on any other command. No apply/index-creation mode exists.
const KNOWN = new Set(['explain_uri_required', 'explain_uri_invalid', 'explain_seed_requires_local_host',
  'explain_database_invalid', 'explain_read_only_guard_violation', 'explain_fixture_database_not_empty',
  'diagnostics_report_not_sanitized']);
try {
  const mode = explainArguments(process.argv.slice(2));
  const uri = process.env.EXPLAIN_MONGODB_URI;
  const result = mode.mode === 'seed-disposable'
    ? await runDisposableDiagnostics(uri, { withCandidates: mode.withCandidates })
    : await runReadOnlyDiagnostics(uri, mode.database, { maxPages: mode.maxPages });
  if (result.violations.length) throw new Error('explain_read_only_guard_violation');
  console.log(JSON.stringify(result.report));
} catch (error) {
  // Never print driver errors: they can echo hosts, database names or credentials.
  const message = error instanceof Error ? error.message : '';
  console.error(message.startsWith('usage:') || KNOWN.has(message) ? message
    : 'Query diagnostics failed. Check arguments, EXPLAIN_MONGODB_URI and read access. Nothing was applied.');
  process.exitCode = 1;
}
