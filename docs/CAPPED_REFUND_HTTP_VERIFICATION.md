# Failed-sync refunds capped by intervening real admin grants

Fixture-only follow-up from verified Server main
`327bcf8dc1834da5f3c72159bd0d429160da7cc4`. Production source, schemas,
dependencies, costs, grant/refund policy and Controller deployment are unchanged.

The guarded loopback assembly adds the existing admin router with a deliberately
public synthetic key overridden inside the test process. No production values
are read. A strict test control accepts one UUID and none/partial/full modes;
the intervening grant targets only the seeded primary owner. During that note's fake Drive
failure, after the sync debit, one real loopback admin energy adjustment fills
the wallet to cap minus one or the full cap. The transaction and financial
history come from the existing real admin route, not a direct wallet overwrite.

The real HTTP/Mongo case proves standard sync charges 5, delivers no rows, and
refunds only 1 or 0 when there is that much headroom. Actual ledger deltas match
the spend, intervening grant and refund. The standard window restores even when
no refund fits. Each operation is complete, and an exact replay returns the full
same failed receipt without another grant, write, debit, refund or ledger row.
Invalid admin key and wrong fixture-control token are refused.

This characterizes existing policy: “all failed syncs refund the full charge”
requires a cap caveat. It does not change that policy or prove Atomic Controller
browser login/authorization, concurrent administrator devices or production
operations. The fixture control is a deterministic interleaving seam, not a
production endpoint. Original two-key/HMAC Controller behavior is outside scope.

Local type checking and 63 pure controls must pass. Actual database execution is
CI-only in the generated namespace. The matching App receipt/cache proof is a
separate follow-up. R25 remains partial; exact-head and destination-main gates apply.

The first two CI revisions failed this new scenario. The deliberately sanitized
second-run artifact identifies `ledger_deltas` in partial mode; earlier checks
(including the capped receipt and final wallet) passed. The diagnostic query has
no ordering contract, so the test now compares ledger multisets, preserving
duplicate counts instead of assuming insertion order or slicing at an old length.
That diagnosis is an inference until the corrected exact-head CI passes. No
production ordering, billing, or refund behavior is changed. A dedicated artifact
contains fixed phase/mode/outcome codes only, never raw assertions or identifiers.
