# Bounded test-only Drive write failures

The guarded loopback fixture can reject create/update writes for at most 50
distinct synthetic note UUIDs. This control is test assembly only, requires its
synthetic control token, refuses malformed bodies and has no production route.
Fault counters separate attempts, failed calls and completed simulated writes.

Disposable real HTTP/Mongo tests require partial success to retain one charge and
commit only accepted metadata, all-failed upload to refund the actual debit, and
both completed results to replay without further writes/debits/refunds. Disarming
the adapter does not rewrite completed receipts; a new request can retry failed
content. The existing smoke/cleanup suite remains enabled alongside this check.

These are existing-route characterizations with fake Drive errors. They do not
test Google retries, Drive/Mongo commit failure recovery, cap-limited refunds,
production activation, App receipt rendering, Android or physical devices. No
src/api/schema/lockfile/dependency change. Local guards/typecheck and exact CI
database checks are required; local unit success alone is not Mongo execution.

Publication checkpoint: local typecheck and 55 unit tests pass (four additional
fault-control guards). Real database/HTTP execution awaits exact-head CI.
