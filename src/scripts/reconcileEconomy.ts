import { reconciliationArguments, runReadOnlyReconciliation } from '../db/economicReconciliationRunner.js';

// C27 economic reconciliation. The connection string comes only from RECONCILE_MONGODB_URI
// (never MONGODB_URI or .env). Read-only against an explicitly named database: every command
// is checked against the C25 read allowlist and any other command fails the run. No apply,
// repair or link-inference mode exists. Prints counts and truncated one-way hashes only.
// Exit codes: 0 no discrepancy, 2 discrepancies counted, 1 failed run.
const KNOWN = new Set(['explain_uri_required', 'explain_uri_invalid', 'reconciliation_database_invalid',
  'reconciliation_owner_invalid', 'reconciliation_read_only_guard_violation', 'reconciliation_owner_order_violation',
  'diagnostics_report_not_sanitized']);
try {
  const args = reconciliationArguments(process.argv.slice(2));
  const { report } = await runReadOnlyReconciliation(process.env.RECONCILE_MONGODB_URI, args.database,
    { owner: args.owner, asOf: args.asOf });
  console.log(JSON.stringify(report));
  if (report.summary.discrepant > 0) process.exitCode = 2;
} catch (error) {
  // Never print driver errors: they can echo hosts, database names or credentials.
  const message = error instanceof Error ? error.message : '';
  console.error(message.startsWith('usage:') || KNOWN.has(message) ? message
    : 'Economic reconciliation failed. Check arguments, RECONCILE_MONGODB_URI and read access. Nothing was written.');
  process.exitCode = 1;
}
