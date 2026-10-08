# Inactive wipe/upload interleaving: verification boundary

8 October 2026. Test-only composition of the approved inactive kernels.
No production source or route changes in this PR.

A generated-Mongo/fake-Drive fixture commits one live note, then pauses the next
SDK create. A simulated clock advances lease ownership. The current owner
explicitly abandons/refunds that pending request, then invokes withRecoveryWipe
with an injected owner-filtered metadata-erasure callback. A post-delete barrier
must roll back metadata and epoch together. Success erases only that owner's
metadata with no tombstones, increments the epoch and retains the sequence.
An unrelated owner's metadata and all generation files remain unchanged.

The delayed old create completes after the wipe, but cannot verify or publish.
A caller with the same token and obsolete epoch also fails before its callback.
Actual HTTP pull is empty. A retained synthetic local note with the same ID can
be admitted again with base zero; its new version/sequence is two, not one.
An actual HTTP push using the stale pre-wipe base then receives note_conflict,
with the existing full-failure charge/refund rule and no Drive write. Pull and
cached receipts preserve the refilled body, ledger and counter.

Local strict typecheck passes. CI must execute these assertions before a pass
is claimed; fixed-code artifact
only. This is an injected candidate wipe callback, not the production DELETE
route, a physical process crash, actual Google Drive deletion or a Hive/device
preservation test. Pending abandonment commits before the wipe transaction; a
failed wipe does not undo that already-final receipt/refund. Physical cleanup is
disabled, so obsolete generations remain. No activation, production DB/index/data,
cleanup, deployment, notice or device action. R11/R16 remain partial.
