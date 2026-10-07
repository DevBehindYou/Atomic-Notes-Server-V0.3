# Inactive debit and initial-intent admission: verification boundary

8 October 2026. Approved inactive code/generated-database scope only.

The existing paid debit/ledger/operation body and standard-window check are
extracted unchanged for caller-owned transactions. The inactive intent preparation
body can now use that same session. Production openSync keeps its existing daily
grant, abandoned settlement, empty batch and transaction behavior; no production
route imports recoveryAdmission.ts.

The candidate validates one 1–50 live-row manifest against the parsed envelope,
base versions, flags, hashes, owner, request fingerprint, lease and wipe epoch.
It publishes debit, ledger, pending operation, recovery marker and all initial
intents in one fenced transaction. Known pending replay must keep the same
manifest/IDs and makes no second debit. Completed replay precedes wallet grants
and cooldown checks. Other pending operations require reconciliation: the kernel
never runs the legacy unconditional abandoned-settlement path.

Generated acceptance requires a real Mongo validator failure on the second
intent and a post-write barrier; both must roll back debit/ledger/operation and
all intents. Retry/pending replay, envelope/ID mismatch, unrelated pending refusal,
terminal replay, hourly 429, insufficient energy, standard five/instant ten and
real HTTP failed-receipt replay are checked. Explicit synthetic wallet setup is
used for cooldown/insufficient-energy controls. No Drive write occurs in admission.
CI must execute these assertions before claiming a pass; the artifact uses only
fixed phase/outcome codes. Local strict typecheck and all 85 pure tests pass; generated Mongo acceptance
is pending CI.

Boundary: independent wallet initialization and daily grants remain preflight
transactions, intentionally outside paid-intent atomicity. Due-grant/init failure
and interleaving need compound acceptance. The caller must still perform normal
route auth/quota/Drive checks. Delete rows are rejected by this live-row kernel;
empty receive-only requests keep the existing production path. Partial-commit
lease adoption/reconciliation, orchestration, delete/restore/wipe, process-crash,
real Drive, native/two-device and signed-upgrade acceptance remain incomplete.
No production activation, index/data migration, cleanup, legacy repair, price or
privacy-promise change. R11/R16 remain partial.
