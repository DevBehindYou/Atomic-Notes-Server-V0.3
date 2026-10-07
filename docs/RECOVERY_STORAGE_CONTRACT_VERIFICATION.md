# Inactive recovery storage contract: verification boundary

8 October 2026. The owner approved inactive implementation and disposable tests
after reviewing Server #41; production activation/migrations remain separate.

**Implemented, inactive:** `src/db/recoveryContract.ts` defines strict bounded
intent/gate parsers, 1–50 row operation validation, safe counter increment and
three candidate index declarations. No database module, production route or index
initializer imports it. It creates no collection/index, performs no database or
Drive operation, and adds no marker to an existing production record.

The contract refuses unknown/content fields; mismatched deterministic owner/
operation/row identities; mixed operation fingerprints, leases or wipe epochs;
duplicate note/generated identities; staged IDs that equal any earlier pointer;
invalid terminal/commit states; absent verified content identity; malformed
hashes/flags/dates/unsafe counters; and overflow. A parser's accepted object is
not proof of authorized ownership, readback, a persisted intent or a fenced commit.

**Verified locally:** type checking and all 85 pure tests pass, including thirteen
new synthetic contract controls. They are acceptance controls, not a claimed
causal fix to existing production writes. Exact PR/main CI remains a separate
gate. The first fixture typecheck exposed untyped Mongo collections defaulting
`_id` to ObjectId; explicit contract/gate collection types corrected this before
publication.
The additional CI fixture uses the existing generated-loopback-database guard to
create only these candidate indexes and synthetic records. It checks exact
catalog keys/options, same-owner staged-ID uniqueness, duplicate record identity,
multiple null reuse rows, distinct-owner scope and a unique persistent gate with
no TTL. Its selected artifact contains only fixed phase/outcome codes. CI must
execute this fixture before its catalog assertions can be claimed as verified.
Transaction fencing, crash/restart, settlement/refund and immutable Drive commit
acceptance remain separate unimplemented stages.

No journal or test-only writer path exists yet. Existing overwrite-before-Mongo
behavior remains characterized by #38. R11/R16 remain partial, with no closure
credit. No real database/index/data, native device, release or deployment action.

During preparation, two new draft files briefly landed in a separate accidental
folder under the original workspace after a missing scratch-path value. Neither
was an existing source file. Both were moved into the intended review checkout,
and only their newly created empty folders were removed; the accidental root is
confirmed absent. No original existing file was changed or staged. Subsequent
tool paths use explicit absolute workspace values.
