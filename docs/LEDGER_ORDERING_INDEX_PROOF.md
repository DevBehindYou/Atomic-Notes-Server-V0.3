# Disposable history ordering index experiment

The current owner/time index cannot fully order equal timestamps by UUID. This fixture creates 10,000 tied-timestamp entries for one account, explains the exact cleanup selection (owner filter; createdAt/ID descending; skip 50; limit 100), then builds an experimental owner/time/ID index only in the suite's disposable DB and explains again.

Acceptance: old plan examines at least 10,000 documents with a sort; candidate plan returns 100, examines at most 155 keys and 150 documents, and has no blocking SORT. Selected IDs must be exactly positions 50–149; the real cleanup removes that batch while keeping the newest 50 IDs unchanged. The experimental index is dropped in finally. No change to production ensureIndexes or database indexes.

This proves optimizer work for a synthetic single-account batch, not production throughput, index-build cost, global statistics scaling, or the final sequence-based ordering design. Actual index deployment requires a separate preflight and approval. The full cleanup transaction also performs statistics writes and contribution cleanup; those costs are outside this selection-plan assertion.
