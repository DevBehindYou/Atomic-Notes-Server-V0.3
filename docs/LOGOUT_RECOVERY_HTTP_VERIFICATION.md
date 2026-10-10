# Dormant read-only logout recovery status

POST `/api/notes/logout-attempt/recovery-status` is enabled only by the existing
logout rollout gate, which remains disabled in production. Authentication runs
before the handler. It accepts `attemptId`, `previousSessionHash` and the exact
bounded `batches` manifest; account identity comes only from the current session.
The #64 preflight still requires a different live session of that same account,
an inactive/removed prior session and complete, consistent settled receipts.

This advisory handler precedes legacy notes write-lock/settlement middleware.
Thus its POST never auto-settles an abandoned write, charges/refunds Energy,
initializes a wallet, revokes a session or closes a logout attempt. Accepted
responses contain only attempt state and request charge/refund/success/failure
counts. Missing/ambiguous records refuse recovery; no note text or raw token is
returned. The snapshot never authorizes clearing notes or adopting an attempt.

A dedicated stream reader caps the raw UTF-8 body at 16 KiB before parsing,
including whitespace. Five 50-row manifests fit within this cap. It does not
trust Content-Length, cancels oversized streams, refuses malformed UTF-8/JSON
and returns fixed JSON errors without the underlying stream/parse exception.
This endpoint bound does not implement the still-open general rate/resource
limiter or establish a limit at Vercel's upstream request-buffering layer.

Seven pure body-reader cases cover maximum manifests, the exact boundary,
oversize cancellation with a false header, malformed JSON/UTF-8, an empty body
and stream-error sanitization. Real loopback HTTP/generated Mongo fixtures
verify disabled/auth/body/ownership gates, unchanged business-data snapshots,
pending-operation refusal without legacy settlement and settled/terminal reads.
Receipts are synthetic admission/result/settlement records; Drive writes remain
zero. No actual cloud-content recovery, reauthentication or handoff is proved.

First head `da838a93ed823c5462463310f39459027c11d397`, run `38028483010`,
failed typecheck and receives no merge acceptance. Source inspection shows this
project uses Node types with ES2022 and no DOM library; the correction explicitly
imports Node's reader/stream types and infers the body type from Request, avoiding
DOM-specific type names. This cause is inferred from source, not a retrieved
compiler log; corrected-head CI must verify it. No raw logs were fetched.

Exact-head CI and all named sanitized artifacts are required before merge;
local caches remain incomplete. No production flag, migration/index, deployment,
signing or device operation is authorized by these tests. #64's no-caller statement
describes its earlier isolated layer; this gated route is its first caller.
