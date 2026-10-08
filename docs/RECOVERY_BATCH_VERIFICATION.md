# Transaction validation and inactive 50-row batch verification

**Verified in code:** `beginRecoverySync` validates a bounded ordered row/intent
manifest before paid admission (`src/lib/recoveryAdmission.ts:17`).
`commitRecoveryIntents` rechecks verified generation contents and preimages,
then commits metadata, sequence allocation, success results and journal states
in one fenced transaction (`src/lib/recoveryCommit.ts:50`).
`saveNoteMetadataBatchInSession` preserves request order and uses retained
per-user sequences for fresh note versions (`src/lib/noteMetadata.ts:93`).

**Executable acceptance, pending exact-head CI:**
`tests/recoveryBatch.fixture.test.ts` first commits 15 generated notes, then
admits 50 rows: 15 edits and 35 fresh notes, with text, checklist, pinned and
encrypted-format rows. Encrypted rows contain public opaque schema-valid
payload strings; this proves envelope preservation, not encryption or decryption.
The actual AES/native verification boundaries are recorded separately.

The fixture refuses 51 rows before a debit or external write. For the 50-row
operation, a generated Mongo validator rejects the last fresh row, and a second
injected barrier rejects after all transaction writes. Both must roll back all
50 metadata mutations, counter allocation, results and journal transitions,
keeping all 15 previous generations unchanged. Retry must reuse all staged
files, preserve ordered sequences 16 through 65 and advance existing versions
independently from their global sequences. One instant charge pays for all 50
rows; settlement and cached replay cause no additional debit or generation.

Actual HTTP pull from cursor 15 must return all 50 current rows exactly once
over five ten-row pages, preserving kind, content, flags, payload and versions.
Both the older seed receipt and the newer 50-row receipt are replayed through
the actual push route without financial, metadata, intent or file changes.

**Observed fixture failure:** first head `709cbdb` failed run 37793744186 at
`bounded_admission`. Source inspection found its absolute ledger count omitted
the fixture's welcome-credit entry; the corrected test measures additions from
the initial ledger and explicitly grants only a synthetic 100-note fixture tier.
This explanation is inferred from source and phase evidence; no raw failure
logs were retrieved. The failed artifact is preserved separately from retries.

The second head `26033cc` passed admission and failed run 37794354319 in the
`metadata_rejection` group. The Mongo driver's unordered bulk implementation can
retain validation code 121 in `MongoBulkWriteError.result` while surfacing a
later transaction-abort code. The fixture now accepts only an explicit 121
from the direct error or that bulk result, and separates error classification
from rollback snapshots in fixed phases. This is a source-based explanation,
pending the corrected run; no generic rejection substitutes for validation.

The third head `63a8398` failed run 37795026296 before reaching either new error
classification phase. Its fixture step ran for 75 seconds; source inspection
suggested the callback was retrying a masked validation error. A manual
generated-database transaction now asserts the exact causal baseline: unordered
mixed insert/update bulk surfaces code 251 with a transient-transaction label
while retaining code 121 in the bulk result, and rolls back all mutations.
That diagnosis becomes verified only when this exact baseline passes CI.

**Verified in code:** the shared `saveNoteMetadataBatchInSession` writer now groups
its independent inserts and updates and uses `ordered: true`. It stops on the
first permanent rejection while preserving the preassigned request-order
sequences/results. Grouping avoids an extra command group for every alternating
row type. This wrapper serves the current route as well as the inactive kernel;
its real production deployment has not changed. Route duplicate IDs are refused
at `src/routes/notes.ts:176`. Full current-route integration CI remains required.

Only allowlisted fixed phase/outcome values are uploaded in
`ci-recovery-batch-proof.json`. Its passing outcome is asserted only after
retrieval from a successful exact-head CI run.

**Boundaries:** generated disposable Mongo and fake Drive only. The staging
loop is sequential; it is not a concurrency or throughput benchmark. This
inactive helper does not prove production quota/auth/request-byte checks,
native crypto, real Drive requests, process crashes, deleted/restore rows,
automatic reconciliation, legacy repair or release readiness. Production routes
and storage initialization are unchanged; their shared metadata writer changes
error stopping behavior within the same transaction. No production data/index
or deployment action is performed.
