# B01: legacy paid security-migration baseline

`tests/clientFixture.securityMigrationBaseline.test.ts` records the current
legacy paid policy before B04 introduces validated migration admission. It is
baseline evidence, not acceptance of the proposed free migration capability.

For both standard (5 Energy) and instant (10 Energy) sync, the fixture:

1. Writes a plaintext note through the actual HTTP push route.
2. Sets only the generated fixture wallet to zero, with a fresh daily-grant
   timestamp so a refill cannot hide the admission decision.
3. Attempts a same-note, same-version encrypted replacement twice. Both
   attempts return `409 insufficient_energy` and preserve wallet, ledger,
   operation records, metadata, sequence counter, and fake Drive diagnostics.
4. Pulls for free at zero Energy and verifies the original plaintext remains
   readable. Refused migration has not been reported as complete.
5. Funds exactly the legacy request price in the generated fixture wallet and
   retries the same request ID. The replacement succeeds with one charge and
   an encrypted payload on readback. Replaying the completed receipt at zero
   Energy causes no further charge or file write.

The funded control distinguishes payment admission from an invalid encrypted
envelope or version conflict. It also proves that refusal did not reserve the
request ID. No production route, financial policy, migration schema, vault UUID,
or KDF changes are included. The server treats the ciphertext as opaque; this
test does not claim to prove client vault setup or crash-safe migration.

The existing capped-refund baseline remains in
`tests/clientFixture.cappedRefund.test.ts`; it already covers partial/full
intervening admin refills, cap-limited legacy refunds, cooldown restoration and
receipt replay. It must not be mistaken for B03 full-value compensation.

## Running the focused fixture

Use an already running disposable local MongoDB replica set. The fixture guard
requires a credential-free `mongodb://127.0.0.1:<port>/?replicaSet=rs0&directConnection=true`
URI and rejects a selected database. Never load `.env` or point this at an
existing account/database. `startClientFixture` generates and later removes only
its own `atomic_test_*` database; Drive and authentication are synthetic.

```powershell
$env:MONGODB_URI = 'mongodb://127.0.0.1:27139/?replicaSet=rs0&directConnection=true'
Remove-Item Env:MONGODB_DB_NAME -ErrorAction SilentlyContinue
node --import tsx --test tests/clientFixture.securityMigrationBaseline.test.ts
npm run typecheck
```

The test is also registered in `npm run test:client-fixture`. Its fixed-code
`ci-security-migration-baseline-proof.json` contains only scope, phase, selected
mode and pass/fail, with no note content, account IDs, credentials or URI.

## Countercheck

To demonstrate the policy gap, run an uncommitted temporary test copy that
expects the zero-Energy replacement to return 200 instead of 409. It must fail
at that assertion with actual status 409. Remove the copy and rerun the baseline
unchanged. This countercheck demonstrates that free security migration is
absent; it is not an implementation of B04 or proof of its future safeguards.
Do not commit the desired-policy assertion as a failing test or describe the
passing legacy fixture as completion of B04/T05.
