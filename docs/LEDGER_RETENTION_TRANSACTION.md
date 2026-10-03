# Inactive transactional history cleanup

No production route, operator command or write path invokes this module. Do not enable it before global Controller statistics consume archived contributions and migration/index/replay proofs are complete.

archiveLedgerBatch locks the existing wallet through historyRevision, selects at most 100 rows beyond the newest 50, preserves lifetime kind counts and exact recent contributions, and deletes the selected owner-scoped IDs in the caller transaction. Caller retries the whole transaction. Repeat batches see only remaining rows; rollback restores both records and contributions. Monetary balances are unchanged. Sorting is currently timestamp/ID; account sequence remains pending.

readRetainedLedgerStatistics uses one snapshot transaction across retained rows, lifetime counts and recent contributions. withTransaction now accepts optional Mongo transaction options; existing callers retain their previous default options. This reader is per-account and inactive; current global Controller queries are unchanged.

Disposable proof covers rollback after pruning, concurrent/repeated cleanup from 255 to 50 rows, exact totals, owner isolation, expired recent contributions, and five actual Controller credit requests racing cleanup and snapshot reads. Concurrent observations must preserve constant spending and match transaction-count increases to coin credits. Scheduling coverage is empirical, not exhaustive.

Pending: deterministic pause-at-each-read interleavings, real sync/refund/coin-expiry/replay after eviction, global statistics reader, sequence semantics, indexes and performance, migration preflight/restart and automatic write-path activation. Recent contributions require finite cleanup beyond the 50 full-history records. No Atlas writes or storage savings claimed.
