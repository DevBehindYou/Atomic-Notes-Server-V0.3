# Safe logout implementation — 9 October 2026

## Owner decision

The owner requested: check unsynced notes before logout; if sufficient Energy,
explain and run sync; otherwise provide a free Emergency InstaSync; finish logout
only after synchronization succeeds; never silently discard changes.
The owner explicitly selected **once per logout attempt**, not once per account.
That permits a new allowance on a later logout, including after another login.
There is no lifetime entitlement counter or emergency wallet credit.

## Completed first layer

**Verified in code:** `src/lib/logoutContract.ts` is a pure, inactive contract.
It defines strict metadata-only attempt manifests bound to user, attempt and
hashed session. They contain up to five batches of up to fifty unique rows and
2.5 MB per batch, matching current App per-sync bounds. Insufficient aggregate
Energy selects emergency funding; paid batches retain the existing instant price.
Fingerprints normalize through the existing wire schema and match the existing
instant operation identity. The receipt validator requires all declared rows to
be successful, versioned and closed, with the exact funding and session binding.

**Verified by pure tests:** bounds, unknown fields, duplicate rows/requests,
negative/unsafe budget, wire ordering/defaults, payload/base-version binding,
foreign/pending/failed/partial receipts and terminal states. These are unit tests,
not actual free uploads, Mongo transactions, Android or production proof.

**Verified boundary:** this module has no database or network imports and no
production caller. It creates no entitlement, debits/credits/refunds no Energy,
changes no existing push endpoint, and does not sign anyone out.

## Required next layers

1. **Server durable admission and routes:** validate a complete immutable manifest
   under the existing notes lock; use a fresh wallet after applicable daily grant.
   Persist only hashes/IDs, never note content or raw session tokens. Reserve one
   active attempt for that session. A retry of the same attempt returns its original
   funding decision. A mismatch refuses without side effects. Ordinary sync remains
   priced normally; emergency admission is limited to this manifest.
2. **Server push and completion:** bind each admitted request to its declared
   fingerprint/row IDs and session. Reuse existing receipt idempotency, version
   conflict, quota, size and recovery guards. Emergency operations record zero
   charge and zero refund; they do not advance the standard window. Paid operations
   use normal instant charging. Atomically complete an attempt and revoke only its
   bound session after every declared operation succeeded. Failure/partial commit
   never authorizes cache clearing. Persisted receipts remain authoritative.
3. **App orchestration:** quiesce automatic/new writers; check raw Hive dirty,
   unanswered and live local-only rows, including locked vault rows. Require unlock
   before sealing hidden unsent content, without coercing plaintext upload. Resolve
   saved requests before preparing a new frozen plan. Save attempt and envelopes
   before requests; reconnect/restart reuses the same identities. Show paid or
   Emergency InstaSync wording from the Server decision. On any failure keep disk,
   key and authenticated session when valid, explain retry, and resume normal work.
   Recheck no changed/local-only work after all acknowledgements and before clear.
   Never clear after a retired session/account response.
4. **Acceptance:** generated Mongo/HTTP/Drive fixtures at zero and sufficient
   Energy, one and multiple batches, actual reply loss/replay/restart, partial and
   conflict outcomes, concurrent attempts/session/account changes, locked vault,
   disabled sync and offline behavior. Verify no debit/refund/window/ledger mutation
   for emergency work; exact paid costs; session revocation only on successful
   finalization; actual Hive preservation on every unsuccessful path. Run strict
   Flutter/full tests/debug APK CI and exact-main gates before scoped mirroring.

## Explicit unresolved decisions and boundaries

Attempt persistence and active-attempt uniqueness must be transactional; an
inactive contract alone does not provide them. Cleanup/index design is not
activated by this PR. Attempts that exceed the bounded plan must refuse logout
and retain notes; additional explicit sync can reduce the queue. New edits or a
conflict copy outside a frozen plan require a new plan, never silent exclusion.
An already charged unanswered request must be reconciled rather than relabeled
free, and a lost completion response must not destroy the only local copy.
Existing deployment, old-client compatibility and signed-upgrade gates still apply.

**From request, not implemented yet:** end-to-end emergency logout. No public
promise, production deployment, new database/index or device action is authorized
by merely passing this contract's tests.
