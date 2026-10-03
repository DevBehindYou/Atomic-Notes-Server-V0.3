# Central financial-history writer

All production ledger insert paths now call appendLedger: energy grants/conversion/upgrades, sync charges/refunds, Controller adjustments and coin expiry. The caller retains responsibility for wallet changes, transaction retries and request replay. The helper requires an active Mongo transaction and forwards the original complete entry and session unchanged.

This is an architectural prerequisite for 50-entry physical retention. No pruning, index, sequence, statistics, wallet, coin-expiry or replay policy changes occur here. The independent API history-limit PR is not a dependency.

Proof: existing financial integration cases remain the behavioral regression baseline. New disposable integration cases reject detached writes, roll back an inserted entry together with its wallet mutation, and execute ten concurrent wallet/history transactions with exactly one committed row per increment. These are new contract checks, not claims of previously reproduced financial corruption. Full disposable CI must pass before review readiness.

Remaining: exact aggregate-statistics preservation, serialized history sequence/trimming, old-record migration rehearsal, client wording and production preflight. No production access is necessary to verify this refactor.
