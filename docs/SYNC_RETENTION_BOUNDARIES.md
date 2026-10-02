# R10: sync retention proof and unresolved boundaries

2 October 2026. These tests characterize the existing implementation; they do not fix retention, change prices, or approve a production migration. Baseline: `010af8c55c3685bb4a4447887d5a08021fc1f015`.

## Source facts

- `src/db/collections.ts:323,337`: thirty-day TTL indexes cover sync operation creation time and deleted-note update time. The operation TTL has no status filter, so pending operations are eligible too.
- `src/lib/syncOperation.ts:28,48,72,88`: absent request history is treated as a new operation; settling abandoned requests can only process remaining records; new nonempty requests are charged.
- `src/routes/notes.ts:181,238,243`: retained completed operations replay before mutable-state checks. Base-version conflicts require existing metadata. An unchanged row is a successful result without a Drive write.
- `src/routes/notes.ts:426`: a pull with no matching metadata returns no rows and can advance to the retained sequence counter. An absent row is not a deletion instruction.
- `src/lib/syncOperation.ts:145`: an all-failed operation can refund its charge. Expired replay therefore does not invariably mean a net second charge.

## Disposable integration matrix

`tests/integration.test.ts` adds four R10 cases. Each uses a distinct synthetic account. Existing suite guards restrict the database to a disposable runner, and the Drive adapter is an in-memory fake. For deterministic cleanup, tests age and remove only their own fixture record. Existing index assertions separately check thirty-day TTL configuration. This simulates the state after cleanup, not the TTL monitor's wall-clock scheduling or thirty days of real device use.

| Case | Retained-record control | Behavior asserted after simulated cleanup |
|---|---|---|
| Deleted note, old cursor and old offline edit | Pull delivers deletion; stale push conflicts without a Drive write | Pull returns no deletion and advances cursor; a fresh request with the old base version recreates the note. The R5 monotonic-version fix still holds. |
| Pending request, charged before any Drive write | Same request resumes with one total instant charge | Removed pending receipt cannot recover the prepaid charge; retry writes once but incurs a second charge. |
| Completed unchanged-content request | Same request replays with no second charge | Same payload and request ID return the same response but charge again, with no additional Drive write. |
| Completed request that created a note | Same request replays its success | Retry conflicts with the surviving metadata and refunds its new charge. Net energy stays unchanged, but the original success cannot be replayed. Subsequent retries replay the new failure without another refund. |

The fixtures use instant mode for billing to isolate receipt retention from the standard cooldown. Wallet balances and ledger counts are checked directly; response equality alone is insufficient evidence of no double charge. No real account is charged. CI must execute this matrix before treating these source-derived behaviors as reproduced.

## Release implications and proposed follow-up — not implemented

R10 remains open. Keeping the same database when replacing the Server preserves records that still exist; it cannot recover records already removed by TTL. The release gate must cover a returning old client with a stale cursor or pending request, in addition to a recent-client replay. These are logical client requests, not a physical two-device test or an authenticated 2.03.5 APK test.

Separate designs are needed for deletion memory and replay memory. Candidate work is durable compact deletion markers with an explicit cloud-wipe distinction, and durable request receipts that preserve outcomes or reject expired retries without charging or writing. Pending-operation settlement must happen before any eligible history removal. Merely extending thirty days postpones the boundary and does not remove it. Treat these as proposals requiring schema/retention and compatibility review; no index, schema, data, economy or protocol change is included here.

Any deletion-reconciliation design must preserve dirty local notes and the existing rule that cloud wipe never tells clients to delete local notes. Any replay design must cover old clients and retained fingerprints/results, lost responses, partial failure, refunds and storage growth. Already purged history cannot be reconstructed from an assumed absence; do not silently infer deletion or replay success.

Rollback for this test-only change is to revert the test/document commit. There is no production data transformation to reverse.
