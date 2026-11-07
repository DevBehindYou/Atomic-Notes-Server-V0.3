# Mongo query and index diagnostics (C25)

`npm run db:explain` explains the Server's hot MongoDB queries with
`executionStats` and reports, per query, the winning plan stages and indexes,
documents/keys examined against documents returned, and the owner and
matching-row cardinality. It flags collection scans, blocking in-memory sorts
and examined counts beyond each query's natural bound. It has no apply mode and
never creates, changes or drops an index outside a database it generated.

Code: `src/db/queryDiagnostics.ts` (inventory, pure summary/classification,
guards, read-only runner), `src/db/queryDiagnosticsFixture.ts` (disposable
fixture and orchestration), `src/scripts/explainQueries.ts` (CLI).

## Modes and safety guards

The connection string is read only from `EXPLAIN_MONGODB_URI`. The npm script
does not load `.env` and never reads `MONGODB_URI`.

| Mode | Command | Guards |
| --- | --- | --- |
| Disposable baseline | `EXPLAIN_MONGODB_URI=mongodb://127.0.0.1:27017/?replicaSet=rs0&directConnection=true npm run db:explain -- --seed-disposable [--with-candidates]` | Every host must be `127.0.0.1`, `localhost` or `[::1]` over `mongodb://` (no SRV). Generates `atomic_explain_<20 hex>`, refuses a non-empty database, seeds it with the production `ensureIndexes()`, and drops only that database in `finally`. A command monitor records any command sent to another database other than handshake/`buildInfo`/`endSessions`. `--with-candidates` builds, hides and drops proposed indexes inside that same database only. |
| Read-only inspection | `EXPLAIN_MONGODB_URI=... npm run db:explain -- --read-only --database <name> [--max-pages 1-200]` | The database must be named explicitly. Only reads are sent (find, aggregate without `$out`/`$merge`, count, distinct, explain of those, listIndexes, listCollections, cursor/handshake commands). Any other command observed by the monitor, or a read against another database, fails the run. Every read has `maxTimeMS` 15 s. The probe owner is the largest note owner; pagination walking stops after `--max-pages` (default 30). |

Without a mode, with both modes, with unknown arguments, or without the URI the
command exits 1 before connecting. Errors print only fixed codes; driver errors,
hosts, database names and credentials are never printed.

Read-only mode was proven write-free on disposable data (`dbHash` before and
after, and the observed command names). It has **not** been run against Atlas,
staging or production; doing so is a separate operator decision. It reads note
metadata for one owner and runs owner/matching counts, so run it off-peak.

## Report contents and sanitisation

The JSON report contains query ids, cited source lines, collection names,
filter outlines with fields and operators only (`{userId:eq, syncSequence:$gt,$lte}`),
sort/limit, plan stage and index names, counts and verdicts. It contains no
user/note/ledger ids, session hashes, fingerprints, emails, Drive ids, timings,
database names or connection strings; `assertSanitized()` rejects a report that
does. The disposable report is deterministic: ids derive from fixed labels, the
synthetic clock is `2036-01-01T00:00:00Z` (later than every real run date, so
TTL monitors cannot remove rows mid-run), and no timings are recorded.

Verdicts: `problem` = a hot query collection-scans or examines more than its
bound; `warn` = the same for admin, maintenance or inactive paths; `ok`
otherwise. `BLOCKING_SORT` and `RESULT_UNPAGINATED` are informational. Bounds:
`point(n)` ≤ n documents; `page(limit)` ≤ limit (+skip); `filtered` ≤ rows
matching the full filter; `owner` ≤ the owner's rows; `global` unbounded
(admin aggregates). Key scans may exceed the document bound by one key per
point interval, or two for ranges.

## Disposable fixture (deterministic)

401 accounts: 400 typical owners (12 notes with tombstones and encrypted rows, 3
sessions, 10 sync receipts, 30 ledger rows — half on ordered history — and 3
coin lots) and one heavy long-lived owner (3,000 notes including 60 written
before `syncSequence`, 60 sessions of which 5 active, 1,500 sync receipts with 2
pending, 2,000 legacy ledger rows with tied timestamps, 400 coin lots and 30
coin receipts). Plus 300 notifications and per-owner counters and logout
attempts. Totals are printed by the fixture test.

## Query inventory

| Query id | Source | Filter / sort / limit | Serving index (declared) |
| --- | --- | --- | --- |
| auth.verifySession | src/lib/session.ts:47 | `_id` | `_id` |
| sessions.liveCurrent | src/lib/sessionManagement.ts:41 | `_id, userId, revoked, expiresAt>` | `_id` |
| sessions.inventory | src/lib/sessionManagement.ts:49 | `userId, revoked, expiresAt>`; createdAt -1, _id -1; 6 | `userId:1` (planner choice) + in-memory sort |
| sessions.limitActive | src/lib/session.ts:40 | `userId, revoked`; createdAt -1; skip 5 | `userId:1,createdAt:-1` |
| logout.attemptById | src/lib/logoutAttempt.ts:42 | `_id, userId, sessionHash` | `_id` |
| notes.list / notes.count | src/routes/notes.ts:191, 198, 286 | `userId, deleted:false` | `userId:1,deleted:1` |
| notes.byIdOwner / notes.pushLookup | src/routes/notes.ts:206, 272 | `_id[, userId]` / `_id $in` (batch) | `_id` |
| notes.pullCounter | src/routes/notes.ts:507 | sync_counters `_id` | `_id` |
| notes.pull.first / next | src/routes/notes.ts:516 | `userId, syncSequence ($gt,) $lte`; syncSequence 1, _id 1; 11 | `userId:1,syncSequence:1` + in-memory sort |
| notes.pull.since / encOnly | src/routes/notes.ts:513-516 | as above + `updatedAt>=` / `encV:0` | `userId:1,updatedAt:1` or `userId:1,syncSequence:1` + sort |
| notes.wipeScan | src/routes/notes.ts:573 | `userId` | any `userId` prefix |
| sync.findOperation | src/lib/syncOperation.ts:40 | `_id` | `_id` |
| sync.pendingExists / pendingList | src/lib/logoutAttempt.ts:61, syncOperation.ts:115 | `userId, status:pending` | `userId:1,status:1` |
| logout.receipts | src/lib/logoutRecovery.ts:93 | `userId, _id $in` | `_id` |
| ledger.historyLegacy | src/lib/energy.ts:329 (unmarked wallets only) | `userId`; createdAt -1, _id -1; 50 | `userId:1,createdAt:-1` + in-memory sort |
| ledger.historySequenced | src/lib/energy.ts:329 (historyRetentionVersion 1 only) | `userId`; historySequence -1; 52 | `userId:1,createdAt:-1` + sort (≤ 52 rows by retention) |
| ledger.appendWindow | src/lib/ledger.ts:20 (historyRetentionVersion 1 only) | `userId`; 52 | `userId:1,createdAt:-1` |
| ledger.retentionBatch | src/lib/ledgerRetention.ts:27 | `userId`; mode-dependent sort; skip 50, 100 | `userId:1,createdAt:-1` + sort |
| coins.dueLots / activeLots | src/lib/coinLots.ts:34, 57, 135 | `userId, remaining>0[, expiresAt]` | userId-prefixed lot indexes (`remaining` filtered after fetch) |
| coins.detailsFirst / Next | src/lib/coinLots.ts:132 | `userId[, $or cursor]`; creditedAt -1, _id -1; 51 | `userId:1,creditedAt:-1,_id:-1` |
| coins.operation | src/lib/coinLots.ts:88 | `_id` | `_id` |
| feed.ordinary / feed.recipientOf | src/lib/notificationFeed.ts:93, 59 | `status:active, $and[...]`; createdAt -1; 100 / distinct by `userId` | `status:1,createdAt:-1` / `userId:1` |
| admin.notificationsNext / lastSession | src/routes/admin.ts:265, 64 | `$or` cursor; createdAt -1, _id -1; 51 / `userId`; createdAt -1; 1 | none (COLLSCAN + sort) / `userId:1,createdAt:-1` |
| admin.userByEmail, statsActiveNotes, statsActive24h, recentSessionOwners | src/routes/admin.ts:58, adminStats.ts:32-34, notificationFeed.ts:21 | case-insensitive email regex, global counts, session distinct | none (admin-only scans) |

A shape that cannot run for the probe owner, because of missing data or the
wallet's ledger mode, is reported as `skipped: not_applicable`, not explained.

## Baseline (CI run 42378072817, Mongo 7.0.45)

Two probes (largest and typical owner) × 36 query shapes = 72 entries: 6
not applicable, 50 ok, 12 warn, 4 problem. The fixture test pins the verdict
lists, so a plan regression or improvement fails the test until reviewed.

- **Problems:** `notes.pull.first` and `notes.pull.next` for the largest owner
  (2,940 and 2,930 documents examined and sorted in memory to return 11);
  `notes.pull.first` for the typical owner (12 examined for 11, the same plan);
  and `ledger.historyLegacy` for the largest owner (2,000 for 50; already covered
  by the reviewed ledger ordering index work).
- **Warnings:** admin dashboard scans, the admin notification cursor page, the
  inactive coin-lot reads and the ledger retention batch.
- **Pull walk** (294 pages, 2,940 rows, each exactly once): 433,650 documents
  examined with today's indexes, 3,233 with the candidate index.
- **Read-only mode** on a separately seeded database left `dbHash` unchanged
  and reproduced the largest-owner section exactly. Every command it sent was
  on the read allowlist, and this was asserted.

Findings and the index proposal: [INDEX_PROPOSAL_C25](proposals/INDEX_PROPOSAL_C25.md).

## Limits

The fixture is synthetic and single-node; plan choice on Atlas depends on real
data distribution and server version. The report measures optimizer work
(keys/documents examined), not latency, throughput, Atlas cost or index build
time. Query shapes are copies of the cited call sites; a change to a call site
needs the matching inventory change. Inactive recovery-journal queries
(`note_write_intents`, candidate indexes in `src/db/recoveryContract.ts`) are
out of scope.
