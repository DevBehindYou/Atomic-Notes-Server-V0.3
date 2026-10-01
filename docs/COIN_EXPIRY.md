# Coin expiry implementation — staged, inactive by default

Owner-approved implementation, 1 October 2026. Production activation/migration is NOT authorized by this change.

New credits (including new-wallet welcome coins) expire six UTC calendar months after Server acceptance, with month-end clamping. Each batch retains its date. Existing wallet balances initialize once into a non-expiring legacy batch. Spending uses earliest expiry first, then credit time and ID; legacy coins last. Energy already converted and purchased capacity do not expire.

## Rollout boundary

COIN_EXPIRY_ACTIVATED_AT is unset by default. It accepts only a canonical UTC ISO instant with milliseconds. No deployment configuration sets it in this PR. Before separately approved activation: deploy compatible App/Controller clients, build reviewed indexes using db:indexes, drain old scalar-only Vercel writers, record the authorized activation instant, and reconcile disposable fixtures. No production script or database was run here. Lazy first-access initialization is a migration and must only run after that approval.

Migrated wallets stay batch-authoritative if this setting is later removed. That does not make mixed-version rollback safe: once activated, do not restore old scalar-only code or issue credits through old deployments. Stop coin mutations and use reviewed forward repair. Unmigrated wallets remain unchanged while the policy is inactive.

## Contracts

- atomic_users: additive coinLotsVersion and coinPolicyActivatedAt; coins remains the transactionally maintained summary.
- coin_lots: one document per credit, amount and remaining; source legacy/welcome/controller; nullable expiresAt. No TTL.
- coin_operations: permanent user/request identity, fingerprint, saved result and debit allocations. No TTL.
- POST /api/admin/energy accepts request_id UUID. Required after migration, including energy-only adjustments. Same ID/body replays; different input returns 409 coin_request_mismatch. Negative adjustments still clamp to zero and record actual deltas.
- POST /api/energy/convert accepts request_id UUID; required after migration. Older clients safely receive 409 coin_request_id_required. The client must durably retain the ID before sending, and retry it after an ambiguous response.
- POST /api/energy/note-limit accepts optional request_id; the existing from_limit guard still prevents charging twice even on old clients.
- GET /api/energy adds coin_details and wallet.coin_expiry_enabled. GET /api/energy/coins pages the signed-in user's batches; GET /api/admin/coins?user_id=... uses admin auth. Both accept an opaque cursor. Fifty rows per page, stable credit-time/ID order. Balances and next-expiry summary are current at server_time; rows are historical, including exhausted lots.
- Expiry is evaluated at transaction attempt time and on balance reads, not by document deletion. It writes one ledger event per expired unspent batch. Replaying monetary operations never creates a second economic event. Historical ledger resulting balances remain historical.

## Verification and limits

Calendar and activation tests run locally. Integration tests use only CI's disposable local MongoDB replica set and fake Drive, never Atlas or real users. They cover concurrent legacy initialization, welcome lots, duplicate grants/conversions, fingerprint mismatch, FEFO/legacy-last, partial/exact expiry, overspend/cap rejection, capacity idempotency, clamped admin debits, grant/expiry races, account isolation, and no monetary TTL indexes. Existing sync command budgets are retained with the policy inactive.

This is a new feature contract, not a claim that old releases already supported expiry. No payment integration, peer transfers, or coin-refund endpoint is introduced. A discretionary Controller credit starts a new batch; a future reversal/refund implementation must use original allocations/dates. Two physical devices and production latency have not been tested. Permanent financial record growth remains an operational retention consideration.

## Read-only reconciliation tool

After separate rollout review, `node --env-file-if-exists=.env --import tsx src/scripts/reconcileCoins.ts` reports migrated wallet count, scalar/batch mismatches, and invalid remaining quantities. It never settles or initializes wallets and prints no account IDs. It compares stored summary with all remaining lots, including due but not yet settled lots; availability is evaluated separately by read/spend paths. This tool was tested only on disposable fixtures. Do not mistake a clean stored-summary report for permission to activate the policy or roll back code.

GET /api/energy and admin health advertise coin_request_replay: true. New clients must verify that capability before sending/retrying monetary requests; old Servers ignore unknown request IDs. Deploy this Server before the clients. The expiry policy may remain inactive during this compatibility rollout.
