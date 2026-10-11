# Inactive generation SDK retry parity

12 October 2026. The production retry policy already exists at
`src/lib/googleDrive.ts:124-161`; production note operations use it at
`src/routes/notes.ts:52-56`. This slice reuses that exact helper only for SDK
operations in the inactive generation adapter. No production activation,
policy, journal/schema/index, cleanup or economy changes.

## Preserved policy and boundaries

The existing policy retries HTTP 429, HTTP 5xx and HTTP 403 with rate-limit
reasons. Four total attempts use delays of 500/1000/2000 ms plus less than 500 ms
of jitter. Bad requests, authentication, missing files, permission failures,
409 conflicts and opaque transport failures retain their existing behavior.
No network-error expansion or new attempt count was added.

`driveGeneration.ts` wraps ID allocation, create and the two individual metadata/
media read calls. Each create callback constructs a fresh `Readable` from the
same serialized validated content with the same durably retained file ID and
parent. Retrying a consumed stream cannot upload an empty body. A retryable lost
reply may encounter 409; only exact identity/parent/content readback accepts that
existing file. Validation and integrity comparisons happen outside retry
callbacks. A successful but wrong SDK response is never retried as a transient
failure. The old unknown-create `ECONNRESET` case remains a caller-driven saved-ID
recovery, consistent with the unchanged policy.

Sleep-only injection on inactive helper signatures supports deterministic unit
tests; it cannot select a different retry policy, attempt count or base delay.
The coordinator and generated acceptance fixture use the default policy and
actual delays. No entire stage, Mongo transaction, admission, commit or settlement
is wrapped in an SDK retry. Existing stage-before/stage-after and commit fences
remain authoritative; the eight-worker scheduler remains bounded and drains
started work. Shared metadata transactions stay ordered and sequential.

A lease can change while an external SDK call or backoff is in progress. The old
worker may leave an immutable uncommitted generation, as the approved stage
contract already allows; it cannot verify that generation or publish metadata
under its obsolete lease. This slice adds no per-attempt lease cancellation and
does not claim that old workers leave no files. Generation cleanup remains a
separate boundary.

## Executable acceptance

Six pure controls exercise ID allocation retry and malformed-ID refusal, fresh
streams after consumed-body failure, retryable lost reply with one file plus 409
readback, independent metadata/media retries, the exact four-attempt/backoff
ceiling, non-retryable/auth/permission/opaque errors and integrity refusal without
additional calls. The existing retry helper tests remain unchanged.

The new generated localhost Mongo/fake Drive coordinator fixture uses real default
retry delays. It proves eventual allocation/create/read success, one generation
per note, one debit per operation, ordered results and the unchanged retained
body/pointer. Four exhausted 503 attempts leave the operation paid and pending
with its journal and no notes/cursor/results changed. A successful new invocation
reuses that saved ID without allocation or another debit. Invalid-grant failure
makes one SDK call and also stays pending. A lease handoff inside a retryable
create failure permits an immutable orphan but the obsolete coordinator cannot
verify or commit it. Fresh-lease recovery accepts the same staged identity,
without another debit or duplicate file. Terminal replay avoids all SDK methods;
actual HTTP pull/replay returns the four committed public synthetic bodies.

The older eight-worker drain probe now uses `ECONNRESET`, which the existing policy
does not retry. Its ceiling, wait-for-in-flight, pending receipt and saved-ID
assertions remain. Exhausted retryable failure is independently covered by the
new four-attempt fixture; the earlier #73 503 scheduling proof stays historical.

## CI and remaining work

All thirty-one existing proof uploads remain. The new named artifact is
`sanitized-recovery-drive-retry-proof`, containing only
`ci-recovery-drive-retry-proof.json`:

```json
{"version":1,"scope":"disposable inactive SDK retry retained generation and lease commit fence","phase":"complete","outcome":"pass"}
```

Acceptance requires exact-head typecheck, audit, build, unit/integration/fixture
checks and all thirty-two fixed proof schemas, followed by exact merged-main CI
and a guarded scoped mirror. Local dependencies were not installed and no local
test pass is claimed.

Full production partial-error/refund parity remains unresolved: production can
commit a successful subset and settle failures, while the inactive coordinator
keeps unknown failures pending and commits a coupled cohort. Dependency-aware
capacity, automatic terminal failure classification, later supersession, legacy
repair and invalid-grant HTTP response translation are outside this SDK slice.
R11/R16 remain partial. Real Google Drive/Atlas/OAuth, physical two-device,
signed-upgrade and production activation/cleanup remain separate gates.
