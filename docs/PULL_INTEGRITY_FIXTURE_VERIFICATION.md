# Bounded pull-integrity HTTP fixture

This adds test-only controls to the existing guarded loopback fixture, not to
production src/api. One note UUID and one enumerated mode are accepted at a time:
none, missing, corrupt or mismatch. Only the existing synthetic controller token
may configure it. Strict validation rejects invalid IDs/modes/extra fields.

The fake Drive reader simulates 404, invalid parsed file shape or inconsistent
body content. It never deletes or overwrites the stored fake file. Disabling the
fault only restores normal fixture reads; this is not production file repair.

The actual HTTP/Mongo test uploads two notes in one request and requires each
fault to return HTTP 409 with neither rows nor a next cursor on repeated pulls.
It checks the actual note metadata, sequence counter, wallet/ledger and Drive
write count remain unchanged. Restoring reads returns both notes at the same
cursor/sequence without a new upload. Existing warning logs may still be written.

Local type checking and **59 pure tests** pass. Actual database/HTTP execution
belongs to the existing disposable CI job. No local or production database access,
new dependency, lockfile, collection/index/schema, route, Drive adapter or policy
change is included. App handling requires its own subsequent wire case.

R11/R16 containment is strengthened; durable Drive/Mongo failure recovery, real
Drive restoration, historical anomalies, native/two-device and signed-upgrade
acceptance remain open. Exact-head and destination-main CI are required.
