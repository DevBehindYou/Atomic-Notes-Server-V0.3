# Inactive unchanged generation readback

This closes one admission gap in the inactive classified caller. Metadata hash
equality alone previously froze an unchanged success even when the pointed-to
Drive content was corrupted. The current production route remains unchanged;
the fixture reproduces its metadata-only acknowledgment and subsequent refused
HTTP pull as a control. This is not historical repair or production activation.

For a new request only, the caller reads each unchanged generation outside Mongo's
transaction before allocating IDs, debiting energy or publishing results. Only
metadata marked `generationFormat: 1` is supported. The existing generation reader
validates file ID, the supplied owner-scoped parent, MIME type, trashed state and
content schema. The caller additionally verifies note ID, kind, encryption flag,
pin flag and canonical content hash against both the original row and metadata.
Deletion is a Mongo flag, not an AtomicFile content field; tombstones still need
their committed content verified. The complete frozen metadata snapshot is
revalidated in the fenced admission transaction after external I/O. Pointer,
version, hash, deleted/other flags, owner and timestamps cannot drift silently.

Missing, corrupt, mismatched or unknown read outcomes refuse before new admission.
There is no terminal result, settlement/refund, repair, overwrite or cleanup on
that path. Legacy unchanged metadata is explicitly unsupported rather than
retrofitted. Valid unchanged pushes still follow existing paid-success semantics.
Pending and terminal replay branches precede this guard: their immutable saved
results are neither reread nor reclassified, including after a fresh lease.

## Disposable evidence

`tests/recoveryUnchanged.fixture.test.ts` seeds notes through the real inactive
fresh/classified callers with a generated localhost Mongo replica set and fake
Drive SDK. It reproduces the production metadata-only false unchanged control,
then checks corrected refusal before IDs, debit, results, intents or Drive writes.
It checks content/identity/parent/MIME/trashed and content-schema mismatches, missing/unknown reads, legacy
and inconsistent metadata flags, an injected pointer change after external read
causing admission rollback, accepted live/plaintext/opaque-encrypted/tombstone
unchanged results, pending lease handoff that forbids reading the frozen unchanged
pointer, and terminal replay with every SDK call throwing. Operations, wallet,
ledger, metadata, counter, intents and external write counts are compared directly.
The existing 29 proof artifacts remain required.

The new fixed artifact is `sanitized-recovery-unchanged-proof`, containing only
`ci-recovery-unchanged-proof.json` with:

```json
{"version":1,"scope":"disposable inactive unchanged generation readback and frozen replay","phase":"complete","outcome":"pass"}
```

## Boundaries

Source review is not executed evidence; full CI and exact-head artifact checks are
required. No production route imports, persistent schema/index, funding/quota
policy, activation, database migration or historical repair changes. Authenticated
owner, held lease, owner-scoped SDK/parent and raw HTTP byte limiting remain trusted
caller prerequisites. Recovery remains bounded at 50 rows versus production 100.
Frozen retry receipts are historical outcomes, not fresh proofs of cloud readability.
External changes after readback remain a containment boundary: app-owned immutable
generations and exclusion/draining of old mutable writers are rollout prerequisites.
Real Drive, process kill, native encryption, two devices, legacy compatibility,
missing-note nonzero-base/deletion behavior, later preimage drift and production
partial-failure orchestration remain outside this proof. Full R11/R16 remain partial.
