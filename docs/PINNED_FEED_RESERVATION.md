# R15 pinned notification feed reservation

Confirmed: a reachable, active, unexpired non-dismissible notice disappears after
60 or 120 newer ordinary notices. Test-only baseline
`5cbd541bfe96f489f7c5c912fa6ad7af06472140`, from main
`eec6abd92472c7945590c32372b4f8907014beb3`, fails both regressions in disposable
MongoDB CI 37102087512. Each GET returns 50 rows with 5 MongoDB commands.

Select up to 100 pinned candidates and 100 ordinary candidates separately, with
the existing reachability filter. Apply the existing version and per-user state
filters, reserve result positions for eligible pins, then fill the remaining
positions with ordinary notices. Sort the selected result newest first so the
existing wire ordering remains compatible. GET and read-all use the same feed.

The response remains at most 50 rows. At most 200 notification candidates and
their states are materialized, versus 100 before. One additional notification
query is expected; the authenticated fixture guards a maximum of 6 MongoDB
commands. Existing status/createdAt indexes are unchanged. No performance
improvement or production query-plan result is claimed.

R15 remains partial: more than 50 eligible pins cannot all fit, and more than
100 newer version-excluded pins can still exclude an older eligible pin. The
ordinary group's prior version/dismissal candidate-window limitation also
remains. This PR fixes eviction by ordinary traffic; it does not promise every
active pin remains visible indefinitely. Pagination or a larger retention/feed
policy needs a separate design. No schema, indexes, payload fields, audience,
pricing or publication changes. No production notifications are published.

Rollback: revert this PR. Physical-app delivery and representative production
latency/query plans remain unverified. Final CI results are recorded in the PR
and aggregate verification report.
