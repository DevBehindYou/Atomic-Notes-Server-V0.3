# Credential envelopes (C26)

Google access and refresh tokens are stored encrypted in
`googleAccounts.encryptedAccessToken` / `encryptedRefreshToken`. The helpers are in
`src/lib/crypto.ts`. Tests are in `tests/credentialEnvelope.unit.test.ts`, which is part of `npm test`.

## Formats

| Format | Layout | Key selection |
| --- | --- | --- |
| legacy (pre-C26, still the default writer) | `b64(iv 12 B).b64(tag 16 B).b64(ciphertext)`, standard base64, `.`-separated | None recorded. The reader tries the current key, then each previous key. |
| v1 (opt-in) | `ce1:<keyId 11 chars>:b64url(iv 12 B):b64url(tag 16 B):b64url(ciphertext)` | `keyId` = first 8 bytes of HMAC-SHA256(key, `atomic-notes/credential-envelope/key-id/v1`), base64url |

Both formats use AES-256-GCM with a random 96-bit IV. v1 also authenticates the
`ce1:<keyId>` header as AAD. Neither base64 alphabet contains `:`, so the two formats
cannot be confused. A `ce<n>:` prefix with any other `n` is reported as `unknown_version`.

The reader requires a 12-byte IV and a 16-byte tag in both formats. The original
reader also accepted GCM tags truncated to as few as 4 bytes (Node DEP0182). The
original writer never produced them.

## Failures

Every refusal is a `CredentialEnvelopeError` with a `code`. The codes are `key_config`,
`malformed`, `unknown_version`, `unknown_key_id` and `authentication_failed`. A tampered
envelope and a wrong key look the same in GCM, so both report `authentication_failed`.
The message is a fixed string. A `key_config` message names only the variable. The
OpenSSL cause is not chained. The error has no `status`, so routes still answer
`500 internal_error`, and the log gets only the stack line.

## Configuration

| Variable | Meaning |
| --- | --- |
| `TOKEN_ENCRYPTION_KEY` | Unchanged and required. This is the current key, used for writing and reading. |
| `TOKEN_ENCRYPTION_PREVIOUS_KEYS` | Optional. Up to 3 comma-separated base64 32-byte keys. They are only used for reading. |
| `TOKEN_ENCRYPTION_WRITE_FORMAT` | Optional. Unset or `legacy` writes the existing format. `v1` opts in to the new format. Any other value refuses writes but still allows reads. |

`getEnvIssues` reports invalid values for the two optional variables by name only. An
existing single-key deployment needs no change.

## Rollout and rotation (not performed by this change)

1. Deploy with the writer off. The output format is unchanged.
2. After review, set `TOKEN_ENCRYPTION_WRITE_FORMAT=v1`. This is a one-way door for
   rollback: a Server older than C26 cannot read v1, and its users would have to sign in
   again. Roll back only to a revision that contains this reader, or set the writer back
   to `legacy` and wait for tokens to be rewritten first.
3. To rotate, move the old key into `TOKEN_ENCRYPTION_PREVIOUS_KEYS` and put a new key in
   `TOKEN_ENCRYPTION_KEY`. Writes then use the new key, and both formats under both keys
   still read. Access tokens are rewritten on refresh. Refresh tokens are rewritten only
   at sign-in.
4. Remove a previous key only after an inventory shows no envelope that still needs it
   (`describeCredentialEnvelope` gives the format and key ID without decrypting). A legacy
   envelope records no key ID, so the inventory has to trial-decrypt it. No inventory or
   re-encryption script exists yet. If the key is retired too early, only the envelopes it
   wrote fail, and those users have to sign in again.

## Limits

- No AAD binds an envelope to its user or field. As before, a database writer could swap
  envelopes between documents.
- Key IDs are derived, so they cannot be chosen. A KMS-backed key would need a new version.
- No real key was generated, rotated or deployed. All keys in the tests are fixture bytes.
