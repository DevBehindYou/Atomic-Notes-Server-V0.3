# Inactive atomic metadata/result/journal commit: verification boundary

8 October 2026. Within the approved inactive code/disposable-test scope.

`saveNoteMetadataBatchInSession` extracts the existing batch mutation into a
caller-owned session; the production wrapper retains its existing transaction
and empty-batch behavior. The optional metadata `generationFormat: 1` marker is
written only by the inactive candidate. Existing production routes keep their
current writer; full regression CI is mandatory for the shared extraction.

`recoveryCommit.ts` reads persisted verified manifests under a fence, performs
read-only staged identity/content/flags/hash validation, then revalidates the
manifest, operation and note preimages inside a second fenced transaction.
The shared batch engine commits pointer, authoritative version/sequence and row
success results; matching journal rows become committed in that same session.
Final fence/expiry refusal or the injected test-only barrier aborts all changes.
No production route imports the candidate. No note text/payload enters Mongo.

The generated database fixture injects one SDK file map into the real notes
route's test assembly. It seeds old metadata/content explicitly. The current
mutable writer suffers a selected real Mongo validation failure after overwrite,
leaving its account's pull mismatched. A separate account stages immutable
generations: the same selected metadata rejection leaves its old pointer/body
readable. A later barrier after metadata/result/journal writes also rolls all four
back. Retry must commit an existing note plus a fresh note with sequences 2/3,
matching journal versions/results, real HTTP pull and cached replay without an
extra debit/ledger/generation. CI must execute these assertions before claiming
them passed. The artifact contains fixed phase/outcome codes only.

Local strict type checking and all 85 pure tests pass. Generated Mongo fixture
acceptance remains pending CI; no local database or real Drive was accessed.

**Boundary:** this is a commit kernel, not an activated sync orchestration path.
Debit/intents remain separately prepared in this fixture; recovery-aware terminal
settlement, row failures, large/mixed batches, true crash/restart, competing
readers/leases, delete/restore/wipe integration and old-client compatibility still
require acceptance. Final operation settlement is separate from the atomic row
success transaction and must use its authoritative results. External edits to
Drive after readback cannot be made atomic with Mongo; pull containment remains
necessary. Real Drive, native/two-device and signed upgrade remain separate.

No production migration/index/data, cleanup, release, device, deployment or notice
operation. R11/R16 remain partial; a passing kernel alone earns no closure credit.
