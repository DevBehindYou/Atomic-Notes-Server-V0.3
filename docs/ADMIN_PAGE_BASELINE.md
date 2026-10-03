# Disposable admin notification baseline

Run `npm run benchmark:admin-pages` only with a disposable localhost MongoDB
replica set. The command rejects non-local connection strings, generates its
own database name, uses public synthetic credentials and deletes only that
database in its cleanup. It cannot opt into Atlas or a supplied database name.
CI uses the existing disposable Mongo service after integration verification.

For 1, 1,000 and 10,000 synthetic notices (mixed statuses and tied timestamps),
seed one recipient and read record per notice. For the first and next page when
available, warm up five times and measure 100 sequential requests. The actual
Hono admin route verifies ordered IDs, delivery counts and the 50-row bound.
Output retains every duration/command count, p50/p95/min/max, Node/Mongo versions
and the CI source commit. The candidate find/sort/limit query also records
executionStats: returned/examined documents, examined keys and winning stages.

Timings include in-process routing/auth, loopback Mongo, delivery aggregation and
JSON decoding. They exclude Vercel cold starts, remote network, real Atlas/Drive,
browser rendering and concurrent-user load. This is a repeatable lab baseline,
not a production latency, scalability, throughput or cost-effectiveness claim.
No timing threshold is asserted before a representative baseline is understood.
Failing HTTP/count/order assertions fail the run instead of hiding bad samples.

Only existing application indexes are created in the temporary database. This
experiment does not change production query code, index definitions, schema,
retention, dependencies or economy. Any proposed index/data migration remains
a separate approval and rollout item. R27 stays partial. Rollback removes this
benchmark command, CI step and documentation.
