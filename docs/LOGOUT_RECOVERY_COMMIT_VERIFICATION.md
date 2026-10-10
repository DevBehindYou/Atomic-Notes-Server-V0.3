# Settled-only logout recovery commit

10 October 2026. Default-off implementation; production activation and client
reconciliation remain separate acceptance work.

## Contract and allowed writes

`POST /api/notes/logout-attempt/recovery-commit` uses the existing authenticated
same-owner session and bounded strict body `{attemptId, previousSessionHash,
batches}`. It acquires the notes operation lock itself before calling
`commitLogoutRecovery`; it precedes legacy abandoned-operation reconciliation.
The existing `ATOMIC_LOGOUT_SYNC_ENABLED` gate remains false by default.

The response uses the same bounded whitelist as recovery receipt inspection:
`{attemptId, state, batches: [{requestId, charged, refunded, results}]}`. Result
fields are only `id`, `ok`, optional `version`, `seq`, `unchanged`, and either
`updated_at` or a bounded error code. Terminal state is `completed` if every
previously settled result succeeded, otherwise `aborted`. An existing terminal
state is preserved. There is no note text, credential, session binding, operation
internals or new request identity in the reply.

The helper shares the inspection predicates inside the same transaction: fresh
distinct live authentication with no active attempt, exact prior owner/hash and
manifest, inactive or removed old session, every batch's matching settled receipt,
and no pending operation for the owner. All outbound fields are validated before
writes. Missing receipts remain ambiguous and are never treated as unsent work.

Only two business records can change: the new session's existing
`logoutAttemptRevision` increments under an exact revision/live/owner/no-active-
attempt predicate; a prepared old attempt compare-updates its state and time.
Revision exhaustion refuses without writes. Transaction rollback reverses both.
Terminal replay increments the current revision again to fence current auth but
returns the same immutable acknowledgement and leaves the terminal time stable.
The HTTP operation lock is acquired/released separately. This path never grants,
debits, refunds, initializes a wallet, changes operations, writes Drive/metadata,
revokes or extends any session, or sets a new session's active attempt.

## Disposable verification

CI adds `tests/logoutRecoveryCommit.fixture.test.ts` alongside all existing
fixtures and uploads only `sanitized-logout-recovery-commit-proof`. Its JSON schema
is `{version:1, scope:"disposable opt-in settled-only logout recovery commit",
phase, outcome}`. Success requires `phase:"complete", outcome:"pass"`.

One guarded generated localhost replica-set database exercises real Hono/auth,
admission, paid/free debit/refund and settlement helpers. Synthetic stored results
are deliberately used; this fixture claims no actual Drive/metadata commit.
Controls cover disabled/auth/body/foreign/manifest refusal, original paid cost and
refund preservation, emergency receipts, removed old session, successful and
failed terminal closures, discarded first reply and parallel HTTP replays,
transaction rollback, revision exhaustion, current auth revocation/owner
replacement/active-attempt races, current revision and old terminal transaction
retries, invalid optional receipts, and live old/missing/pending refusal without
legacy settlement. Wallets, ledger, operations and notes are snapshot-compared;
old/unrelated sessions remain unchanged; fake Drive writes and retained operation
locks remain zero.

No local test pass is claimed: existing npm dependencies are absent and were not
installed. Merge requires exact-head full CI, all existing fixed-schema proofs and
the new proof; mirroring/dependent publication requires exact merged-main CI.

## Boundaries

The current session must be chosen/reauthenticated by the user; no automation
selects a Google account or grants consent. Recovery completion does not authorize
local erasure or logout of the fresh session. The App still needs durable receipt
application, revision/account/vault fences and a new explicit logout for remaining
dirty work. Pending/missing evidence, plans beyond five batches/250 rows, release
rollout/drain and mutable Drive failure recovery remain excluded.

Normal session code creates new IDs and only changes `revoked` toward true; it
does not extend or revive old IDs. Arbitrary resurrection through backup restore
or direct data writes is outside this fixture and must be addressed by deployment
and restore procedures. The old session's read alone is not a write fence against
such unsupported resurrection. No production schema/index/data migration,
deployment, native keystore, device test or signed upgrade is performed here.
