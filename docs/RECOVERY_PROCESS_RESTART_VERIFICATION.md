# Inactive process restart checkpoints

**Executable acceptance, pending exact-head CI:**
`tests/recoveryRestart.fixture.test.ts` runs the inactive recovery helpers in
separate Node processes. A parent owns a generated disposable Mongo database
and a loopback fake Drive HTTP service; each worker owns a new Mongo client and
has an allowlisted environment with the canonical local URI and generated DB
name. No dotenv or raw diagnostics are read or emitted. Worker stdout/stderr
are ignored; IPC exposes only fixed checkpoint/failure names.

The parent receives completion of prepare, generation verification, metadata
commit and terminal settlement, then sends SIGKILL and observes that process's
exit. A new process recovers the same operation at each checkpoint. The tests
must observe one ten-energy debit, two saved file IDs, two actual generation
creates, two success results and monotonic versions/sequences despite four
terminated workers. Initial unuploaded preparation resumes from a fixed public
client-request fixture; verified generation recovery uses the journal/file
readback rather than requesting user content from Mongo. Final complete replay
returns the stored receipt and releases its lease without another debit or file.

Actual HTTP pull and push receipt replay use the same retained fake files and
real notes route. They must return both bodies with versions one/two, preserve
wallet/ledger/metadata and keep the two generation files. Only the allowlisted
phase/outcome artifact `ci-recovery-restart-proof.json` is uploaded.

**Verified in code:** `tests/recoveryRestart.worker.ts` directly calls inactive
admission, adoption, staging, commit and settlement helpers. No production route
imports or exposes this worker. Generated DB/loopback safety checks run before
the child connects, and its Mongo client is closed for ordinary completion.

**Boundaries:** SIGKILL happens after a completed checkpoint, not in the middle
of a Mongo transaction or an uncertain Drive response. Mongo and fake Drive
stay alive; this does not prove simultaneous service failure, OS power loss,
real Drive durability, native key storage, two phones or a signed upgrade.
Lease takeover uses an injected future clock, avoiding ten-minute test sleeps;
real lease expiry timing is not measured. Public small plaintext fixtures cover
process-state loss; encrypted, deletion and large-batch cases have separate
disposable proofs, not their Cartesian product with this process test. Automatic
reconciliation/classification, old-writer exclusion, production activation,
legacy repair and cleanup remain separate gates.
