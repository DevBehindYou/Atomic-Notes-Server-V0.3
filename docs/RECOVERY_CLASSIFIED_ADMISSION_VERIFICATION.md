# Inactive classified admission and coupled recovery

`runClassifiedRecoveryPush` is an inactive trusted-caller helper, used only in a generated fixture. It expands initial admission to exact-base edits, metadata tombstones/restores, fresh live rows, stale-base conflicts and unchanged results. `runFreshRecoveryPush` keeps its existing API and fresh-only behavior. No production route, activation flag, persistent field/index/schema, logout funding or economy policy changes.

The caller must authenticate the owner and supply its held lease and owner-scoped SDK/folder; raw HTTP body enforcement remains a caller prerequisite. The helper retains the approved inactive 50-row limit (production push is still 100), shared content bounds and serialized-object 4 MiB limit. Missing metadata with a nonzero base or a delete target is explicitly unsupported; production's missing-note behavior is not claimed. Foreign IDs refuse the whole request before debit. No rebasing of stale bases.

## Admission representation

| Original row | Immutable initial result | Recovery intent |
|---|---|---|
| Existing stale base (checked before hash) | `note_conflict`, current version | None |
| Exact base, same content hash and deletion flag | Successful `unchanged`, current version/update time | None |
| Exact-base changed edit/delete/restore | None initially | Exact-preimage prepared generation |
| Globally absent fresh live base zero | None initially | Prepared fresh generation |

The full original schema-normalized envelope fingerprint and ordered row IDs are retained. Classified results, debit and all write manifests publish in the SAME fenced admission transaction. Version/hash/deleted/update-time decisions are revalidated after external ID allocation; valid write preimages and optimistic quota are also rechecked. Classification drift aborts admission; allocated unused IDs are harmless. Original timestamps bind the fingerprint, while immutable file projection reuses original UTC creation time and persisted intent creation time on retries. Note text/payload and original envelope are not added to Mongo's journal.

`assertRecoveryCoverage` requires every requested ID to have a strict result-only admission classification or a valid intent. Duplicate, extra, overlapping unresolved or missing rows refuse. Only committed intents can overlap matching non-unchanged success versions/sequences during pending recovery. Existing completed abandoned/superseded intent plus failed result pairs remain valid terminal replay. Settlement now rejects unexplained missing unresolved journals before closing/refunding. Explicit abandonment retains its separate existing policy.

Zero-write all-conflict and all-unchanged requests still pay the normal push cost. They settle atomically through the existing helper: all conflicts refund within available cap headroom and conditionally restore the standard window; any successful result, including unchanged, prevents refund. They allocate no IDs/Drive calls and use no dummy intents. A new request still requires Energy. Terminal replay precedes current wallet/capacity/Drive checks; pending adoption uses frozen classifications and saved IDs/dates, not a new price or classification.

## Replacement capacity boundary

Optimistic preflight retains production ordering over ALL original rows: live fresh/restores count as additions even if a stale restore later conflicts; only exact-base active deletes credit room. The classified write cohort then stages and commits together. A stale or unverified deletion cannot fund a committed addition. An unknown external create/read/stage error leaves the admitted operation pending, with old metadata/pointers/cursor intact and no automatic refund/abandonment. A fresh lease resumes the same manifests.

This is **not production partial-failure parity**. Production stages eligible deletions first, credits successful ones, and can commit a successful subset while rejecting dependent additions. The inactive coordinator may stage an addition before its deletion but cannot publish that addition until the deletion is verified and included in the same commit. Dependency-aware partial-error orchestration is deferred. Later write-preimage drift stays refused/pending; no automatic supersession/conflict outcome is added. Already admitted conflict/unchanged results remain frozen even if their note's metadata changes later.

## Verification

`tests/recoveryClassified.fixture.test.ts` exercises actual wire callers with generated localhost Mongo and fake Drive, not handcrafted admission manifests. It seeds through the unchanged fresh helper, proves foreign/missing/logout refusal, unchanged classification drift during allocation rollback, real Mongo validation failure when classified results are saved rolling back debit/operation/manifests, mixed opaque edit/stale-identical conflict/unchanged admission and interrupted create, strict sparse coverage under missing/overlapping journal corruption, fresh lease refusal of later valid-write drift, immutable result replay, stale delete/restore quota ordering, uncertain deletion blocking a staged replacement's metadata, eventual coupled commit, zero-intent conflict charge/refund/standard restoration, paid unchanged success, insufficient Energy and terminal replay without SDK use. Generated out-of-protocol metadata injection is identified as a guard probe, not evidence of a concurrent HTTP writer bypassing the held lease.

Full CI and the previous 28 fixed proofs remain required. The new `sanitized-recovery-classified-proof` must equal:

```json
{"version":1,"scope":"disposable inactive classified admission sparse recovery and coupled replacement","phase":"complete","outcome":"pass"}
```

Fake Drive, opaque encrypted payload and same-process lease restart do not prove real Drive/native encryption/process kill, authenticated production routing, historical repair, production quota/error parity, deployment or full R11/R16 closure. Production writers remain unchanged and recovery is inactive.
