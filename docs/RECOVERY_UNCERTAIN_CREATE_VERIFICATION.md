# Coordinator restart during an uncertain create reply

This is test-only acceptance for the inactive coordinator. The parent process
owns disposable Mongo and a loopback fake Drive service. The service persists
the first generation but withholds the HTTP create response. The parent then
sends SIGKILL to the actual Node worker while it awaits that response, before
journal verification or metadata publication. Child stdout/stderr are ignored;
IPC and the selected artifact contain fixed checkpoint codes only.

A fresh worker must use the journal's saved file ID, read the persisted
generation, and report only the second row as needing client content. Another
fresh worker receives just that missing synthetic row and invokes the inactive
coordinator. The saved first ID returns 409 on repeated create and must pass
exact readback; the second generation is created once. Both metadata/results
commit, and settlement preserves one ten-energy debit. A fourth worker replays
the completed operation with no Drive calls. Actual notes HTTP pull and receipt
replay preserve both bodies, versions, wallet, ledger and sequence counter.

The older process-checkpoint fixture remains intact and runs with this fixture.
The worker's added modes are guarded test-only commands; no production route
or activation path imports the worker. Local typecheck/pure tests and exact-head
CI gates are recorded in the root acceptance checkpoint. Only
`ci-recovery-uncertain-proof.json` exports the fixed phase/outcome.

This adds actual process termination during an uncertain HTTP response, but
Mongo and fake Drive remain alive. It is not real Drive durability/OAuth/quota,
simultaneous service outage, OS power loss, native key storage or signed upgrade
proof. Lease takeover uses an injected clock. The original second client row
is deliberately absent from Mongo; recovery cannot invent content never uploaded.
Production recovery, old-writer exclusion, cleanup and legacy repair remain
separate acceptance and approval gates.
