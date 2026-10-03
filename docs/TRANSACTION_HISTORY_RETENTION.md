# Transaction history: 50-entry limit and retention gates

Owner requested latest 50 history entries per user, older entries removed as new entries arrive. This PR implements only the non-destructive API boundary. Physical retention remains pending; no storage savings are claimed yet.

## Implemented boundary

GET /api/energy returns at most 50 entries, sorted by server createdAt descending and UUID descending for deterministic ties. The response fields are unchanged. Balance reads can still perform their existing daily-grant / coin-expiry operations. Limiting history itself deletes nothing. Controller statistics continue to use the full ledger.

The integration fixture exercises 0, 49, 50, 51 and 205 records, timestamp ties, exact IDs, unchanged wallet, unchanged stored history, and a second user's isolation. A before-fix CI run is dispatched separately; its actual outcome must be recorded rather than assumed.

## Physical-retention design (not implemented or activated)

1. Centralize every ledger writer: energy.writeLedger, syncOperation charge/refund, Controller adjustment, coinLots expiry. No writer may bypass retention.
2. Within the existing monetary transaction, acquire a per-account revision, assign a monotonic history sequence, record the entry and statistics, then trim to 50. Retry the complete transaction on Mongo write conflicts; never issue a detached background delete. Refuse missing-wallet states. Replay paths must not append or increment statistics again.
3. Backfill sequence for legacy entries using createdAt and UUID as deterministic ties. New writes use account sequence, not device clocks. A compound owner/sequence index supports trimming. Index creation requires the separate deployment gate.
4. Preserve exact statistics before deletion. Lifetime kind totals can be per-account compact counters. Exact rolling 24-hour totals cannot be reconstructed from 50 rows or coarse daily buckets. A candidate is temporary, minimal timestamped contributions for pruned rows still in the 24-hour window, excluded by query after the cutoff regardless of asynchronous TTL cleanup. These are statistical contributions, not full transaction documents. Evaluate footprint and concurrency in disposable CI before selecting this design. Do not introduce approximate statistics under existing exact labels.
5. Leave atomic_users balances, coin_lots, coin_operations and sync_operations intact. History eviction must neither expire money nor shorten request replay protection. No full archive is created in the same database merely to move the unbounded growth elsewhere.
6. Make inspection the default for migration tooling. Report counts without personal data; application requires an exact database match and explicit apply mode. Process bounded account batches; store a transactional per-account migration marker and statistics so interruption/rerun cannot duplicate totals. Existing large histories need bounded processing before the final serialized cutover; do not place an unbounded aggregation/deletion in a live wallet transaction.
7. Reconcile lifetime and rolling-window totals before and after migration at a fixed reference time. Stop on mismatches. Have a verified backup and restoration rehearsal. Disable old server writers before activation. Software rollback cannot recreate deleted history.

## Acceptance matrix for the remaining work

- Concurrent charges, grants, expiry and refunds keep at most 50 committed history rows per migrated account, with correct balances and totals.
- Inject failure before insert, after insert, during statistics update, during trim and before commit: all effects roll back together.
- Replay a request after its history row is evicted: no second debit, credit, refund or statistics contribution within the supported replay window.
- Refund when the original charge is no longer visible, including cap-limited refund and concurrent settlement.
- Evict old coin credits and verify unspent lots, grandfathered coins, six-month expiry and allocations are unchanged.
- More than 50 events within 24 hours, timestamp ties and exact cutoff boundaries preserve Controller totals.
- Interrupted migration, rerun, mixed migrated/unmigrated accounts, and a writer racing cutover do not lose or double-count events.
- App refresh replaces history; 2.03.5 and 2.03.9 accept the same wire fields; the new app explains the 50-entry window.
- Measure 50 / 1,000 / 10,000-row cases, transaction retries, query plans and storage including statistics. Row deletion is not evidence of immediate Atlas billing reduction.

## Release boundary

R24 stays partial until physical retention, statistics preservation, migration rehearsal, client presentation and disposable integration proofs pass. Production deletion, index builds and activation are not performed by this PR. Owner approval of the concrete production preflight remains required.
