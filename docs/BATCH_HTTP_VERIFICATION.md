# Isolated batch, standard window and paged-pull fixture

Fixture-only follow-up from verified Server main
`f269ad6ac1700c2e26c52bc69c6e129bee72cc05`. Production source, schemas,
dependencies, policies and costs are unchanged.

The fixture seeds a third independent synthetic owner at the existing 100-note
tier, with 100 energy and a fresh standard window. This is not a tier-purchase
test. The original two owners retain their free-tier state and sessions.
The descriptor exposes the test owner and one deliberately public synthetic
token; neither exists outside the generated CI database.

The actual HTTP/Mongo case accepts 50 rows for one standard cost of 5, then
refuses another standard request with 429 without creating an operation,
charging or writing. An instant request sends the remaining row for 10.
Six real pull pages return all 51 IDs exactly once with the retained sequence,
without billing or Drive writes. Replaying the first request after both batches
returns the original receipt without a new charge or write.

The App's 50-row and 2.5 MB batch construction require separate real-client
cases. Server routes permit up to 100 rows; this fixture does not assert a
50-row Server limit. Per-note limits remain validated by the real route; full
app.ts middleware/global body-limit behavior is not assembled here. Local type
checking and 59 pure controls must pass; actual database execution is CI-only.
Exact-head and destination-main gates apply. R25 remains partial.

The first PR revision's CI failed in the client-fixture stage. Source inspection
found the replay equality assertion comparing a full response to a Zod projection
that strips undeclared receipt fields. The assertion now compares both complete
wire receipts while keeping typed checks separately. Raw logs were not retrieved;
the exact failing assertion is inferred until subsequent verification, not
established by the step metadata alone. Preserve the failed revision/run record.
