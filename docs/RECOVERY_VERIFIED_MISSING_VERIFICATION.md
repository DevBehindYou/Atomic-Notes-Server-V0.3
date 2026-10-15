# Inactive verified missing-generation recovery

This slice extends only `resumeRecoveryOperation`, an inactive trusted-caller
coordinator. A pending uncommitted verified row whose saved generation returns
404 can request retained client content through the existing internal
`needs_client_content` result. Matching supplied content may be staged through
the existing `stageRecoveryIntent` at the identical persisted file ID, then
published through the unchanged final readback, fenced commit and settlement.

Resolution considers prepared and verified rows in operation order before any
staging. Verified rows are read even when client content was supplied. A present
verified generation is never created again; its content is checked by the final
commit readback. Only an observed 404 makes a verified row eligible for the
existing staging helper. Unknown errors propagate and keep the paid operation
pending. Prepared behavior and the eight-worker drain are retained.

## Causal fixture and scope

`tests/recoveryVerifiedMissing.fixture.test.ts` uses the existing canonical
localhost replica-set guard, generated database ownership checks, client HTTP
fixture and a process-local fake Drive map. It seeds an actual committed note,
stages a current edit to verified, retains the old generation and original
client body, then removes only the uncommitted fake generation. The tests-only
characterization head preserves the accepted coordinator source. Both intended
assertions fail independently there with a caught raw 404: requesting missing
content and finishing with exact original supplied content. The sanitized proof
records `raw_404` labels without exception text, identifiers or note content.

The fake map deliberately allows creation at a removed key. This is an
orchestration proof, not evidence that real Google Drive permits reuse of a
permanently deleted ID. A real service refusal propagates, leaves the operation
pending and allocates no alternate ID. This is not historical content repair.

The fixed candidate retains the identical causal fixture blob. Its artifact
`ci-recovery-verified-missing-proof.json` has fixed schema version 1, scope
`disposable inactive verified missing generation retained ID recovery`, phase
`complete`, outcome `pass`, causal labels `returned`/`returned`, and these
allowlisted case labels, all `pass`:

| Case | Assertions |
| --- | --- |
| `verified_missing_request` | Exact missing note ID; no create or protected-state mutation; actual HTTP pull retains the old committed body/version. |
| `matching_supplied_retry` | One fake-map replacement create at the persisted ID; same admission charge and no refund; version/sequence publish once; old generation byte-identical; terminal coordinator replay makes no Drive calls; actual pull and HTTP receipt replay preserve content and finances. |
| `mixed_resolution_order` | Prepared/verified missing rows request content in manifest order; all resolution completes before any staging. |
| `supplied_and_present_refusal` | Wrong body, kind, encryption or pinned flags cannot stage; foreign, duplicate and 51-row content is refused; present mismatched content cannot be overwritten or published. |
| `exact_409_race` | A file appearing at the retained ID after absence detection can succeed only through exact readback, without an overwrite. |
| `mismatched_409_refusal` | Wrong body, timestamp, parent, MIME, trash state or returned metadata ID refuses without publication. |
| `unknown_and_same_id_refusal` | 401/403/503/transport errors and unsupported same-ID create refuse without content-request classification, terminal failure, refund or replacement-ID allocation. |
| `final_readback_refusal` | A disappearance during final commit readback preserves protected state; the next retry may request content. |
| `encrypted_retry` | Original opaque payload restores at the same persisted ID; actual HTTP pull and receipt replay preserve ciphertext and finances. |
| `committed_terminal_exclusions` | A partially committed row is neither read nor staged and keeps its saved result; completed receipts do not access Drive after content disappears; explicit abandoned/refunded writes cannot revive. |
| `lease_handoff_fence` | A stored create with delayed reply cannot verify, publish or settle after handoff; a fresh same-epoch lease resumes the retained verified file with matching supplied content and no extra create. |
| `eight_stage_drain` | Nine verified missing generations use at most eight concurrent stages; all started replies drain before a failure escapes; no publication or financial change. |
| `wipe_epoch_fence` | A delayed create reply after an epoch change cannot verify/publish/settle; the pre-wipe manifest refuses adoption. |
| `owned_cleanup` | Release only the currently owned lease; close the fixture; verify the generated database identity before owned cleanup. |

The corrected causal head is
`3102220c1f3792c90f3fd5b497527ede7c877cb1`, run
[38712345997](https://github.com/DevBehindYou/Atomic-Notes-Server-V0.3/actions/runs/38712345997).
Its coordinator blob equals accepted main. The fixture blob is
`d2323914ab95e6d36ce73efeed296da5d62c5cba`; the fixed candidate keeps it unchanged.
That causal run passed typecheck, audit, build/entrypoint, unit, integration and
admin baseline gates. All previous 35 exact proof schemas passed. The new proof
recorded both intended `raw_404` failures and `owned_cleanup: pass`. The proof
is emitted only after the asynchronous checked cleanup actually settles,
including the early return after either causal assertion fails.

Protected-state snapshots explicitly include wallet, ledger, notes, operation,
manifest, intent state/outcome and sequence counter. They exclude permitted
journal adoption changes to `leaseToken` and `updatedAt`, and fence gate touches.
The proof never contains note text, payloads, credentials, identifiers or raw
exceptions. All prior 35 proof uploads and the accepted admin pagination
baseline remain in the workflow.

## Limits

There is no production route import, HTTP contract change, new schema/index,
lease policy, second debit, inferred refund, replacement ID, overwrite, untrash,
deletion, cleanup or committed/legacy repair. Readback is not an ETag/revision
conditional write: external Drive edits remain a containment boundary.
Missing committed content, real Drive behavior, old-writer exclusion,
historical repair, migrations, production activation and native/two-device/
signed acceptance remain separate. This does not close R11 or R16 or increase
the original findings' completion credit.
