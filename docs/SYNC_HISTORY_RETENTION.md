# Durable sync history and the existing-database transition

The owner approved implementation and disposable verification on 2 October 2026. **Production execution remains deferred.** This change stops creating the thirty-day deletion/replay TTL indexes. It does not automatically remove indexes from an existing database.

## Behavior

Deleted-note metadata and pending/completed sync receipts have no automatic age cutoff. Long-offline clients can still receive a deletion, and retained receipts preserve the original charge/result. Explicit cloud wipe retains its existing behavior: it removes cloud note metadata without instructing clients to delete local notes. It does not erase sync receipts. Session, OAuth, lock, Controller lockout and diagnostic-log expiration are unchanged. Coin expiry and prices are unchanged.

Note text is not added to MongoDB. Receipts contain IDs, fingerprints and result metadata. Storage grows with retained history; no bounded-storage or production-size claim is made. CI prints raw BSON sizes for synthetic receipts with 1, 50 and 100 results and a representative tombstone. These exclude indexes, compression and operational overhead.

Already-purged history remains unavailable. This change prevents future TTL-based loss after the index transition; it cannot retrospectively prove whether an absent note was deleted or cloud-wiped, or whether a missing request was charged. Historical recovery, signed old-client upgrade and real two-device acceptance remain separate release gates.

## Operator procedure — for a separately authorized rollout

1. Verify the exact existing Vercel project/database, backups, writer compatibility and pinned release. Keep the existing API hostname. Prevent old index-setup jobs from restoring the TTLs and prevent concurrent index administration during this procedure. Preview/test deployments must use disposable data.
2. With owner-managed environment configuration, run the **read-only** inspection:

   ```text
   npm run db:retain-sync-history
   ```

   It prints the database name and exact proposed index drops, never connection values or documents. It creates neither indexes nor missing collections. It refuses unexpected TTL names, key shapes, durations, filters or relevant options on either target collection before any drop.
3. Review the plan. Only the known `notes.tombstone_ttl` and `sync_operations.createdAt_1` thirty-day definitions may be removed. Retained `_id`, per-user note sequence and operation-status indexes continue to support lookups. Removing an expiration index removes its index structure, not the collection's documents. MongoDB documents [dropping an individual index](https://www.mongodb.com/docs/manual/core/indexes/drop-index/) and [TTL behavior](https://www.mongodb.com/docs/manual/core/index-ttl/).
4. **After explicit production execution approval**, use the exact database name observed during inspection:

   ```text
   npm run db:retain-sync-history -- --apply --database <exact-database-name>
   ```

   The database argument must match the configured database. Both targets are preflighted, only the two recognized TTL indexes are dropped, and the final state is inspected again. This tool does not run general `db:indexes`, alter documents, set coin activation or deploy anything. Invalid arguments and connection/index errors exit nonzero with sanitized output.
5. Inspect again and verify no TTL remains on either target. Verify old-dated replay, deletion delivery, refunds and untouched TTLs using approved test accounts. Log the pinned code version, reviewed plan and result without secrets.

DDL across the two collections is not atomic. If the second drop fails, the first may already be complete. Inspect and rerun; absent indexes are a no-op. Preflight/rechecks detect drift but cannot make concurrent index administration safe, hence the exclusive operator window. Records eligible for TTL deletion before transition may already be gone; no tool can promise to undo that.

## Proof and rollback

The first PR commit changes only two integration assertions: both fail against main's old TTL setup. The implementation adds disposable tests for read-only inspection, database mismatch, index drift, partial failure/resume, idempotence, untouched documents/TTLs and repeated general index setup. Year-old logical-client cases cover tombstone delivery/stale-edit rejection, standard and instant pending resume, completed replay, abandoned refunds and explicit wipe semantics. These do not wait for a real TTL monitor or run real phones.

Rollback unrelated Server code only with compatible behavior. Do not rerun an old index script or recreate the two TTLs as an automatic rollback: that could delete the newly retained history. Production reversal or future compaction requires its own reviewed preservation policy.

The separate characterization PR #10 remains useful: manually removing historical records still reproduces the old-loss boundary. Its tests do not imply that this change restores removed records.
