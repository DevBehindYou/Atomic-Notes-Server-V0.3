# Account-gated ordered automatic history

This continuation depends on the tested Controller retained-statistics change. No production route, command, environment flag or account-creation path activates migration. Only a wallet marked historyRetentionVersion=1 opts in. Existing wallets keep their full stored ledger.

initializeLedgerSequence is an operator primitive requiring the caller transaction. It locks the wallet, refuses more than 50 remaining records or malformed/partial migration, backfills the retained records deterministically by timestamp/UUID, then marks the account and sequence high-water mark in the same transaction. Repeat initialization validates rather than resetting the counter. The final cleanup batch and initialization should share one transaction.

appendLedger assigns the next sequence for marked accounts and commits the balance mutation, sequence, full-history row, archived statistics and trimming together. It validates the bounded existing history and rolls back on missing/duplicate/out-of-range sequence or overflow. All existing ledger writers go through this function, including grants, sync charge/refund, coin conversion/capacity, Controller adjustments and expiry. Monetary replay paths return before appending.

Marked history sorts by sequence, including backdated or tied timestamps. The API response fields stay unchanged. Unmarked history retains timestamp/UUID ordering and no physical eviction. History reads use a snapshot across the marker and records.

Disposable proof: 51-row migration refusal; rollback of final cleanup+backfill; deterministic backfill; 55 sequential backdated credits keep exactly 50; repeated initialization preserves the high-water mark; rollback after automatic trimming preserves wallet/history/statistics; ten actual concurrent Controller credits; unchanged unmigrated history; unsequenced corruption refuses another credit and rolls back its balance mutation.

Pending: final sequence index/query proof, migration index readiness and preflight, production account enumeration, malformed/orphan handling, deterministic migration-versus-writer interleaving, exact global-statistics read timing under active cleanup, active refund/replay/coin-expiry matrices, backup/restore and old-writer exclusion. Production activation remains gated. No production records or indexes changed.
