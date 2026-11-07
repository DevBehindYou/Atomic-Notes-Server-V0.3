# Economic provenance reconciliation (C27)

C27 adds a read-only tool that checks the stored economy records against the rules the production writers maintain. Its report holds counts, reason codes and short one-way hashes only. It builds on two earlier tools: the accepted provenance inspection (`src/db/ledgerProvenanceInspection.ts`, `db:inspect-ledger-history`) and the C25 read-only guard (`src/db/queryDiagnostics.ts`).

**Nothing in the economy changes.** Rates, credits, billing, refunds, rewards and coin policy stay exactly as they are. No production economic code path is modified.

## Files

| File | Contents |
| --- | --- |
| `src/db/economicReconciliation.ts` | The invariant logic for one owner's records. It is pure and needs no database. |
| `src/db/economicReconciliationRunner.ts` | The snapshot loader, the guarded read-only runner and argument parsing. |
| `src/scripts/reconcileEconomy.ts` | The operator command, `npm run db:reconcile-economy`. |
| `tests/economicReconciliation.unit.test.ts` | Unit tests over synthetic records held in memory. Part of `npm test`. |
| `tests/economicReconciliation.fixture.test.ts` | A MongoDB fixture test that writes its data through the real production paths. Part of `npm run test:client-fixture` (CI only). |

## Rule: no guessed links

A record is matched to another record only through a reference that is actually stored:

- a ledger row's `coinOperationId` or `lotIds`;
- a receipt's `allocations[].lotId`;
- an expiry row's `lotIds`.

If an outcome could only be decided by inferring a link, it is counted as `unknown` with a reason code. Two codes cover the unlinked cases:

- **`unlinked_legacy`**: the wallet was not migrated to coin lots, or the row was written before coin-lot activation.
- **`unlinked_current`**: the wallet uses coin lots and the row was written after activation.

The tool never matches records by equal timestamps or equal amounts.

Sync charge and refund ledger rows have no reference to their operation (`syncOperation.ts:104-106` and `syncOperation.ts:192-194`). They are therefore reconciled per owner only, as counts and sums. The comparison covers only the window that retained operations cover, starting at the owner's oldest retained operation. Rows older than that window are reported as `rowsOutsideWindow` and are never matched.

## Invariants

These are the rules the reconciliation checks. Each line reference points to the production code that maintains the rule.

| Invariant | Unit | Rule maintained by the code | Outcomes |
| --- | --- | --- | --- |
| `wallet_ledger_chain` | wallet | Every writer stores the balance after its own change, in the same transaction as the change. **Writers:** welcome `energy.ts:95-103`, daily grant `energy.ts:184-192`, convert `energy.ts:223-232`, purchase `energy.ts:271-280`, sync charge `syncOperation.ts:104-106`, sync refund `syncOperation.ts:191-194`, expiry `coinLots.ts:44-48`, admin `routes/admin.ts:176-189`. **So:** each row's resulting balance equals the previous row's balance plus this row's change, and the newest row equals the wallet's `coins`/`energy`. **Row order:** by `historySequence` for marked wallets (`ledger.ts:23-27`). For unmarked wallets, by `createdAt`, allowing commit-order inversions of up to 120 s (one transaction-retry window). | discrepant: `chain_break`, `tail_mismatch`. unknown: `no_retained_rows`, `malformed_rows`, `malformed_wallet`, `ambiguous_order`, `history_too_large`. |
| `wallet_lot_balance` | coin-lot wallet | `coins` equals the sum of `remaining` across the wallet's lots, including lots that are due but not yet settled (`coinLots.ts:147-157`, `ledgerProvenanceInspection.ts:149-161`). Lots exist only on migrated wallets (`coinLots.ts:20-31,73`). | discrepant: `scalar_lot_mismatch`, `lots_without_migration`. unknown: `invalid_lot`. |
| `coin_row_provenance` | ledger row with `coinsDelta ≠ 0` | The stored references point to this owner's receipt and lots. This reuses `ledgerProvenanceIssues`. | discrepant: `reference_not_owned`, `malformed_row`. unknown: `unlinked_legacy`, `unlinked_current`. |
| `sync_charge_policy` | sync operation | A paid request is charged the cost for its mode (`syncOperation.ts:97`). A zero-row request is charged 0 (`syncOperation.ts:75-80`). An unpaid emergency logout batch is instant and charged 0 (`logoutAttempt.ts:119-124`). | discrepant: `charge_not_current_policy`, `charged_without_rows`, `malformed_operation`. |
| `sync_refund_bounds` | sync operation | `0 ≤ refunded ≤ charged`, with the refund capped by the energy cap (`syncOperation.ts:183`). A refund is made only when every settled row failed (`syncOperation.ts:181`). A pending operation has `refunded = 0` (`syncOperation.ts:78,100`). | discrepant: `refund_exceeds_charge`, `refund_with_delivered_row`, `pending_with_refund`, `malformed_operation`. |
| `sync_settlement_results` | sync operation | A complete operation stores exactly one result per requested row (`syncOperation.ts:137-144,161,197`). | discrepant: `results_mismatch`, `unknown_status`. unknown: `pending_operation`. |
| `sync_charge_ledger` | owner | One `spend` row per charged operation. `debitSyncInSession` is the only `spend` writer (`syncOperation.ts:94-108`). A replay returns the stored operation (`syncOperation.ts:39-46,56-59`). The count and sum are compared inside the retained window. | discrepant: `unmatched_charge_rows`, `missing_charge_rows`, `amount_mismatch`. unknown: `ledger_history_trimmed`, `unlinked_legacy`, `malformed_rows`. |
| `sync_refund_ledger` | owner | One refund row per refunded operation. It is identified on the server by the refund writer's exact note (`syncOperation.ts:194`); the note text is never returned. | discrepant: `orphan_refund_rows`, `missing_refund_rows`, `amount_mismatch`. unknown: as for `sync_charge_ledger`. |
| `lot_bounds` | coin lot | `0 ≤ remaining ≤ amount` (`coinLots.ts:159-161`, `ledgerProvenanceInspection.ts:9-12`). Spending never goes below zero (`coinLots.ts:56,64-68`). | discrepant: `negative_remaining`, `remaining_exceeds_amount`, `malformed_lot`. |
| `lot_consumption` | coin lot | `amount − remaining` equals the receipt allocations stored for the lot (`coinLots.ts:54-69,97-106`) plus the expiry rows that reference it (`coinLots.ts:41-48`). | discrepant: `unexplained_consumption`, `over_explained`. unknown: `unlinked_consumption`, `invalid_lot`. |
| `lot_expiry` | expiring coin lot | Expiry happens at or after `expiresAt`, once, and leaves `remaining = 0` (`coinLots.ts:34-48`). Every spend settles due lots first (`energy.ts:207`, `energy.ts:250`, `routes/admin.ts:147`), so nothing is allocated after expiry. Settlement is lazy (`coinLots.ts:108-121`). | discrepant: `consumed_after_expiry`, `expired_before_due`, `repeated_expiry`, `remaining_after_expiry`, `expired_non_expiring_lot`. conforming with reason: `due_unsettled`. unknown: `invalid_lot`. |
| `coin_receipt_ledger` | coin receipt | Exactly one ledger row references a receipt that has allocations. That row's `-coinsDelta` equals the sum of the allocations, and its `lotIds` equals the set of allocated lots (`energy.ts:221-226,269-274`, `routes/admin.ts:172-179`). A receipt with no allocations has at most one row: the capacity no-op writes none (`energy.ts:252`). A replay writes nothing (`coinLots.ts:86-91`). | discrepant: `duplicate_ledger_rows`, `missing_ledger_row`, `allocation_amount_mismatch`, `allocation_lot_mismatch`, `malformed_receipt`. unknown: `ledger_history_trimmed`. |

### When history counts as trimmed

An owner's history counts as trimmed in either of two cases:

- **Archived rows:** the owner's `ledger_history_archives` document has positive counts (`ledgerRetention.ts:36-48`). Retention also writes an archive document with no counts on every marked append, and that alone does not count as trimmed.
- **Ledger TTL index:** the catalog shows a TTL index on `energy_ledger`.

When history is trimmed, a missing ledger row is `unknown` (`ledger_history_trimmed`), not discrepant. An extra row stays discrepant, because retention only ever removes rows.

## Report format

The tool prints one JSON object:

```json
{
  "version": 1,
  "tool": "c27-economic-reconciliation",
  "mode": "read-only",
  "database": "operator-selected",
  "scope": "all-owners",
  "asOf": "<ISO>",
  "snapshot": true,
  "population": {
    "wallets": 0, "ownersWithoutWallet": 0, "ledgerRows": 0, "syncOperations": 0,
    "coinLots": 0, "coinReceipts": 0, "archivedOwners": 0, "malformedOwnerRows": 0
  },
  "catalog": { "ledgerTtlIndexes": 0, "syncOperationTtlIndexes": 0 },
  "invariants": {
    "<id>": {
      "unit": "wallet", "conforming": 0, "discrepant": 0, "unknown": 0,
      "reasons": { "<code>": 0 },
      "rowsOutsideWindow": 0,
      "samples": [{ "reason": "<code>", "ref": "<12 hex>" }]
    }
  },
  "summary": {
    "conforming": 0, "discrepant": 0, "unknown": 0,
    "discrepantInvariants": [],
    "countsDigest": "<16 hex>"
  }
}
```

Notes on the fields:

- **`samples`** lists discrepant records only, at most 10 per invariant, sorted. Each `ref` is `sha256("c27-ref:" + record id)` truncated to 12 hex characters. An operator can recompute the hash locally to find a record; the report never prints an id.
- **`countsDigest`** is a hash of the per-invariant counts and reasons only. Two datasets with the same outcomes give the same digest.
- **Determinism:** for the same data, the whole report is identical.
- **Sanitization:** `assertSanitized` (C25) runs on every report. The report holds no user ids, emails, notes, balances of named accounts or connection details.

## Safety guards

- **Connection:** the connection string is read only from `RECONCILE_MONGODB_URI`. The tool never reads `MONGODB_URI` or `.env`. The URI is parsed by the C25 `assertUriAllowed`.
- **Arguments:** the only form accepted is `--read-only --database <name> [--owner <uuid>] [--as-of <ISO-8601 UTC>]`. There is no apply, repair or seed mode. Anything else is a usage error.
- **Command allowlist:** every command the tool sends is checked against the C25 `commandViolation` read allowlist and must target the selected database. Any other command fails the run (`reconciliation_read_only_guard_violation`).
- **Consistent snapshot:** all streams read one snapshot session (`readConcern: snapshot`). Catalog reads are separate and never create a collection.
- **Note text:** note text is reduced on the server to an empty string plus a refund-writer flag, so it never reaches the client.
- **Bounded memory:** each collection is streamed once in owner order (aggregate `$sort` on the existing owner-prefixed indexes, with `allowDiskUse: false`) and merge-joined. Memory therefore holds one owner's records at a time.
- **Errors:** driver errors are never printed.
- **Exit codes:** `0` means no discrepancy, `2` means discrepancies were counted, and `1` means the run failed.

## Synthetic proof (fixture test)

The fixture test seeds a generated `atomic_test_*` database using the production functions:

- `energyEnsure`, `energyConvert`, `energyGrantDaily` and `energyUpgradeNoteLimit`;
- `beginSync`, `debitSyncInSession`, `recordSyncResult` and `finishSync`;
- the real admin `/energy` route;
- `prepareCoinWallet` for expiry;
- `initializeLedgerSequence` together with automatic retention.

After that, it inserts one legacy wallet by hand and injects four discrepancies.

| Owner | Case | What it produces | Expected result |
| --- | --- | --- | --- |
| A | Charges and refunds on a scalar wallet | Two direct debits. A refund capped at 5 of 10 because a daily grant lands before settlement. Replays of a capped and of a fully refunded request. A partial failure. A zero-row request. An abandoned request settled by the next one. | All conforming: 8 operations; charge rows 7/65 match charged operations 7/65; refund rows 3/25 match refunded operations 3/25; the chain is conforming. Its 3 coin rows are `unlinked_legacy`. |
| B | Coin lots, replay and an unlinked purchase | A welcome lot, then a linked conversion and its replay (no new receipt or row), then a linked admin credit, then a note-limit purchase without a request id, then expiry. | Receipts and coin rows with stored references are conforming. Both lots are `unlinked_consumption` (unknown). The welcome row and the purchase row are `unlinked_current`. |
| C | Missing legacy source | A hand-inserted legacy history with no operations and no references. | Chain conforming. Coin rows: 3 `unlinked_legacy`. `sync_charge_ledger` and `sync_refund_ledger` are each `unlinked_legacy`, with 2 and 1 `rowsOutsideWindow`. |
| E | Lazy expiry | An active lot that is due at `asOf` but not yet settled. | `lot_expiry` is conforming with reason `due_unsettled`. |
| F | Expiry | Conversion followed by expiry. | Lot consumption explained exactly (1 + 4); expiry conforming. |
| G | Trimmed history | A sequenced wallet with 26 failed syncs. Retention keeps 50 rows and archives 5. | The chain over the retained rows is conforming. Charge, refund and receipt checks are `ledger_history_trimmed` (unknown). |
| D1 | Injected orphan refund | A sync refund row with no refunded operation, kept balance-consistent. | `sync_refund_ledger`: `orphan_refund_rows`. |
| D2 | Injected double charge | A second charge row for one charged operation. | `sync_charge_ledger`: `unmatched_charge_rows`. |
| D3 | Injected negative lot | A lot with `remaining: -1`. | `lot_bounds`: `negative_remaining`. Dependent checks are `invalid_lot` (unknown). |
| D4 | Refund over charge | An operation's stored refund raised to 15, above its charge of 10. | `sync_refund_bounds`: `refund_exceeds_charge`. `sync_refund_ledger`: `missing_refund_rows`. |

The test also verifies that the run changes nothing and is repeatable:

- **No writes:** the database's `dbHash` is the same before and after three runs (all owners twice, one owner once).
- **Allowlisted commands:** every command sent was on the allowlist, and there were no guard violations.
- **Repeatable:** the two all-owner runs produced identical reports.
- **Sanitized:** no owner id, record id, note or database name appears in any report.

The exact per-invariant counts are asserted in the test and printed in CI as `ECONOMIC_RECONCILIATION_*` diagnostics.

## Findings in the real code paths

1. **Sync charge and refund rows carry no operation reference** (`syncOperation.ts:104-106,192-194`). Per-operation provenance for energy cannot be proved from stored data. Only per-owner counts and sums inside the retained window can be. Adding a reference would be a writer change and is out of scope for C27.
2. **`energyUpgradeNoteLimit` does not call `requireCoinRequestId`** (`energy.ts:241-283`). The conversion path does (`energy.ts:208`) and so does the admin route (`routes/admin.ts:148`). On a coin-lot wallet, a note-limit purchase without `request_id` therefore takes coins from lots with no `coin_operations` receipt and no row references. The fixture's owner B reproduces this: its lot consumption cannot be attributed and is reported as `unlinked_consumption`. The route accepts `request_id` as optional (`routes/energy.ts:115`). Whether to require it is a product and economy decision; it is not changed here.
3. **The welcome gift row has no references by design** (`energy.ts:95-103`). On migrated wallets it is counted as `unlinked_current`.
4. **Ordering on unmarked wallets has a tolerance.** Their `createdAt` order may differ from commit order, because charge rows use the time computed before the transaction (`syncOperation.ts:71,106`). The chain check therefore accepts a valid ordering within 120 s. A break that no admissible ordering explains is still discrepant.

## Limits

- **Snapshot duration:** snapshot reads must finish within the server's snapshot history window (MongoDB's default is 300 s). A very large dataset may need an owner-scoped run.
- **Reorder search:** the search is bounded (a budget of 20,000 steps, and at most 5,000 rows per wallet). Beyond that the result is `unknown` (`ambiguous_order` or `history_too_large`).
- **Indexes:** owner-ordered streaming relies on the production owner-prefixed indexes from `ensureIndexes()`. Without them a large collection's sort fails instead of spilling to disk.
- **Unmatchable references:** references to another owner's records are reported as `reference_not_owned` without telling a missing record from a foreign one. `db:inspect-ledger-history` makes that distinction.
- **Pricing history:** `charge_not_current_policy` compares stored charges with the current constants. A historical price change would show up there and need a human review.
- **No real-database run:** the tool has not been run against any real database. Doing that is an operator decision.
