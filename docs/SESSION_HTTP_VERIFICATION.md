# Real logout, session expiry and issuance fixtures

Fixture-only follow-up from verified Server main
`9043f90c276f7095f4551b415e41dfbaf6ac52b4`. The guarded loopback assembly adds
the existing auth router so its real logout endpoint can revoke synthetic
sessions. Google login routes are not invoked. Production source, schemas,
dependencies and session policy are unchanged.

The actual HTTP/Mongo case proves that logout retires only the supplied session:
its later notes request gets 401, while the other same-owner session and the
other owners remain accepted. Repeating authenticated logout with the now-invalid
token also gets 401; the low-level revoke helper's idempotence does not imply a
200 response from that authenticated endpoint. Wallet/ledger and fake Drive
writes are unchanged.

A synthetic session is made expired only in the generated namespace, and real
auth refuses it without waiting for TTL cleanup. Six sessions then use the real
issuance helper: stored IDs are hashes, each expiry is seven days after creation,
and five issued sessions remain valid. Same-millisecond ordering ties are not
characterized as deterministic newest-device selection by this case.

Local type checking and 59 pure controls must pass. Actual database execution is
CI-only. This does not prove OAuth token exchange, concurrent issuance, an
inactivity policy, native SessionGuard teardown or phone/account navigation.
The matching delayed-401 App proof is a separate follow-up. R25/R28 retain their
recorded boundaries. Exact-head and destination-main checks apply.
