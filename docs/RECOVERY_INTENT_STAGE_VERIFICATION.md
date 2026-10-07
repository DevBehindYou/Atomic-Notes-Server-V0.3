# Inactive intent persistence and external staging: acceptance boundary

8 October 2026. Within the owner's approved inactive implementation/test scope.

`src/lib/recoveryIntent.ts` persists a strict generation manifest under a fenced
pending recovery-format operation, checks its row order/fingerprint and note
preimage, and refuses identity changes on registration replay. A compatible new
lease can adopt the identical persisted manifest. Staging requires that record
before external create, validates note ID/content/hash/flags, uses the create-only
adapter and then marks verification in a fenced transaction. Terminal operations
or settled row receipts are refused. No production route imports this module.

The generated-Mongo/fake-SDK fixture explicitly seeds old metadata/content. It
uses the real debit/refund helpers but injects a recovery-format marker only into
its generated operation. It tests persistence before create, duplicate
registration, replacement-ID/content refusal, actual Mongo validator rejection
after an immutable upload, retained-ID 409 retry, unchanged old pointer/content,
no version/sequence commit fields, no note body in the intent, closed-operation
refusal and actual HTTP replay without another wallet/ledger change.

**Boundary:** this is preparation/staging, not metadata pointer commit or recovery
settlement. Debit and registration are still separate in this fixture; their
future atomic coupling is unimplemented. The existing finish helper can close a
failed operation while its verified, uncommitted intent remains. This stage
refuses further staging against that closed receipt; it does not yet atomically
abandon/clean the orphan. No physical crash/restart, real Drive/OAuth, actual App,
native storage, production migration or cleanup is exercised. The fixture's SDK
file map is separate from the existing route's fake Drive; replay executes only
the stored-receipt path, not a cross-adapter pull/repair claim.

Typecheck and exact full CI plus selected fixed-code proof remain required.
R11/R16 stay partial. No production database/index/data, signing, device,
deployment or public-notice action. Real legacy index/catalog state remains
unverified; no retention or historical recovery promise is changed.
