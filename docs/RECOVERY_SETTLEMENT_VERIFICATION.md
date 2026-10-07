# Inactive terminal settlement: verification boundary

8 October 2026. Approved inactive implementation/disposable fixtures only.

The existing refund transaction body is extracted into `finishSyncInSession`.
Production `finishSync` keeps its current fast path and transaction fallback;
prices, capped refunds, ledger retention and standard-window restoration are unchanged.
The new `finishRecoverySync` is not imported by production routes. A valid fenced
candidate settles from stored authoritative results and transitions prepared/
verified intents to abandoned in the same Mongo transaction. Committed journal
versions/sequences must match stored successes. It refuses inconsistent successes,
foreign operations, wrong epochs and unadopted pending leases. Closed receipts
with terminal journals are replayable without a second refund.

Generated localhost acceptance requires a real journal validator rejection after
financial writes, then a test barrier after all writes: both must roll back wallet,
ledger, cooldown, operation and journal. Retry checks a standard five-energy charge
with a real admin grant to 118: refund is capped at two and the standard window is
restored. A partial two-row candidate commits one immutable generation, keeps its
success and charge ten, abandons the other row, and repeats real HTTP receipts
without another charge/refund or generation. Malformed success/owner controls refuse.
CI must execute these assertions before they are reported passed; fixed-code
artifact only. Local strict typecheck and all 85 pure tests pass. The fixture counter type was
corrected before publication; generated Mongo execution is still pending CI.

Boundary: debit/initial intents are still separate assembly steps. No complete
orchestration, pending lease adoption after partial commit, delete/restore/wipe
integration, process crash, real Drive, native/two-device or signed upgrade proof.
No production activation, index/data migration, orphan cleanup or legacy repair.
Stored success is historical and need not match a later note version; the fixture
checks the candidate transaction that produced it. R11/R16 remain partial.
