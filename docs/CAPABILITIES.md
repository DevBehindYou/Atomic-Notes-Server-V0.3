# Capability and sync contract (C30)

`GET /api/capabilities` returns a versioned, deterministic document describing the
contract versions this deployment speaks. It is public and session-free, like
`/api/health`: it reads no database, session, account, wallet or Energy state. It
**describes; it never grants**. Every existing route keeps its own gate and ignores
capability declarations, so declaring a version cannot authorize a free write, give
wallet authority or activate an inactive or V2 contract.

Source: `src/lib/capabilities.ts` (pure), `src/routes/capabilities.ts`.

## Document v1

| Feature | Status | Negotiable versions | Derived from |
| --- | --- | --- | --- |
| `capabilities` | active | 1 | this contract |
| `noteEnvelope` | active | 0 (plaintext), 1 (encrypted payload) | `enc_v` in `src/types/noteWire.ts`, read from the schema |
| `logoutRecovery` | `active` or `disabled` | 1 | `ATOMIC_LOGOUT_SYNC_ENABLED`; version pinned to logout attempt `format: 1` |
| `credentialEnvelope` | server_internal | none | Google token envelopes at rest (`docs/CREDENTIAL_ENVELOPE.md`); formats and writer are not disclosed |
| `identity` | inactive | none (`defined: [1]`) | C28 `IDENTITY_CONTRACT_VERSION`, not active |
| `providerBinding` | inactive | none (`defined: [1]`) | C29 `BINDING_SCHEMA_VERSION`, integration disabled |
| `delegation` | `unsupported`, or `disabled` with `defined: [1]` | none | `ATOMIC_DELEGATION_VERIFY_ENABLED` (default off: `unsupported`, unchanged v1 fixture). C38 verifier, see `docs/DELEGATION.md`; never client-negotiable |

`logoutRecovery.status` is advisory, exactly like `/api/notes/logout-capability`
(which is unchanged): admission still rechecks the deployment gate. No billing,
Energy, wallet or ledger field is part of the document, and the module imports none
of those modules.

## Negotiation

A client may send `atomic-capabilities: capabilities=1; noteEnvelope=0,1; logoutRecovery=1`
(feature names `[A-Za-z][A-Za-z0-9]{0,31}`, versions are comma-separated integers,
at most 16 features, 8 versions each, 512 bytes).

| Request | Response |
| --- | --- |
| No header, or blank (legacy or unknown client) | 200, the bare document, unchanged |
| Every declared known feature shares a version | 200, document plus `negotiated` (highest common version per feature, document order) |
| A feature the client omits | Legacy behaviour; absent from `negotiated` |
| An unknown feature name | Ignored (forward compatibility); never reported as negotiated |
| A known feature with no common version, including any inactive, internal or unsupported feature | 406 `{error: "unsupported_capability", feature, supported}` (first failure in document order) |
| Malformed header | 400 `{error: "invalid_capability_declaration"}` |

Responses carry `Cache-Control: no-store` and `Vary: atomic-capabilities`. A
declaration is not stored and is not read by any other route. A client holding a
stale document must still expect each route to apply its current gate (for example
logout returns `404 logout_sync_unavailable` while the rollout is disabled).

## Consumer fixtures (Website and Gateway)

`tests/fixtures/capabilities/` holds canonical JSON (2-space indent, trailing LF):

- `document.v1.json`: the v1 document with the logout rollout disabled.
- `legacy-client.json`, `current-client.json`, `stale-client.json`, `future-client.json`,
  `future-only-client.json`, `identity-client.json`, `delegation-client.json`,
  `malformed-client.json`: `{request, response: {status, body}}` exchanges.

`tests/capabilities.unit.test.ts` asserts the route reproduces every fixture byte for
byte, so consumers can pin them. Changing the document requires a new contract version
or a reviewed fixture update.

## Gates

With the C38 gate on (tests only) `delegation` becomes `{status: "disabled", supported: [],
defined: [1]}`; `supported` stays empty, so declaring `delegation=1` is still a 406. The
pinned fixtures describe the gate-off document and are unchanged.

Native App integration remains gated by B05. Identity, provider binding, delegation
and any V2 contract stay inactive until their own approvals; adding them here means
moving a version into `supported`, which is a reviewed change.
