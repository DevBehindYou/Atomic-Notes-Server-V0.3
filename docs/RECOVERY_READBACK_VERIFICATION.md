# Inactive staged-generation readback verification

**Verified in code:** the inactive commit kernel rereads the saved staged file
before publication (`src/lib/recoveryCommit.ts:37`), validates note identity,
flags and hash (`src/lib/recoveryCommit.ts:42`), then rechecks the manifest and
preimage within the fenced metadata/result/intent transaction
(`src/lib/recoveryCommit.ts:50`, `src/lib/recoveryCommit.ts:58`,
`src/lib/recoveryCommit.ts:67`). File identity, parent, MIME and trash validation
is in `src/lib/driveGeneration.ts:51`. Production routes do not import this kernel.

**Executable acceptance, pending until exact-head CI passes:**
`tests/recoveryReadback.fixture.test.ts` uses a generated disposable Mongo
replica-set database and a shared fake SDK/actual HTTP pull file map. After
committing an initial version, it stages a newer generation and injects eight
readback failures: changed body, changed note ID, wrong file ID, wrong parent,
wrong MIME, trashed, 404 and 503. Each refusal must preserve the old pointer,
metadata, sequence, results, journal, wallet and ledger; actual HTTP pull must
still return the old body and version. Gate revision touches are deliberately
outside that unchanged-state snapshot; no content is published by them.

Clearing the synthetic read fault must commit the same saved generation once,
advance sequence/version from one to two, and finish without another create or
debit. A subsequent staged generation is explicitly removed from the fake map:
commit must refuse, and explicit `abandonRecoverySync`
(`src/lib/recoverySettlement.ts:20`) must refund once while keeping version two
and both previous generation files. Actual HTTP successful and failed receipt
replays must make no further financial, metadata, journal or file changes.

Only the fixed allowlisted phase/outcome artifact
`ci-recovery-readback-proof.json` is uploaded. CI metadata, required successful
steps and this artifact must be checked on the exact PR head before merge.

**Verification boundaries:** no real Drive/OAuth/Atlas/Vercel, process kill,
keystore, phone or signed upgrade is exercised. The fake removal is an external
fault; candidate code never deletes files. Recreating an already-deleted Google
file ID is not assumed or tested. Drive can still change after readback and
before Mongo commit; immutable application writes reduce that risk but cannot
make external Drive changes atomic with Mongo. Automatic error classification,
backoff, reconciliation and production activation remain incomplete. These
tests neither repair legacy cloud damage nor establish production readiness.
