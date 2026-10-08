# Inactive 50-row batch verification

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

Only allowlisted fixed phase/outcome values are uploaded in
`ci-recovery-batch-proof.json`. Its passing outcome is asserted only after
retrieval from a successful exact-head CI run.

**Boundaries:** generated disposable Mongo and fake Drive only. The staging
loop is sequential; it is not a concurrency or throughput benchmark. This
inactive helper does not prove production quota/auth/request-byte checks,
native crypto, real Drive requests, process crashes, deleted/restore rows,
automatic reconciliation, legacy repair or release readiness. Production routes
and storage initialization are unchanged.
