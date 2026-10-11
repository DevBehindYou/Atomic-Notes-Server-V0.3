# Bounded inactive recovery staging

12 October 2026. This changes only the scheduling of the existing inactive
coordinator. Production still uses `src/routes/notes.ts`; no activation,
schema/index, quota, funding, cleanup or refund policy changes.

## Existing architecture and changed behavior

The production route stages independent Drive work with eight workers
(`src/routes/notes.ts:42`, `:398`, `:418`, `:422`). The candidate coordinator
previously staged one intent at a time. It now reuses `mapConcurrent` with the
same limit eight. Each stage owns separate fenced Mongo sessions before and
after its external calls (`src/lib/recoveryIntent.ts:81`, `:96`); no concurrent
operations share a Mongo transaction. The subsequent metadata/sequence/result
commit stays one ordered, coupled transaction. Content discovery and commit
readback remain sequential; this is not blanket request parallelism.

The existing worker utility stops launching further jobs after an observed
failure and waits for every already-started job before returning an error
(`src/lib/concurrency.ts:9-16`). Verified immutable generations may remain after
an interrupted request, but no part of that cohort becomes published metadata.
The saved paid operation remains pending. A fresh lease resumes the persisted
IDs and original classifications without new allocation or another debit.
Unknown errors are not silently converted into terminal failures or refunds.

## Generated acceptance fixture

`tests/recoveryConcurrent.fixture.test.ts` invokes the actual classified caller
with ten public synthetic rows, generated localhost Mongo replica-set databases
and a held fake Drive SDK. It uses explicit promise barriers rather than elapsed
sleep assertions. Eight create calls are parked simultaneously; the ninth/tenth
cannot begin until a worker is released. While parked, the operation is paid and
pending, all ten journals exist, and no note, sequence or result is published.
After release, exactly ten immutable generations commit in original row order.

A second ten-row operation parks eight workers, rejects one create with an opaque
`ECONNRESET` transport failure and
holds the other seven. The coordinator must remain unresolved until those seven
finish. It returns the original failure with no published notes/cursor/results,
no refund, seven verified journals and three prepared journals. This distinguishes
safe durable progress from a partial cloud commit. The fixture then rejects the
obsolete lease, resumes all saved IDs under a fresh lease, verifies one original
charge, twenty final files, ordered sequence results, terminal replay with every
SDK method throwing, and actual HTTP pull/replay using the existing route.

The older two-row wire fixture now expects both already-started stages to drain:
two persisted files, one prepared journal and one verified journal after one
reply loss. Its preservation, fingerprint, stable ID/timestamp, wallet/ledger,
ordered receipt and no-extra-allocation assertions remain. Three total create
attempts include the single exact-ID 409 replay; neither file is overwritten.

## CI evidence and limits

The workflow retains all existing thirty proof uploads and adds only
`sanitized-recovery-concurrent-proof` / `ci-recovery-concurrent-proof.json`:

```json
{"version":1,"scope":"disposable inactive eight-stage drain and saved-generation resume","phase":"complete","outcome":"pass"}
```

Merge requires exact-head typecheck, dependency audit, build, pure tests, real
integration tests, fixture suite and all thirty-one fixed proof schemas. Exact
merged-main CI and a guarded scoped mirror remain additional gates. No local test
pass is claimed; local dependencies are absent and none were installed.

This is scheduling parity and interruption-drain acceptance, not complete
production partial-error parity. Successful-subset commits, deletion-dependent
capacity orchestration, invalid-grant classification, later supersession, SDK
retry/backoff and legacy repair were outside this scheduling slice. The later
retry slice reuses the existing SDK retry policy; this drain probe uses a
non-retryable transport error so its scheduling assertions retain that boundary.
Production
activation, real Drive/Atlas/OAuth, native two-device and signed-upgrade testing
remain separate. R11/R16 stay partial.
