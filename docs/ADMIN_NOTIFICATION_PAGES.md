# Bounded admin notification history

GET /api/admin/notifications requires the existing admin key and now returns
up to 50 rows with next_cursor (null when exhausted). limit accepts 1–50 and
defaults to 50. cursor is an opaque base64url tuple of created_at and id.
Malformed cursors/limits return 400 after authorization. Rows retain the same
wire fields and delivery counts. The public and App notification feeds do not
use this endpoint and are unchanged.

The list queries at most limit+1 candidates; only the returned page's ids enter
delivery-count aggregation. Descending createdAt/_id order resolves timestamp
ties, and tuple cursors work after the boundary row is deleted. This is a
continuation through current history, not a frozen snapshot: new notices before
the cursor appear after Refresh rather than shifting the next page.

Proof-first baseline b23c893 on main 641ee86 fails three new disposable
integration cases: default response has 134 rows instead of 50, pagination
input is ignored and a boundary cursor is absent. All 68 other runner entries
pass. Before/after fixtures cover 131 new notices, all three statuses, 67 equal
timestamps, exact ordered traversal without duplicates, validation after auth,
delivery count defaults and deletion of a page boundary. CI must independently
pass all 72 database/API runner entries, 21 unit tests, typecheck, audit, build
and plain-Node compiled entrypoint verification.

No collection, schema, index, environment, dependency, economy or production
data change. A query-plan/latency improvement is not claimed: scanning/sorting
and delivery-count work can remain expensive without an appropriate index or
summary strategy. R27 stays partial until Controller consumption is shipped;
user search/log investigation and representative scale measurements remain.

Rollout: ship the matching Controller pagination consumer with the optimized
Server. An older Controller will display only the first page; the new Controller
must use Load more. Old App clients do not call this admin endpoint. Revert the
Server PR and matching consumer together if pagination must be rolled back.
Production deployment remains deferred until optimization completion.
