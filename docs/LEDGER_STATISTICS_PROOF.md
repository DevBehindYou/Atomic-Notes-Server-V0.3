# Exact statistics preservation before history pruning

This is an inactive pure projection plus an independent full-ledger test oracle. No production caller, database write, index, cleanup, environment setting or API change is introduced.

Retain lifetime counts by kind for discarded entries. For discarded entries still within the rolling 24-hour window, retain only timestamp, transaction count, positive coins credited and negative energy spent. Combine equal millisecond timestamps exactly; do not round timestamps into hourly or daily buckets. Combine these disjoint archived contributions with the remaining 50 full records. Filter contributions on every read, independently of eventual cleanup.

Preserve current Controller semantics: cutoff inclusive; positive coin deltas only; negative energy deltas only; future-dated legacy records are included because current queries use only a lower bound. Lifetime counts include entries outside the rolling window. Queries older than projection time are rejected because old recent contributions have already been omitted.

The test oracle sums the original full ledger directly. Cases cover 0/49/50/51/1000/10000 records, more than 50 transactions in a day, equal timestamps, cutoff minus/at/plus one millisecond, advancing time, refunds/negative and positive deltas, wrong owners, duplicate source entries and invalid dates. No transaction text or resulting balances enter the projection.

## Boundaries still requiring proof

The retained and archived partitions MUST be disjoint; projection is not an idempotency mechanism. Actual persistence must atomically remove full rows and add contributions exactly once, serialize same-account mutations, reject migration reruns already applied, and read a coherent snapshot to prevent mixing pre/post-pruning partitions. Tests here prove arithmetic, not Mongo isolation or migration correctness.

Exact rolling statistics require temporary timestamped contributions beyond the 50 full history records. Their count depends on activity during 24 hours; this is not a promise that all financial storage is limited to 50 documents. Storage footprint, cleanup cutoff (retain the inclusive boundary), indexes, old-server overlap, migration batching and restart behavior must be tested before activation. No automatic history deletion is implemented yet.
