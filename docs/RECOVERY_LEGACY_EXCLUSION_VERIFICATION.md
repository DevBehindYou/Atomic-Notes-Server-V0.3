# Legacy request exclusion for pending recovery operations

**Verified unchanged-code causal baseline:** test-only head `b1a38c2`, run
`37837558979`, reproduces three failures with completed receipt replay passing.
Actual same-request retry, new-request admission and cloud wipe return 200
instead of the required refusal. Production source is identical to verified
main `4542901` in this baseline. The generated fixture checks actual legacy HTTP
same-request retry, new-request admission and cloud wipe against a paid,
verified but pending recovery operation. Those calls must refuse with
`409 sync_recovery_required` without modifying the journal, metadata, files,
wallet, ledger, counter or receipt. Completed receipt replay and read-only pull
must remain available. The test-only baseline leaves production source intact.

The before source `src/lib/syncOperation.ts` returns a same-request pending record
from `findSync`, and `settleAbandonedSyncs` closes every pending operation.
`src/routes/notes.ts` consumes that pending record, calls abandoned settlement
before new admission, and calls it before non-push writes. Their compatibility
with recovery-format work is disproved by that generated fixture.

**Correction in code:** `findSync` refuses a recovery-tagged pending operation
after fingerprint validation, while a closed receipt remains replayable.
`settleAbandonedSyncs` checks the entire existing query result before closing
any legacy operation. It refuses tagged work, including unsupported future
format values, with `409 sync_recovery_required`. This adds no Mongo query,
journal import, migration or activation path; untagged legacy behavior and
financial policy remain unchanged. CI reruns all existing fixtures and the
causal cases before acceptance. Only fixed statuses/case outcomes are exported.

No production journal data, activation, index operation, cleanup or deployment
is included. Even a passing guard applies only to updated code: older deployed
workers that never knew this marker remain an explicit cutover/drain boundary.

**Preserved assembly failure:** test-only head `29dc61e`, run `37836893325`,
fails all four cases. The fixture explicitly allows only one instance per
process; the test incorrectly attempted four. This does not provide the desired
causal baseline or a passing replay control. The corrected assembly uses one
fixture with four independently seeded owners and fixed HTTP status output.
Production source is still unchanged for the rerun.
