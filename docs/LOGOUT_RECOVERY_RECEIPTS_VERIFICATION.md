# Read-only delivery of retained logout acknowledgements

10 October 2026. Dormant `POST /api/notes/logout-attempt/recovery-receipts`,
behind the unchanged default-off `ATOMIC_LOGOUT_SYNC_ENABLED` gate. No schema,
index, migration, activation or deployment is included.

The handler authenticates the current same-owner session and runs before legacy
write-lock/reconciliation middleware. Both inspection endpoints share the same
read-only snapshot guards: a distinct live current session with no active attempt,
matching prior attempt/hash/manifest, inactive or removed old session, no pending
operation for the owner, every exact settled operation, valid row identities,
outcomes, versions/timestamps and historical costs/refunds. Missing operations
remain ambiguous; this endpoint never settles, recharges or writes them.

The existing status response stays summaries-only. The separate receipt response
contains attempt ID, retained state, ordered batch request IDs, original charge
and refund, and whitelisted per-note `id/ok/version/updated_at` or `id/ok/error`,
preserving optional version/sequence/unchanged metadata from the original result.
Failure errors must be bounded fixed-code strings; timestamps are bounded and
already date-validated. The serialized response is capped at 128 KiB. No note
text, ciphertext, Drive IDs, fingerprints, user/session identifiers, raw tokens
or internal operation fields are returned. Query metadata remains capped at
16 KiB before decoding, independently of Content-Length.

Receipt delivery is not a handoff commit or erasure authority. Another worker
can change state after the read snapshot. A future recovery mutation must repeat
all checks under the notes lock and transactional session/attempt fences; the
client must independently match frozen rows and durably reconcile them while
preserving later edits/conflict copies. This PR does none of those mutations.

The added disposable HTTP test uses a real paid admission/push/completion through
the actual routes and fake Drive, then compares delivered and replayed receipts
to the original push result. Full wallet/ledger/session/attempt/operation/note
snapshots remain unchanged across reads/refusals; exactly one earlier Drive
write is present. Disabled/unauthenticated/oversized/invalid/foreign/mismatched,
pending, missing and non-code error cases are refused without reconciliation.
No real Google, native keystore, consent, physical device or production database
is tested. The synthetic malformed operation setup affects only its generated
localhost namespace. Cleanup remains owned by the existing fixture.

The fixed-schema artifact is `sanitized-logout-recovery-receipts-proof` and
exports fixed phase/outcome codes only. CI typecheck, audit, build/compiled ESM,
pure/integration/disposable tests and every retained proof must pass at the exact
PR head before merging; exact merged-main CI is required before mirroring.
No current local Server test pass is claimed because dependencies are absent;
no install or dependency refresh is performed.
