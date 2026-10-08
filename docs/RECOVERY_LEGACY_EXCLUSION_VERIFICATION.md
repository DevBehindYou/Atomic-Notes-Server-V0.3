# Legacy request exclusion for pending recovery operations

**Causal baseline pending:** the generated fixture checks actual legacy HTTP
same-request retry, new-request admission and cloud wipe against a paid,
verified but pending recovery operation. Those calls must refuse with
`409 sync_recovery_required` without modifying the journal, metadata, files,
wallet, ledger, counter or receipt. Completed receipt replay and read-only pull
must remain available. The test-only baseline leaves production source intact.

Current source `src/lib/syncOperation.ts` returns a same-request pending record
from `findSync`, and `settleAbandonedSyncs` closes every pending operation.
`src/routes/notes.ts` consumes that pending record, calls abandoned settlement
before new admission, and calls it before non-push writes. Their compatibility
with recovery-format work is a hypothesis to verify in the generated fixture.

No production journal data, activation, index operation, cleanup or deployment
is included. Even a passing guard applies only to updated code: older deployed
workers that never knew this marker remain an explicit cutover/drain boundary.

**Preserved assembly failure:** test-only head `29dc61e`, run `37836893325`,
fails all four cases. The fixture explicitly allows only one instance per
process; the test incorrectly attempted four. This does not provide the desired
causal baseline or a passing replay control. The corrected assembly uses one
fixture with four independently seeded owners and fixed HTTP status output.
Production source is still unchanged for the rerun.
