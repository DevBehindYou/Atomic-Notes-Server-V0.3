# Existing-note recovery coordinator preservation

10 October 2026. Regression composition in a generated localhost fixture only.
No production source, schema, policy, deployment or activation change.

## Gap and executable path

The coordinator composes adoption, immutable staging, readback, fenced metadata
commit and settlement (`src/lib/recoveryResume.ts:44`, `:61`, `:64`, `:65`).
The existing coordinator fixture uses fresh-note preimages
(`tests/recoveryResume.fixture.test.ts:76`), as does the process restart worker
(`tests/recoveryRestart.worker.ts:42`, `:45`). Existing-note readback preservation
and real Mongo metadata validation failures are proven in separate direct-kernel
fixtures (`tests/recoveryReadback.fixture.test.ts:78`, `:113` and
`tests/recoveryBatch.fixture.test.ts:149`). They do not alone prove their composition
through the coordinator after failure and lease handoff.

`tests/recoveryExistingEdit.fixture.test.ts` adds that composition. It commits an
initial plaintext note using the actual candidate coordinator and then admits a
versioned edit with the exact previous pointer/hash. A guarded generated-database
validator refuses version two after the new immutable generation has been
created/read back. The real transaction must fail with Mongo validation evidence;
the old note, sequence, wallet, ledger and pending operation remain unchanged.
The retained edit intent is verified, not a success receipt. Actual HTTP pull
still returns the old body, flag, version and cursor; the old file remains intact.

After releasing/acquiring the lease, the stale coordinator must fail without
business writes. A fresh invocation takes no client content and adopts only the
persisted verified intent. Keeping the Mongo fault active must still preserve the
old version without another debit or create. Removing only the fixture validator
allows the same saved generation to commit once, then settlement records the
original paid receipt. Terminal coordinator and actual HTTP push replay return
that immutable receipt with no financial or file changes. HTTP pull now returns
the edit. Both old/new generations remain available, and the journal contains
neither note body.

All state comparisons distinguish adoption/lease metadata from published success.
Persistent gate revisions may advance during guarded reads/adoption; the
preservation assertions cover notes/counter, operations/results, wallet/ledger,
saved file identities and exact old/new fake content. One seed sync and one edit
cost ten Energy each, with exactly two successful creates and two files. Recovery
retry/replay adds no charge, refund, file, version or sequence.

## CI acceptance

The existing full workflow runs this fixture and uploads a 26th named proof:
`sanitized-recovery-existing-edit-proof`, containing
`ci-recovery-existing-edit-proof.json`. Its exact success schema is
`{version:1, scope:"disposable inactive existing-note coordinator rollback and lease handoff",
phase:"complete", outcome:"pass"}`. No raw assertions, payloads, identifiers or
credentials are exported in this proof.

Exact-head CI, all prior 25 fixed-schema proofs and this new proof must pass before
merge; exact merged-main CI precedes mirroring or dependent publication. There is
no local test pass claim because npm dependencies remain absent; no installation
or local database is used.

## Verification boundaries

This test restarts the coordinator under a fresh lease in one test process. It
does not simulate OS process death or persistence of the fake file map across a
host restart. Existing SIGKILL/coordinator coverage in
`tests/recoveryUncertain.fixture.test.ts` is independent and uses fresh notes.
It must not be presented as killed-worker coverage of this versioned edit.

No production route calls the inactive writer. Current mutable Drive/Mongo
ordering, legacy missing/corrupt content, external Drive mutation after readback,
real Drive/OAuth/quota, old-writer exclusion, backup/restore, native/two-device and
signed upgrade acceptance remain separate. This additional causal composition
does not close R11 or R16 or claim cross-store atomicity. It does not change
refund classification, repair legacy damage, clean generations, or add any new
persistent field/index or public promise.
