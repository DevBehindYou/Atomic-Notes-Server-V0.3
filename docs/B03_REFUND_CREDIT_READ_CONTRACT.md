# B03 additive refund-credit read contract

This slice adds storage/read compatibility only. It does not activate full-value
refunds. Existing capped compensation, debit, refill, conversion, note-limit,
sync fingerprint and receipt policies remain in force.

## Storage and projection

`AtomicUserDoc` accepts the optional pair `refundCreditFormat: 1` and
`heldRefundEnergy`. The amount must be a nonnegative integer no larger than
`Number.MAX_SAFE_INTEGER`. Both fields absent is the legacy format. Explicit
incomplete metadata, null, fractions, negative/unsafe values and unsupported
formats are rejected. No default is added to stored or parsed legacy wallets.

`readHeldRefundEnergy` validates metadata and projects legacy absence as zero.
It is a pure reader: it never mutates the input, caps value, releases credit or
adds credit to spendable Energy. Invalid stored metadata fails with a fixed-code
server error; GET returns only `500 { error: "internal_error" }`, without values
or validation details and without repairing the record.

Only `GET /energy` adds `wallet.held_refund_energy`. The existing `wallet.energy`
continues to mean spendable Energy. Conversion/note-limit responses and
push/logout wallet receipts retain their existing projections. No sync-operation
receipt fields or version/fingerprint changes are included. The existing App
wallet decoder ignores unknown response fields; displaying held credit in the
App is separate work.

The whole GET route is **not read-only**: existing wallet initialization,
`energyGrantDaily` and Coin-lot migration behavior still apply. This slice adds
no metadata writes or defaults. HTTP nonmutation assertions use existing
wallets, fresh daily-grant timestamps and the fixture's disabled Coin-expiry
activation, so they isolate the new reader from those existing writers.

## Verification

Tests were written before implementation. Observed failures showed that the old
wallet schema stripped valid refund metadata and accepted invalid metadata,
the pure reader was absent, and the real GET route omitted the new field.

- `tests/refundCredit.unit.test.ts`: legacy absence, paired zero/positive/above-cap
  and safe-integer boundaries; invalid metadata; frozen-input nonmutation.
- `tests/refundCredit.fixture.test.ts`: real authenticated energy route over
  HTTP against a guarded generated MongoDB replica-set database. Legacy and
  explicit-credit reads (including concurrent reads) preserve wallet, ledger
  and operation snapshots under the stated preconditions. Invalid/future stored
  metadata returns a bounded 500 without mutation or silent repair. Maximum held credit
  cannot fund a zero-Energy push. Conversion still returns 40 Energy per Coin;
  the 30-to-40 note tier still costs 10 Coins, with legacy response keys.
- Both files are registered in the existing unit/client-fixture scripts used
  by CI. A bounded fixed-code proof is written by the HTTP fixture; it contains
  no identifiers, bodies, credentials or raw assertion output.

This is not a proof of credit issuance, cap/refill release, refund conservation,
concurrent settlement or expiry/retention safety. Those writers do not exist in
this slice. No production database, account, provider, device or App build is
part of this verification.

## Gates before financial activation

A later reviewed change must define transactional issuance/release, durable
source deduplication, policy/version negotiation and credit-preserving replay.
Resolve historical compensation and release-before-refill/debit ordering before
activation. B06 retention/deduplication work remains a prerequisite: recent
ledger retention deletes rows beyond its 50-row window, so a unique ledger key
alone cannot provide durable issuance deduplication. Do not depend on an event
TTL to preserve compensation obligations.

No issuance, release, refill/debit/conversion policy changes, activation flag,
backfill or historical compensation are introduced here. Rolling back this
slice is safe before issuance; after credits are issued, compatible readers
and release handling must be retained by the eventual activation design.
