# Durable sync recovery: concrete review proposal

8 October 2026. **Design only; not implemented or activated.** No collection,
index, route, wallet policy, cleanup job or production data changes in this PR.
R11/R16 remain partial. The proposed storage changes need separate owner approval.
The [exact candidate field/index contract](DURABLE_RECOVERY_SCHEMA_PROPOSAL.md)
defines the bounded implementation scope for that decision; it is not applied.

## Evidence and current boundary

**Verified in code** at Server main
`41f425b7c2163867bb8839a25a7debc7198e24fb`:

- [`notes.ts:252`](../src/routes/notes.ts) performs an external Drive write before
  the metadata commit at line 375; line 270 updates the existing file.
- [`noteMetadata.ts:70`](../src/lib/noteMetadata.ts) uses a Mongo transaction for
  sequence, metadata and operation success. It cannot roll back Drive.
- [`syncOperation.ts:89`](../src/lib/syncOperation.ts) settles abandoned operations;
  line 124 finishes from stored results, and line 148 caps a full-failure refund
  at available wallet headroom. A refunded operation must never later commit.
- [`operationLock.ts:11`](../src/lib/operationLock.ts) returns a release callback,
  not a commit fencing token. The owner and expiry are recorded at lines 13/19.
- [`notes.ts:492`](../src/routes/notes.ts) removes cloud metadata on wipe. Any new
  recovery path must prevent an earlier staged upload from resurrecting it.

**Verified in disposable CI:** [Server #38](https://github.com/DevBehindYou/Atomic-Notes-Server-V0.3/pull/38)
forces a real Mongo validation failure after a fake Drive overwrite. The old
metadata/counter remain, the receipt refunds once, and pull refuses the mismatch.
An unchanged-hash upload does not repair it; a fresh dirty request with retained
content does. [Passing run](https://github.com/DevBehindYou/Atomic-Notes-Server-V0.3/actions/runs/37662147801).
This demonstrates a recovery gap, not universal loss or live Drive behavior.

**Preparation only:** [Server #39](https://github.com/DevBehindYou/Atomic-Notes-Server-V0.3/pull/39)
adds a currently unimported create-only adapter. Its caller must retain a generated
file ID before create; a 409 needs exact identity/content readback. It provides
no durable intent or recovery by itself. The initial validation failure and
corrected revision are documented in its verification note.

## Candidate records (proposal, no schema applied)

| Proposed record | Fields and purpose | Required constraints |
|---|---|---|
| `note_write_intents` | Deterministic operation-plus-note ID; user/note/operation IDs; request fingerprint; expected version, pointer and content hash; staged file ID and hash; intended encryption/kind/deletion flags; owner epoch; lease token; state; creation/update times; committed version/sequence or terminal reason | Unique operation/note pair; owner/state lookup; staged identity uniqueness scoped to owner; no TTL initially |
| `note_sync_state` | User ID; durable wipe epoch; current lease token; gate revision | Unique user ID; every lease handoff, pointer commit and wipe conditionally touches the same document |
| Existing `notes` | Existing committed metadata and Drive pointer; proposed generation-format marker | Version/pointer/owner preconditions checked inside commit; never mutate the currently committed generation before commit |
| Existing `sync_operations` | Existing fingerprint, debit, results and terminal receipt; proposed recovery-format marker | One result per row; terminal results immutable; receipt retention stays separate from the user's 50-row financial feed |

Only metadata enters these records: **no title, body, items, note payload, OAuth
credentials, vault key or recovery phrase**. Field types, bounds, exact indexes,
catalog validation and maximum document sizes must be reviewed before code.
Fingerprint/flags are metadata, not a source from which lost content can be rebuilt.

No automatic TTL or old-file deletion is proposed for the first activation.
This protects evidence but grows storage; measured volume and an approved
retention policy are prerequisites for production suitability. Financial history
trimming must never prune intents, sync receipts or generation references.

## Proposed state transitions and atomic boundaries

1. Authenticate and validate the existing envelope. Check completed replay before
   current quota/token checks as today. Same ID with different content is refused.
2. Acquire the per-user lease and transactionally publish a new token in the gate
   document. A process using an older token must lose its conditional gate write.
   Do not rely on an earlier lock read or wall-clock expiry alone.
3. Reconcile pending intents before the current unconditional abandoned-operation
   settlement. Use committed row results as authoritative. Finished/refunded
   operations fence every staged intent out of future commit.
4. In the existing debit transaction, establish the pending operation and bounded
   row intents. Persist each generated file identity **before** its create call.
   ID generation may precede this transaction; no file is uploaded until it commits.
5. Create each distinct immutable generation, then verify full content and parent/
   identity. Until pointer commit, readers retain the earlier committed generation.
   An unknown create outcome retries the retained ID; never guess from a filename.
6. In one batch Mongo transaction, conditionally touch the gate with current token/
   epoch and validate pending operation, intent state, owner, expected version and
   previous pointer. Advance sequences and versions, replace pointers, append each
   success result and mark the corresponding intents committed together. Any
   condition failure aborts that transaction; no late writer publishes success.
7. Settle the operation once using authoritative committed results and the existing
   partial/full/capped-refund rules. A lost reply replays that same receipt without
   an additional debit, generation or version increment.

Proposed row states are `prepared`, `verified`, `committed`, `abandoned` and
`superseded`. `verified` is not success. Commit requires readback revalidation after
restart; uploaded content alone never proves a Mongo commit. Terminal intent and
terminal operation updates must be ordered atomically so settlement cannot race
with a recovery commit. Failed-row retry in a new request creates new intents.

If the current client has lost the payload, a pending staged generation may be
read back transiently and verified against its journal fingerprint. No matching
staged content means recovery cannot invent content: preserve the previous pointer
and settle as undelivered. Do not alter a completed failure receipt to success.

## Delete, restore, wipe and cleanup

**Proposed:** deletion is a metadata/tombstone commit, retaining a valid generation
for restore. Trashing it before commit would recreate the same cross-store gap.
**Verified in current code:** general index initialization no longer creates the
30-day note/receipt TTLs (`src/db/collections.ts:325` and `:339`). The operator-only
transition inspects and can remove the exact legacy 30-day definitions
(`src/db/syncRetention.ts:5`, `:12`, `:35`). **Unverified:** a deployed database may
still retain those legacy indexes; no live catalog was inspected here. This
corrects an earlier draft's claim of a uniform current 30-day tombstone policy.
Generation retention requires a separate approved decision; no new retention or
historical-content promise is made. Restore validates retained content/current
version; missing content remains an explicit error.

Wipe must increment the durable user epoch and remove cloud metadata under the
same gate in a transaction. Pre-wipe intents cannot commit in the new epoch.
Physical file cleanup is later, retryable and unable to delete files referenced by
newer work. Local Hive notes and user-owned caches remain outside cloud wipe.

Cleanup stays disabled until separately reviewed. A candidate must prove no live
note, active intent, retained receipt or approved recovery reference names a file.
Interrupted cleanup, concurrent restore and wipe require independent acceptance.

## Compatibility, activation and rollback

**Proposed:** keep the wire envelope, costs, conflict semantics, cursor and vault
crypto unchanged. Additive metadata alone is insufficient: an old Server writer
can still overwrite a generation. Exclude/drain old writer deployments before
activation; compatible legacy apps may use the new writer only after their actual
protocol and signed upgrade are verified. A new hostname alone is not isolation
when both servers share the same database and Drive files.

Use a read-only inventory and reviewed backup/restore rehearsal first. Existing
files remain legacy generations until a legitimate accepted edit stages a new
one. An already corrupt/missing file is not automatically repaired. Approved
client-authorized resend must preserve competing edits and costs; a hash-only
inventory cannot recover missing note text.

Roll back by stopping writes and retaining journals/files, not by redeploying the
old overwrite writer into the same active data. Re-enabling a prior writer needs
a separately validated compatibility plan. No rollout, index creation or data
migration command is authorized by this document.

## Required executable acceptance before closure

**Proposed, not yet tested:** interrupt/restart before intent, after intent, during
create, after external create, before/after pointer commit and before response.
Also test lease handoff with a paused writer, concurrent reader, duplicate replay,
stale edit/delete/restore, cloud wipe, batch mixed failures, all-failed capped
refund, transaction retry and cleanup interruption. Inspect both generations,
pointer/version/sequence, intent/receipt and wallet/ledger after each phase.

Use generated Mongo and fake Drive first. Real Drive identity/quota behavior,
native keystore/vault lifecycle, two physical devices and the signed 2.03.5 to
2.03.9 upgrade remain separate gates. Approval of this document is not evidence
that these tests passed or permission to activate the proposed storage changes.

The concrete approval scope would be: reviewed bounded intent/gate schemas and
indexes, recovery-aware settlement, fenced pointer/wipe transactions and inactive
disposable acceptance fixtures. Production activation, retention cleanup, legacy
repair and changed user-facing promises each require their own reviewed decision.
