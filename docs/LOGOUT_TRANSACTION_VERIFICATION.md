# Inactive logout transaction helpers

The owner selected one Emergency InstaSync **per logout attempt**. This layer
implements admission, batch accounting and completion; it has no production
HTTP caller and does not yet implement the App logout flow.

`src/lib/logoutAttempt.ts` binds an immutable manifest to a user and hashed
session, using the existing session document to serialize active attempts.
Admission evaluates the current wallet after the existing daily-grant preflight.
A wallet revision serializes the funding decision against concurrent financial
writes. These optional revision fields are metadata; they do not credit Energy.
Attempt admission and its session reservation share one transaction.

Emergency batches record zero charge and zero refund. Paid batches reuse the
existing transactional instant debit and ledger implementation. A batch retry
reuses its recorded operation and never relabels an earlier paid request as free.
Fingerprints, note IDs, envelope size, owner and session must match admission.

Completion checks all declared successful versioned receipts, funding and operation
bindings before atomically closing the attempt and revoking only its session.
A completion replay can read its bound historical receipt without another write.
Future HTTP routing must explicitly support this replay; ordinary requireAuth
would reject a revoked token. A failed or partial receipt does not authorize logout.

The existing legacy push and abandoned-operation settlement paths refuse pending
logout-tagged work with `sync_logout_required`. They cannot safely reconcile the
new attempt protocol. Completed receipt replay retains its existing behavior.

The generated Mongo fixture tests rollback after admission, batch opening and
completion; zero-charge two-batch success; paid debit/replay/refund; failed free
batch; aggregate insufficiency; manifest/session mismatch; legacy HTTP refusal;
and preservation of the second session. It deliberately inserts synthetic results
to test accounting/completion. It does **not** prove Drive/metadata writes or App
orchestration. Its sanitized artifact contains only a fixed phase and outcome.

Remaining: route integration, active-attempt cancellation/replanning, actual
Drive commit/replay and App/Hive logout tests. No cleanup index, real database,
production activation or device action is performed by this change. Older
deployed writers require the existing cutover safeguards before activation.
