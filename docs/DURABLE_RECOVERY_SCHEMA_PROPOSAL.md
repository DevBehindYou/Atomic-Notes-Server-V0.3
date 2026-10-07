# Durable recovery: proposed schema and implementation approval scope

8 October 2026. **Proposal only.** This document creates no collections/indexes,
migrates no data and enables no recovery or cleanup. It refines the
[operation review](DURABLE_RECOVERY_REVIEW_PLAN.md). R11/R16 remain partial.

## Proposed exact field contract

All new records reject unknown fields. UUID means the current canonical UUID
format; hashes mean lowercase 64-character SHA-256 hex. Bounded integers are
nonnegative JavaScript-safe integers, with overflow refused before mutation.
Drive identities are nonempty strings of at most 256 characters; that proposed
bound requires real-Drive acceptance before activation. Dates are BSON dates;
never store raw exception messages or user content as terminal reasons.

`note_write_intents`, proposed format 1:

| Field | Proposed type / bound | Meaning |
|---|---|---|
| `_id` | Exactly `userUUID:requestUUID:noteUUID` (110 characters) | Stable row identity; no retry-generated intent ID |
| `format` | Literal integer `1` | Explicit parser version |
| `userId`, `noteId`, `requestId` | UUID each | Ownership and exact row/request identity |
| `operationId` | Exactly `userUUID:requestUUID` (73 characters) | Existing operation identity |
| `fingerprint` | Hash | Existing full-envelope fingerprint; different rows/mode under the same ID are refused |
| `expectedVersion` | Bounded integer | Zero only for an expected-absent row |
| `expectedFileId` | Bounded Drive identity or null | Previous committed pointer, null for fresh/no-content metadata |
| `expectedHash` | Hash or null | Previous committed content fingerprint |
| `stagedFileId` | Bounded Drive identity or null | Persisted before create; null only for a verified reuse path |
| `targetHash` | Hash | Current canonical content fingerprint; not note text |
| `targetFlags` | Exact object `{kind: 'text'|'todo', encV: 0|1, pinned: boolean, deleted: boolean}` | Metadata flags needed to validate staged content and target metadata |
| `wipeEpoch` | Bounded integer | User epoch captured during preparation |
| `leaseToken` | UUID | Lease instance that prepared/adopted the intent |
| `state` | `prepared` / `verified` / `committed` / `abandoned` / `superseded` | No uploaded-only success |
| `createdAt`, `updatedAt` | BSON date each | Operational timestamps, not client ordering |
| `committedVersion`, `committedSequence` | Positive bounded integer or null each | Both populated only in the metadata/result commit transaction |
| `terminalReason` | Null or fixed allowlist: `operation_closed`, `version_changed`, `owner_changed`, `wipe_changed`, `content_unavailable`, `content_mismatch`, `identity_mismatch`, `write_interrupted` | Sanitized reason, never a free-text stack/body |

Cross-field rules: IDs must agree; fresh rows expect null pointer/hash; committed
rows require both authoritative version/sequence and null terminal reason.
Abandoned/superseded rows require a terminal reason and cannot acquire committed
fields later. A null staged ID does not prove an unchanged row: the current
pointer/content must pass readback before verified reuse. The journal never
contains title/body/items, encoded note payload, Google tokens, vault verifier,
key or recovery phrase.

`note_sync_state`, proposed format 1:

| Field | Proposed type | Rule |
|---|---|---|
| `_id` | User UUID | One persistent gate per user; never a TTL document |
| `format` | Literal `1` | Explicit version |
| `wipeEpoch`, `gateRevision` | Bounded integer each | Initialize at zero; increment refuses overflow |
| `leaseToken` | UUID or null | Replace transactionally on lease acquisition; conditional clear on release |
| `leaseExpiresAt` | BSON date or null | Null iff token is null; expiration is checked in conditional commit |
| `updatedAt` | BSON date | Server clock timestamp |

Additive optional markers proposed for existing records: `notes.generationFormat`
and `sync_operations.recoveryFormat`, both literal `1`. Absent means legacy;
absence must never be treated as permission to synthesize intents or repair
historical content. Existing note/wallet/receipt fields and wire formats remain.

## Proposed indexes, without creating them

| Collection | Name / keys | Options and purpose |
|---|---|---|
| `note_write_intents` | Existing mandatory `_id_` | Unique identity includes owner/request/note |
| `note_write_intents` | `intent_owner_operation` on `{userId:1, operationId:1}` | Nonunique; load up to the operation's at-most-50 row IDs |
| `note_write_intents` | `intent_owner_state` on `{userId:1, state:1, createdAt:1, _id:1}` | Nonunique; bounded recovery pages, no whole-collection scan |
| `note_write_intents` | `intent_owner_staged_file` on `{userId:1, stagedFileId:1}` | Unique; partial filter `{stagedFileId: {$type:'string'}}`; excludes null reuse intents |
| `note_sync_state` | Existing mandatory `_id_` | Unique user gate; no additional index |

No TTL, background pruning or existing index deletion is part of this proposal.
Validate names, key order, uniqueness and partial options in a generated database
first. Real catalog inspection, backup/restore and index builds are separate
production approval gates. The exact index spec is a candidate, not evidence of
a measured production query plan. Records are bounded individually; lifetime
storage is not bounded until an independently approved retention policy exists.

## Proposed transaction predicates and settlement ordering

Lease acquisition updates `operation_locks` and the persistent gate in one
transaction and returns the token to the writer. Release clears the matching
token and lock in a transaction; a stale release cannot clear a newer lease.
Do not delete the persistent gate when the TTL lock disappears.

Every pointer/result commit conditionally writes the gate using current token,
unexpired lease, expected epoch and safe revision increment, inside the **same**
transaction as note/result changes. The gate write forces transaction conflicts
with handoff/wipe; a snapshot read alone is insufficient. Note updates also
require owner, expected version/pointer/hash. Insert requires expected absence.
Operation must remain pending; intent must be verified in the same epoch. Readback
must validate ID/parent/content/flags before verified state or reuse is accepted.

Operation settlement first conditionally writes the same gate, closes any pending
row intents and records the receipt/refund atomically. A committed success wins;
a terminal failure cannot later be promoted. Recovery may adopt pending intents
under the new token only after fresh version/epoch/identity checks. This replaces
the current unconditional abandoned-operation finish for format-1 recovery
operations. Legacy pending operations use the current stored-result settlement;
there is no fabricated journal or retrospective success.

All 50 row identities are known from the validated envelope. Debit plus initial
intents are atomic. A retained generated ID is saved before external create;
retries never mint a different ID for that intent. A Drive readback after restart
is not a Mongo result: commit must still pass every predicate. Missing staged
content settles undelivered while the previous pointer stays unchanged.

Unchanged and delete paths cannot trust a hash alone after #38's demonstrated
mismatch. Verified matching content may reuse its current generation; changed
content must stage a new generation even if the requested row is deleted.
Deletion commits a tombstone and retains valid content; no pre-commit trash.
Restore also validates retained content. Wipe increments epoch and removes note
metadata under the gate; its file cleanup remains disabled. No stale intent can
publish into the new epoch, and local Hive notes remain untouched.

## Concrete scope that could be approved next

**Implementation proposal:** add these strict, bounded types and disposable index
fixtures; add inactive journal/gate helpers; extend conditional batch metadata
commit and recovery-aware settlement behind an injected test-only writer path;
exercise the create-only adapter with generated Mongo/fake Drive. Production
routes continue using the current writer. No new network dependency, economy,
vault crypto, public promise, real data migration or index build is included.

Use small PRs with failing-before controls and exact-head/full-main CI. Acceptance
must cover crashes at each barrier, lease loss and stale release, wrong owner/base,
wipe, changed-generation collision, transaction retry, concurrent pull, mixed
batch outcomes, capped refund and replay. Assert old/new content, metadata/seq,
journal/result, wallet/ledger and file counts, not just an HTTP status. No closure
credit until the actual candidate path executes those tests.

**Excluded from that approval:** activating a production writer, enabling
automatic old-data repair, creating production indexes, migrating existing users,
generation/tombstone cleanup, changing retention promises, deployment or signing.
Old writer exclusion/drain, real Drive acceptance, storage/quota measurement,
backup/restore and signed legacy-client compatibility remain release gates.
Approval to merge this document alone authorizes none of the proposed schemas.
