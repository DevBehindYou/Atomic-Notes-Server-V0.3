# Inactive recovery coordinator

`src/lib/recoveryResume.ts` composes the previously verified lease, adoption,
immutable staging, commit and settlement helpers. Production routes do not
import it. The caller must authenticate ownership and the original request
fingerprint, enforce quotas/byte limits, supply the correct Drive parent and
hold the current lease. No new endpoint or production index initializer exists.

The coordinator accepts one existing recovery operation and at most 50 optional
AtomicFile contents. It never debits, generates another file ID, deletes files,
or automatically refunds an ambiguous error. Prepared work uses supplied
original content or reads its persisted generation ID. A 404 without supplied
content returns `needs_client_content` while retaining the paid pending
operation. Unknown errors propagate with the receipt pending. Verified work
requires fresh generation readback before metadata commit; committed successes
are preserved during partial recovery. A completed replay returns the stored
receipt without Drive calls or another debit.

This is an inactive implementation extension, not a causal fix to the current
production route. `tests/recoveryResume.fixture.test.ts` uses generated disposable
MongoDB and fake Drive. It checks duplicate/51-row/foreign-owner refusal,
prepared persisted-file recovery, missing client content, prepared/verified 503
containment, partial commit after lease handoff, stale-worker refusal, terminal
replay and actual HTTP pull/receipt replay of four preserved bodies. Two
operations must consume exactly twenty energy and four immutable generations.
Only a fixed phase/outcome artifact is exported.

The composition is intentionally sequential. It does not measure eight-call
concurrency, global HTTP middleware, real Drive/OAuth/quota behavior, actual
phone or signed upgrade, scheduler liveness, production-writer exclusion,
cleanup or legacy repair. The process-restart fixture separately proves helper
checkpoints; it does not yet invoke this coordinator in killed workers. An
external failure leaves pending work for retry or explicit reviewed abandonment;
no new automatic error-to-refund policy is claimed.
