import { hasBlockingFindings } from '../db/identityMigrationPlan.js';
import { identityPlanArguments, runReadOnlyIdentityPlan } from '../db/identityMigrationPlanRunner.js';

// C28 identity/library migration DRY RUN. The connection string comes only from
// IDENTITY_PLAN_MONGODB_URI (never MONGODB_URI or .env). Read-only against an explicitly
// named database: every command is checked against the C25 read allowlist and any other
// command fails the run. No apply, backfill, index or provider-activation mode exists.
// Prints counts, truncated one-way references, digests and a resume checkpoint only.
// Exit codes: 0 nothing blocking, 2 blocking findings counted, 1 failed run.
const KNOWN = new Set(['explain_uri_required', 'explain_uri_invalid', 'identity_plan_database_invalid',
  'identity_plan_read_only_guard_violation', 'identity_plan_population_exceeds_bound', 'identity_plan_limit_invalid',
  'identity_plan_checkpoint_invalid', 'identity_plan_checkpoint_stale', 'identity_plan_checkpoint_mismatch',
  'identity_plan_duplicate_user_id', 'diagnostics_report_not_sanitized']);
try {
  const args = identityPlanArguments(process.argv.slice(2));
  const { report } = await runReadOnlyIdentityPlan(process.env.IDENTITY_PLAN_MONGODB_URI, args.database,
    { limit: args.limit, resume: args.resume });
  console.log(JSON.stringify(report));
  if (hasBlockingFindings(report)) process.exitCode = 2;
} catch (error) {
  // Never print driver errors: they can echo hosts, database names or credentials.
  const message = error instanceof Error ? error.message : '';
  console.error(message.startsWith('usage:') || KNOWN.has(message) ? message
    : 'Identity migration plan failed. Check arguments, IDENTITY_PLAN_MONGODB_URI and read access. Nothing was written.');
  process.exitCode = 1;
}
