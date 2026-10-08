# Inactive obsolete-operation abandonment: verification boundary

8 October 2026. Approved inactive code/disposable fixtures only.

If an unfinished intent's preimage changes, adoption correctly refuses it. After
lease handoff, ordinary settlement also refuses its old token. The new explicit
abandonRecoverySync path lets the current same-epoch owner close unfinished work
without adopting or publishing its content. In the same fenced transaction it
preserves stored committed successes, applies the existing capped/full/partial
refund rules, and marks unfinished intents abandoned under the current token.
It does not delete generations, modify notes/cursors, classify an exception as
permanent, or automatically choose abandonment. Ordinary settlement stays strict.

Generated acceptance first reproduces both existing API refusals. Explicit
fixture-only metadata replacement models an obsolete preimage; this is not proof
of a valid concurrent transaction through the new writer. A post-write barrier
must roll back refund, receipt and journal closure. Retry refunds an all-failed
operation once and preserves the newer committed body. A second case keeps a
committed row/success and charge while abandoning a different obsolete row.
Current and stale callers cannot restage/publish abandoned work. Actual HTTP pull
and failed-receipt replay preserve current bodies, wallet, ledger and sequences.
Retained orphan generations are counted, never cleaned up.

Local strict typecheck passes; a fixture replacement-document type was corrected
before publication. Full unit/integration and generated-Mongo acceptance remain
CI gates. No pure-test import changed from the last 85-test pass. Fixed-code
artifact only.
Same-epoch explicit abandonment is a kernel, not the complete recovery decision
policy. Missing/corrupt/transient Drive classification, delete/restore/wipe,
process crash, old-writer exclusion and real Drive/native/signed-upgrade acceptance
remain separate. No production route activation, index/data migration, cleanup,
pricing/privacy change, deployment or device action. R11/R16 remain partial.
