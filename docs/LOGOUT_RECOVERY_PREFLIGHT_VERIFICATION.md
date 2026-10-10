# Inactive, read-only logout recovery preflight

`inspectLogoutRecovery` prepares the evidence boundary for recovering a saved
logout after its original session expires, is revoked or is removed. No route
calls the helper; production behavior is unchanged. No schema/index/retention
policy, new dependency, activation or migration is added.

The preflight requires a different current live session belonging to the same
account, the prior hashed binding and exact bounded manifest. It refuses an
active previous session, foreign/currently revoked identity, any pending user
operation, missing receipts and malformed or mismatched receipts. Missing
receipts are ambiguous, because legacy retention may have removed committed
records; absence is never treated as an unstarted upload.

Only summary metadata is returned: attempt state and each request's settled
charge/refund/success/failure counts. No note text, raw bearer credential, Drive
content or key is returned. The helper runs snapshot reads in a transaction and
does not initialize/grant/debit a wallet, mutate a session, close an attempt,
alter a receipt or contact Drive. Its result is advisory and NEVER authorizes
local erasure or a session handoff. A future recovery commit must recheck auth,
manifest, receipt and pending-work guards under the notes lock and transactional
session fences; the current snapshot can become stale immediately after return.

The disposable fixture asserts complete wallet/ledger/session/attempt/operation/
note snapshots are unchanged on acceptance and refusal. It covers expired and
removed old sessions, settled partial/completed receipts, live/foreign/revoked
auth, missing receipts, changed manifests, pending operations and invalid charges.
Receipts are seeded through actual admission/open/result/settlement helpers; no
Drive write is used. A simulated completed receipt is not proof of a real note
write or a recovery implementation. Fixed-code evidence is published separately.
The generated namespace's session TTL index is removed only inside the fixture
so explicit expiry/removal checks do not depend on the background TTL monitor.
This is not a TTL execution or production index-transition proof.

CI typecheck, unit/integration fixtures and the exact-head sanitized artifact are
required before merge; local dependencies are currently incomplete and no new
local test pass is claimed. Client reauthentication, durable handoff, local
receipt reconciliation, missing/ambiguous-operation recovery, signed/native
acceptance and production activation remain open.
