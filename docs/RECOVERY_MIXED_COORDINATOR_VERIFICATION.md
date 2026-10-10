# Mixed coordinator preservation

10 October 2026. Generated localhost regression composition, inactive candidate
only. Production source, schemas, policy, gates and deployment are unchanged.

## Why this case is separate

The fifty-row kernel fixture mixes new/existing plaintext, todo and opaque
encrypted-format rows, but all rows remain live
(`tests/recoveryBatch.fixture.test.ts:77`, `:103`, `:111`, `:151`). The delete/restore
kernel fixture tests plaintext and encrypted-format content with a shared deleted
flag per operation (`tests/recoveryDelete.fixture.test.ts:70`, `:74`, `:117`,
`:133`). Existing coordinator coverage uses fresh plaintext notes
(`tests/recoveryResume.fixture.test.ts:70`, `:76`); Server #68 adds one existing
plaintext edit. Those controls do not prove a heterogeneous mutation through the
coordinator's adoption/staging/commit/settlement composition.

## Executable composition and invariants

`tests/recoveryMixedCoordinator.fixture.test.ts` seeds two actual candidate notes:
one plaintext and one encrypted-format note containing a public opaque payload.
One paid operation then orders three mutations: new todo, existing opaque payload
edit, existing plaintext tombstone carrying an offline body edit. No recovery key
or note text enters Mongo intent records. Deletion is metadata; no file is trashed
or overwritten.

The coordinator durably stages three distinct new generation IDs. A validator
guarded to the generated database refuses the final existing plaintext update.
The caught real `MongoBulkWriteError` must carry code 121, failed index two, one
insert and one modified update before the failure. These were transactional
progress, not committed success. The subsequent snapshot must show both old
notes/pointers/hashes, sequence counter and original paid pending operation
unchanged, new todo absent and no deletion or partial success receipt. Wallet and
ledger remain at the admitted cost. Verified intents retain their IDs and null
committed fields. Actual HTTP pull must retain the old body/payload/flags/versions
and cursor; both old files remain intact.

A fresh lease rejects the stale coordinator. Restarting the coordinator with no
client content adopts the stored verified rows and retries the same fault without
another create or debit. Removing only the fixture validator permits one ordered
atomic commit: sequences three/four/five, versions three/three/two, one todo, one
encrypted-format live note and one content-bearing tombstone. It records exactly
three successes under the original request, charged ten Energy and refunded zero.
HTTP pull preserves exact opaque payload, checklist and deletion content. Both
old generations and all three new generations remain available.

Terminal coordinator and actual HTTP push replay must return the same receipt,
without another financial/journal/metadata/file change. Two whole operations
(seed and mixed mutation) consume twenty Energy, leaving eighty from the fixture's
hundred; exactly five creates and five files exist. Gate/adoption revisions may
change independently and are distinguished from published note/receipt state.

## Exact CI proof

The existing workflow runs the fixture and uploads only the new named artifact
`sanitized-recovery-mixed-coordinator-proof`, containing
`ci-recovery-mixed-coordinator-proof.json`. Success has the exact schema
`{version:1, scope:"disposable inactive mixed create encrypted edit and tombstone coordinator",
phase:"complete", outcome:"pass"}`. It exports no payloads, tokens, identities or
raw assertions. All previous 26 fixed-schema proofs remain required.

Merge requires exact-head full CI and all 27 selected proofs; mirroring and
dependent publication require exact merged-main CI. No local test pass is claimed:
dependencies are absent, and no installation or local database is performed.

## Boundaries

The payload is an opaque schema-valid public string, not native AES/vault/keystore
verification. Fresh-lease invocation occurs in one test process, not an OS kill or
host restart. Existing killed-worker tests retain their separate fresh-note scope.
Actual Hono pull/replay and Mongo transactions are used with fake Drive; no real
Google/OAuth/Atlas, two physical devices or signed upgrade is exercised.

Production routes still use the current writer. This fixture does not integrate
or activate the candidate writer, repair old damaged/missing files, define cleanup
or retention, alter quota/economy, prove arbitrary external Drive atomicity, or
close R11/R16. Old-writer exclusion, authenticated native acceptance and reviewed
rollout/restore remain separate gates. This is the final mixed-variant proof in
the present focused composition group, not justification for unlimited variants.
