# Inactive pending-operation lease adoption: verification boundary

8 October 2026. Approved inactive code/generated-database scope only.

Existing preparation cannot re-adopt a partial batch because a row already has a
stored success; settlement also refuses unfinished rows owned by an older lease.
The fixture first requires those existing API refusals. A new bounded same-epoch
adoption transaction preserves committed journal/results and validates every
unfinished preimage before assigning the current lease token. It retains file IDs,
operation, receipt and charge. An injected barrier must roll all adoption writes
back. No production route imports the helper.

The compound generated-Mongo/fake-Drive fixture composes real admission, staging,
commit, adoption and settlement kernels. It commits one of two rows, switches
leases, reads the remaining body from the retained generation, retries that same
file ID and commits the second row without another debit/generation. A second
request pauses an SDK create, changes ownership using an injected clock, then
lets the old create complete: the old worker must fail its final fence and cannot
verify or publish metadata. The current worker uses the retained ID/content and
finishes once. Real HTTP pull returns all three bodies; exact receipts replay
without additional wallet/ledger/version/file changes.

CI must execute the assertions before they are reported passed. Fixed-code
artifact only. Local typecheck/pure status is recorded separately.

Boundary: simulated handoff/barriers are not a process kill, physical crash or real
Drive/OAuth proof. Same-epoch, live-row, complete-manifest adoption only. Conflicting
preimages and wipe epochs refuse; automatic terminal classification, mixed/delete/
restore/wipe orchestration, large batches, production old-writer exclusion and
native/signed-upgrade acceptance remain separate. No new IDs, content persistence,
cleanup, production migration, deployment or device actions. R11/R16 remain partial.
