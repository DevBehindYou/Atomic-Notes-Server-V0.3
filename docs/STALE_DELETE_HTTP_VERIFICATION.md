# Stale delete/edit conflict HTTP proof

This test-only extension uses the existing guarded loopback fixture: actual
Bearer-session middleware, notes routes, MongoDB replica-set transactions and
wallet/ledger decisions, with synthetic credentials and simulated Drive. It
creates its own database and closes only that owned namespace.

`tests/clientFixture.conflicts.test.ts` captures versions from actual receipts.
A later accepted edit makes an earlier delete stale. The stale delete must return
`note_conflict` without a Drive write or live-count change; the charged/refunded
receipt and actual wallet/ledger must agree. Replaying the exact operation from
another synthetic session of the same owner must make no additional change.

An acknowledged delete then creates a newer tombstone. An edit based on the
previous live version must fail without resurrecting it; replay is again inert.
Matching-version deletion and an explicit restore based on the current tombstone
are positive controls. Pull responses verify the accepted edit and tombstone.

Local type checking and all 55 existing pure tests pass. Actual Mongo/HTTP
execution requires the existing disposable CI job through `test:client-fixture`.
No local database, production credentials, deployment, schema, dependency,
lockfile, production route or Drive adapter was changed.

This proves Server conflict refusal only. The App's conflict-copy handling of
offline delete/edit remains a separate client-to-Server scenario; this is not
two-phone, Google Drive, tombstone-expiry, native or signed-upgrade acceptance.
R25 remains partial. Exact-head CI and destination-main CI are required.
