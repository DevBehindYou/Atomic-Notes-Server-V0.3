# Inactive recovery gate: acceptance boundary

8 October 2026. Within the owner's approved inactive code/disposable-test scope.

`src/lib/recoveryGate.ts` publishes a persistent gate and expiring per-user lock
in one Mongo transaction. Fenced callback writes conditionally touch the gate
inside their transaction, checking owner/token/epoch and expiry before and after
the callback. A failed callback or lost final fence aborts its writes. Epoch
changes and wipe callbacks share a transaction; stale release cannot clear a
newer lease. The gate survives TTL removal of its lock. Safe-counter exhaustion
refuses further mutation. No production route or index initializer imports it.

The generated-loopback CI fixture uses only the process-owned Mongo client and
database. It tests contention, callback rollback, expiry during a callback,
handoff, stale release, wrong-owner refusal, wipe rollback and epoch fencing,
missing TTL lock, retained epoch and counter-overflow rollback. Its synthetic
clock changes are injected; this is not an OS/device-clock or physical crash test.
The artifact contains only fixed phase/outcome codes; full CI is required before
these Mongo assertions can be claimed as passed.

**Boundary:** every callback write must use the provided session and its intended
owner scope. This helper cannot fence a writer that bypasses it, read a real
Drive generation, persist an intent, commit note versions/results or settle an
operation/refund. Existing production lock/wipe/sync code remains unchanged.
Old-writer exclusion and recovery-aware settlement are still mandatory future
work. Readers, competing devices, true crash/restart, external writes and atomic
pointer/receipt integration remain separate acceptance stages. R11/R16 stay partial.

No production database/index/data, cleanup, signed release, device or deployment
operation occurred. Generated database teardown is owned by the existing fixture
identity guard. This PR depends on the strict storage contract in #42; destination
main ancestry and exact-main CI must be verified before mirroring its files.
