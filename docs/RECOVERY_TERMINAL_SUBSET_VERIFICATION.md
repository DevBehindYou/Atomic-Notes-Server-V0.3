# Inactive trusted terminal partition

12 October 2026. This helper is an inactive trusted-caller composition, not an
SDK error classifier or an activated HTTP route. The caller supplies an explicit
complete partition of journal intent IDs into successes and terminal failures.
Unknown transport/auth/local failures must not be assigned terminal status by
this helper. Candidate generations may remain uncommitted; cleanup is separate.

## Atomicity and preserved policy

`recoveryTerminalSubset.ts` requires exact journal coverage, disjoint unique IDs,
matching owner/fingerprint/wipe epoch, frozen admission classifications and a
current lease. Successes require verified or previously committed intents;
failures require pending prepared/verified intents. The same fenced MongoDB
transaction commits new success metadata, sequence numbers and success receipts,
then terminalizes failed journal rows with their receipts, then invokes the
existing `finishSyncInSession`. Classified conflict and unchanged results remain
frozen. Terminal results return in original request order. A terminal replay
requires the same partition and uses no Drive calls, allocation or debit.

`commitRecoveryIntents` gains an optional pre-write composition barrier. It runs
inside the existing commit fence after immutable-generation readback and before
metadata writes. Other inactive callers retain their current behavior. No route,
SDK classification, journal field, index, capacity policy or economy rule changes.

The existing economy remains authoritative: any stored success, including an
unchanged classification or a previously committed journal row, prevents a
refund. All-failed outcomes refund once, capped by current wallet headroom. A
failed standard operation restores its previous hourly window only if that
operation still owns the recorded window. Admission reservations are not
rechecked against today's note tier during terminal settlement.

Successful additions/restores combined with a failed deletion of an active note
are refused before publication. Their capacity dependency needs a separate
coordinator design. A previously committed live row is conservatively treated
as a possible restore because its old deleted flag is not journaled. This helper
does not claim full production per-row partial-success parity, crash scheduling,
unknown-error classification, durable compensation, logout funding integration
or production activation.

## Generated acceptance

The new fixture owns a generated localhost MongoDB replica-set database and
synthetic fake Drive. Existing atomic admission and immutable stage/commit
helpers are exercised. Public synthetic classifications are revalidated by
admission. An out-of-protocol tombstone injection probes dependency containment
only; it is not evidence for production repair or a capacity-admission policy.

The fixture proves:

- A genuine MongoDB validation error 121 on failed journal terminalization
  rolls back preceding success metadata/sequence/receipt writes, journal and
  settlement. A post-settlement callback failure independently proves rollback
  after all successful transaction writes were observable inside the session.
- Corrected retry publishes ordered partial results, preserves classified
  receipts and the failed note's old pointer, and makes no refund or second debit.
- Already committed success is preserved without external readback; a result-only
  unchanged success also suppresses refunds when every journal write fails.
- Missing/overlapping/duplicate/foreign partition IDs, insufficient journal
  coverage, unverified success, wrong owner, stale token and stale wipe epoch
  fail closed without publishing metadata or calling Drive.
- A changed wallet tier does not reprice an existing admission. Deletion-funded
  additions and restores are refused together; explicit all-failure settlement
  then retains their old pointers and uses the existing refund rule.
- All-failed standard settlement caps a five-unit refund to two units of headroom,
  restores the prior hourly window, and returns identical terminal replay without
  another ledger entry. Real localhost admin adjustment creates that headroom.
- Actual localhost HTTP push replay returns saved partial/all-failed receipts;
  HTTP pull returns the successful new body and the failed note's old body.

CI retains all 32 previous sanitized proof artifacts and adds
`sanitized-recovery-terminal-subset-proof/ci-recovery-terminal-subset-proof.json`:

```json
{"version":1,"scope":"disposable inactive trusted terminal partition and atomic partial settlement","phase":"complete","outcome":"pass"}
```

Exact candidate-head typecheck, audit, build, unit, integration and client fixture
checks plus all 33 named proof schemas are acceptance requirements. No local
build, dependency install, production database or real Google Drive pass is
claimed. Root coordination owns merge, exact-main revalidation and scoped mirror.
