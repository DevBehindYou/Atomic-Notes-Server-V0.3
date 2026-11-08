# Scoped gateway delegation (C38)

Status: **disabled**. A verifier and a gated route exist; no deployment wiring supplies
verification keys, a replay store or subject records, and no notes, wallet, Energy or
billing route consults it. A verified assertion authorizes nothing by itself yet.

Source: `src/lib/delegation.ts` (pure, `node:crypto` only), `src/routes/delegation.ts`.
Consumer fixture: `tests/fixtures/delegation/assertion.v1.json` (canonical JSON, LF),
pinned byte for byte by `tests/delegation.unit.test.ts` and copied into the browser
gateway (Atomic-Notes-WebApp-Server-V0.3) tests.

## Model

A browser gateway holds a server-side browser session bound to an App Server account.
For one of those sessions it mints a short assertion; the App Server, the existing
authority, verifies it and then **re-checks `sub` against its own record** of which
account that gateway session `(iss, sid)` is bound to. The browser never supplies an
account id with authority, never sees the assertion, and no provider token or App Server
bearer travels in it.

## Assertion v1

```
atomic-delegation-v1.<payload>.<signature>
payload   = base64url(canonical claims JSON)        (no padding, canonical encoding only)
signature = base64url(Ed25519(ASCII "<header>.<payload>"))
```

The algorithm is fixed by the header; nothing in the assertion selects a key type or
algorithm, and a non-Ed25519 key from the key port never verifies. At most 2048 bytes.

| Claim | Rule |
| --- | --- |
| `v` | `1`. Another integer is `delegation_unsupported_version`, as is header `atomic-delegation-v<n>` |
| `aud` | exact App Server audience string, compared in constant time |
| `iss` | gateway id `[a-z0-9][a-z0-9-]{0,62}`; selects verification keys |
| `kid` | key id `[A-Za-z0-9_-]{1,64}`, for rotation |
| `sub` | App Server account id (lowercase UUID) the gateway session is bound to |
| `sid` | opaque gateway session reference, 43 base64url chars. The gateway derives it as `base64url(sha256("atomic-delegation/sid/v1" 0x00 familyId))` |
| `scope` | non-empty unique list; v1 allows only `notes:read`. No wallet, Energy, billing or write scope exists |
| `iat`, `exp` | integer epoch seconds; `0 < exp - iat <= 300`; clock skew 30 s each side |
| `jti` | `[A-Za-z0-9_-]{22,64}`, single use per issuer until `exp + skew` |

Claims are exactly these ten keys, in this order, serialized with `JSON.stringify` and no
whitespace. Extra fields (an `accountId`, a provider token, a wallet grant), missing
claims, duplicate keys, reordering, whitespace and non-canonical base64url are
`delegation_malformed`.

## Verification order and errors

Structure, issuer key, signature, audience, lifetime, not-before, expiry, scope, single
use, subject record. A refused assertion only consumes its `jti` if it was authentic and
otherwise valid. All refusals are `401 {"error": code}`:

`delegation_malformed`, `delegation_unsupported_version`, `delegation_unknown_issuer`,
`delegation_bad_signature`, `delegation_wrong_audience`, `delegation_not_yet_valid`,
`delegation_expired`, `delegation_lifetime_exceeded`, `delegation_scope_denied`,
`delegation_replayed`, `delegation_subject_mismatch`.

## Ports

- `DelegationKeyPort.verificationKey(iss, kid)`: public keys only, so the App Server cannot mint.
- `DelegationReplayPort.claim(iss, jti, expiresAtMs)`: atomic single use. `MemoryReplayStore` is test only.
- `DelegationSubjectPort.boundAccount(iss, sid)`: the App Server's own binding record, or null.

Tests generate Ed25519 keys at runtime. No key material is committed.

## Route and gate

`POST /api/delegation/verify`, JSON `{"assertion": "..."}` (at most 4 KiB). Only
`assertion` is read; any `accountId`, user id, `Authorization` or token field is ignored.

| `ATOMIC_DELEGATION_VERIFY_ENABLED` | Behaviour |
| --- | --- |
| unset or not exactly `true` | Nothing registered: identical to an unknown route (404) |
| `true`, no verifier wiring (every deployment today) | `503 {"error": "delegation_unavailable"}` |
| `true` with injected ports (tests only) | `200 {verified, contract, version, iss, sub, scope, exp}` or `401 {error}`; `400 delegation_request_invalid` for a bad body |

Responses carry `Cache-Control: no-store` and never echo the assertion or any token.
The capability document's `delegation` entry stays `unsupported` with the gate off and is
`disabled` (`defined: [1]`, not negotiable) with it on (`docs/CAPABILITIES.md`).

## Open decisions

1. Key management and rotation: where gateway public keys live, `kid` rollover, revocation.
2. Audience naming per deployment (tests use `urn:atomic-notes:app-server:test`).
3. Scope set beyond `notes:read`; any write scope needs its own review. Wallet, Energy and billing stay out.
4. A durable, shared replay store (TTL index on `exp`) before any activation.
5. How the App Server creates and revokes the `(iss, sid) -> account` binding it re-checks
   (for example at gateway login exchange and logout), and which existing route consumes a
   verified delegation.
