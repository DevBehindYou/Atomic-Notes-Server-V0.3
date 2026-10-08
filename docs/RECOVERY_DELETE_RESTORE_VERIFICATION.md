# Inactive immutable delete and restore

**Verified in code:** the admission helper now requires the intent's deleted
flag to equal the parsed row's deleted flag (`src/lib/recoveryAdmission.ts:27`). Both deletion and restoration still
require a persisted new generation ID, valid current preimage, bounded operation
and matching content hash/flags. Same-epoch adoption permits these pending
generation targets through the same preimage and lease checks as live edits
(`src/lib/recoveryAdoption.ts:14`).
The commit kernel already writes `targetFlags.deleted` together with pointer,
counter, success result and journal state in its fenced transaction
(`src/lib/recoveryCommit.ts:59`, `src/lib/recoveryCommit.ts:67`).

**Implementation choice within the approved inactive proposal:** stage a new
immutable content generation for every selected changed row, including deleted
rows. This preserves edits made before offline deletion and validates complete
content instead of trusting a legacy preimage hash. Deletion is Mongo metadata;
no generation is trashed, overwritten or removed. Restore stages and validates
another immutable generation, then commits the live flag using the current
base version. Current routes, economy, indexes and cleanup remain unchanged.
Unchanged-row selection and legacy/missing-content repair are caller concerns
outside this kernel; existing helper preimage checks still refuse stale versions.

**Executable acceptance, pending exact-head CI:**
`tests/recoveryDelete.fixture.test.ts` uses generated disposable Mongo and fake
Drive shared with actual HTTP pull/replay. Plaintext and encrypted-format rows
are committed, edited before deletion, then deleted. A mismatched intent flag
must refuse before debit. A post-write barrier rolls back both tombstones and
all receipts/counters/journal state, preserving prior live content. Simulated
lease handoff adopts the same staged files; the obsolete lease cannot commit,
and repeated staging reads back existing files without creating another copy.

Deleted-note pull must carry the requested content and flags for the recycle
bin. Restore rollback must preserve those tombstones; retry commits live rows
with higher versions. The current HTTP route refuses the older deletion request
as two conflicts without touching Drive, refunds once, and retains restored
content. Exact deletion/restore receipt replay must not delete the restored
notes, add charges or create files. The fixed phase/outcome artifact is
`ci-recovery-delete-proof.json`.

**Boundaries:** payloads are public opaque strings for envelope preservation,
not AES/native verification. Lease expiry is injected, not a process kill.
No real Drive, OAuth, device or signed upgrade is exercised. Generations and
tombstones are retained; no production retention promise or cleanup activation
is made. Missing/corrupt legacy deletion content, unchanged fast paths,
automatic reconciliation, quota/request-byte orchestration and old-writer
exclusion remain separate acceptance work. No production route imports the
recovery helpers or activates this storage protocol.
