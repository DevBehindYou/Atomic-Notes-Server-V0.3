# Index proposal C25: owner/sequence/id index for note pull

**Status: proposed, NOT applied.** Nothing in this change creates, hides or
drops a production index or changes `ensureIndexes()`. Adoption needs Codex
review, owner approval and a separate rollout change. The evidence comes from
the disposable fixture in [QUERY_DIAGNOSTICS](../QUERY_DIAGNOSTICS.md).

Evidence source: GitHub Actions `Server verification`, step "Disposable client
HTTP fixture smoke", `tests/queryDiagnostics.fixture.test.ts`, Mongo 7.0.45
single-node replica set, synthetic fixture of 7,800 notes / 1,260 sessions /
5,500 sync receipts / 14,000 ledger rows / 1,600 coin lots across 401 owners.
Run IDs: 42378072817 (head `84ae2e8`, all steps passed). The note and session numbers below are identical in
the earlier run 42377460331 (head `ed85155`). That run failed only on a test expectation about which queries are skipped.

## Finding 1 (P1, proposed index): every pull page sorts the owner's whole range

`GET /notes/pull` (`src/routes/notes.ts:516`) runs
`find({ userId, syncSequence: { [$gt: after,] $lte: upper } }).sort({ syncSequence: 1, _id: 1 }).limit(11)`.
The declared index `{ userId: 1, syncSequence: 1 }` supplies the range but not
the `_id` tie-breaker in the sort, so the plan is `IXSCAN → FETCH → SORT`.
The server reads and sorts every remaining owner row on every page.

| Measure (heavy owner, 2,940 sequenced notes) | Current indexes | With `{ userId: 1, syncSequence: 1, _id: 1 }` |
| --- | --- | --- |
| First page: plan | IXSCAN `userId_1_syncSequence_1` + FETCH + **SORT** | IXSCAN candidate + FETCH + LIMIT (no SORT) |
| First page: keys / docs examined, returned | 2,940 / 2,940, 11 | 11 / 11, 11 |
| Next page (`after=` 10th row) | 2,930 / 2,930, 11 | 11 / 11, 11 |
| Full sync walk, 294 pages, 2,940 rows (each exactly once) | 433,650 docs examined (max 2,940 per page) | 3,233 docs examined (max 11 per page) |
| `encOnly=true` first page | 2,940 / 2,940, 11 | 14 / 14, 11 |
| Legacy `since=` (7 days, 56 matches) | 56 / 56 via `userId_1_updatedAt_1` + SORT | unchanged (planner keeps the `updatedAt` plan) |
| Typical owner (12 notes), first page | 12 / 12 + SORT | 11 / 11, no SORT |

A full first sync is therefore quadratic in account size (about 147 documents
examined per returned row at 2,940 rows); a 3,000-note account examines about
434 thousand documents, all read from the free-tier cluster's cache or disk.
With the candidate it is linear (1.1 per row). Pagination correctness is
unchanged in both cases: the walk returns every sequenced row exactly once.

### Proposed index

```js
db.notes.createIndex({ userId: 1, syncSequence: 1, _id: 1 }, { name: 'userId_1_syncSequence_1__id_1' })
```

It **replaces** `{ userId: 1, syncSequence: 1 }`: that index is a strict prefix,
and no other inventoried query needs it. In the disposable "replacement" phase
the old index was hidden and every inventoried `notes` and `sessions` query
re-explained: zero problems, all hot note queries still index-served
(`summaryReplacement.problemIds` is empty).

### Write and size considerations

- Steady state after replacement: the same number of declared note indexes
  (four including `_id`) and one index update per metadata write, as today. Each
  push already rewrites `syncSequence`, so the old entry is already
  maintained on every write.
- During the transition both indexes exist: one extra index write per note
  metadata write until the old index is dropped.
- Size: each entry grows by one 36-character `_id` string. That is an estimate
  of about 40 bytes per note before WiredTiger prefix compression, or about
  4 MB per 100,000 notes. The disposable run does not measure storage size,
  because it varies between runs. Measure `$collStats.storageStats.indexSizes`
  on staging before and after the build and confirm headroom against the 512 MB
  free-tier limit.
- Build: `createIndex` on a populated collection takes collection-level locks
  only at the start and end. Expect a short build on note metadata (no
  content).

### Alternative considered: drop `_id` from the sort

Sequences are issued per owner by `sync_counters` `$inc`
(`src/lib/noteMetadata.ts:84`), so `{ syncSequence: 1 }` alone may be enough and
would let the existing index serve the page with no index change. It is not
proposed as the default, because it changes route code (C21 scope) and
depends on an unproven invariant: no duplicate `syncSequence` per owner in
legacy, recovery-written or imported rows. A read-only uniqueness check would
need to run first. Both options need review.

### Rollout (separate approved change)

1. Approve this proposal (Codex review plus owner).
2. Staging: build the new index by name. Run
   `npm run db:explain -- --read-only --database <staging db>` with
   `EXPLAIN_MONGODB_URI` set to staging. Confirm `notes.pull.first` and `notes.pull.next` show
   no SORT and examine at most 11 documents.
3. Hide (do not drop) `userId_1_syncSequence_1` with
   `collMod: 'notes', index: { name, hidden: true }`. Re-run the read-only diagnostics and watch pull
   latency and errors for an agreed window.
4. In the same reviewed PR, change `ensureIndexes()` to declare the new
   index and stop declaring the old one. Rollout-order evidence: with the old
   index hidden, the current `ensureIndexes()` run returned
   `ok` and left both hidden indexes hidden (`stillHidden: true`). A deploy
   that still runs today's `ensureIndexes()` during the observation window is
   therefore safe. After a drop, however, it would rebuild the old index, so the
   `ensureIndexes()` change must be deployed before step 5.
5. Production: repeat steps 2–3 under the deployment checklist, then drop the
   hidden index after the observation window.

**Rollback:** before the drop, unhide the old index (`hidden: false`, instant,
no rebuild) and drop the candidate. After the drop, recreate
`{ userId: 1, syncSequence: 1 }`, which is an online build. No data migration
is involved, and query results are identical with either index.

## Other findings (no index proposed)

| Query | Evidence (heavy owner unless noted) | Recommendation |
| --- | --- | --- |
| `ledger.historyLegacy` (`src/lib/energy.ts:329`, unmarked wallet) | 2,000 / 2,000 examined + SORT for 50 rows | Already covered by the reviewed ledger ordering work ([LEDGER_ORDERING_INDEX_PROOF](../LEDGER_ORDERING_INDEX_PROOF.md), `orderingIndexReady` in `db:inspect-ledger-history`). Economic scope (C27). No new proposal. |
| `ledger.retentionBatch` (`src/lib/ledgerRetention.ts:27`) | 2,000 examined + SORT for 100 (maintenance) | Same ordering index as above. |
| `sessions.inventory` (`src/lib/sessionManagement.ts:49`) | 60 / 60 examined + SORT for 5 via `userId_1`. Candidate `{userId:1, createdAt:-1, _id:-1}` removes the SORT but still examines 60, because revoked rows are filtered after the fetch | **Not recommended.** Rows per owner are bounded by the 180-day TTL and sign-ins. The gain is one 60-row in-memory sort, which does not justify a write on every sign-in. |
| `coins.detailsNext` (`src/lib/coinLots.ts:132`, `$or` cursor) | Page 2 examines 101 for 51: the scan starts at the newest lot, not at the cursor | Query rewrite, not an index: add the range conjunct `creditedAt: { $lte: at }` beside the `$or`. Coin expiry is inactive. Hand to the economic owner (C27). |
| `coins.dueLots`, `coins.activeLots` | 275 examined for 18 and 400 for 143. Expired lots with `remaining: 0` stay in range | Observation only. Inactive policy, monetary records have no TTL, and any change belongs to C27. |
| `admin.notificationsNext` (`src/routes/admin.ts:265`) | COLLSCAN + SORT over 300 notices for 51 | Admin-only. Existing [ADMIN_PAGE_BASELINE](../ADMIN_PAGE_BASELINE.md) tracks it. Revisit only if notice counts grow. |
| `admin.statsActiveNotes`, `statsActive24h`, `recentSessionOwners` | COLLSCAN of 7,800 notes, 401 wallets and 1,260 sessions | Accept. Dashboard and publish-time aggregates do not justify a write cost on every note or session write. |
| `admin.userByEmail` (case-insensitive regex) | IXSCAN `email_1`: 2–113 keys for one match, growing with user count | Accept for admin. A collation or normalized-email index is a separate identity change (C28). |
| `notes.list` (`GET /notes`) | Index-served (2,400 / 2,400) but unpaginated | Bounded by the note limit. API pagination would be a separate contract change. |

All hot paths are index-served with no collection scans. These are session
lookup (IDHACK), session management, note point reads, push lookups, counters,
sync receipts and pending checks, logout attempts and receipts, the
ordered-history ledger window and the notification feed. Their examined counts
stay within their point/page/match bounds.

## Limits

These results come from synthetic data on a single node with Mongo 7.0. Atlas
plan choice depends on real distributions and server version, so re-run the
read-only diagnostics there. The report counts optimizer work, not latency,
throughput, cost or build time. No production, staging or Atlas database was
accessed.
