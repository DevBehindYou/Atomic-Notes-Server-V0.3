# Opt-in logout HTTP integration

The owner selected Emergency InstaSync once per logout attempt. The Server now
has the route integration behind `ATOMIC_LOGOUT_SYNC_ENABLED`; an absent or
non-true value keeps it disabled. No deployment setting is changed by this PR.

All requests use the existing opaque session token. Admission accepts
`{attemptId, batches:[{requestId,fingerprint,rowIds,wireBytes}]}` at
`POST /api/notes/logout-attempt`. Its response states paid/emergency funding and
the cost per batch. `POST /api/notes/push` adds optional `logoutAttemptId` and
requires instant mode for that path. Existing size, owner, quota, conflict,
Drive, metadata-commit and receipt behavior remains shared with normal push.
Read-only replay authorization precedes quota/Google-token checks; debit occurs
only after those checks. Emergency pushes record zero charge/refund.

`POST /api/notes/logout-attempt/complete` accepts `{attemptId}`. It derives the
owner from the hash of the supplied token. A prepared attempt requires a live
session and all matching successful receipts; completion atomically closes the
attempt and revokes that session. Its already-completed receipt is replayable
with that same historical token even after revocation, until the normal session
record expires. No token, fingerprint or note content is returned in that receipt.

`POST /api/notes/logout-attempt/abort` accepts `{attemptId}` through normal auth.
It refuses unresolved operations, retains all financial receipts and clears the
session's active-attempt marker only after a frozen plan is safely abandoned.
A later explicit logout can declare a new plan, including conflict copies or
failed rows. It does not erase or refund already accepted work.

The generated HTTP fixture tests disabled gating, two real free note writes and
their replay/pull, session isolation, completion replay after revocation, paid
conflict/refund/abort/replan, and partial free failure followed by retry of only
the failed row. It uses actual Mongo transactions and routes with simulated Drive.
The output artifact contains only a fixed phase/outcome. This is not OAuth,
physical-device, production Drive or App/Hive logout proof.

The App still needs frozen-plan persistence, vault/dirty/cache checks, user
messages and successful-sync-before-clear orchestration. Production activation,
attempt retention and signed-upgrade acceptance remain release gates. Existing
mutable Drive write failure boundaries are not fixed by this logout feature.
