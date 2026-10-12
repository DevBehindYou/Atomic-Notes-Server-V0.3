# Fixed 180-day App sign-in lifetime

User-approved policy, 12 October 2026: new App sessions remain valid for a fixed
180 days from sign-in even if the app is unused or offline. This means 180 times
24 hours, rather than six variable-length calendar months. Activity does not
renew or shorten the deadline. Explicit logout/revocation and the existing
newest-five-session cap can still end a session sooner.

## Implementation and compatibility

`src/lib/session.ts` creates the existing 32-byte opaque token, stores only its
SHA-256 hash, and sets `expiresAt = createdAt + 180 days`. Auth still checks the
stored expiration on every authenticated Server request, independent of MongoDB
TTL cleanup. At the exact expiration instant the token is invalid. The optional
time arguments on issuance/verification allow deterministic fixtures; production
callers continue using server wall time. Verification performs no mutation.

Both Google sign-in paths already share `completeGoogleLogin`, which calls
`createSession`; the returned `{token, user: {id, email}}` wire shape is unchanged.
The auth middleware's missing-token/invalid-token 401 responses, ordinary logout,
special logout synchronization/recovery flows, hashed-token ownership, and
newest-five cap remain in place. No Controller cookie/session lifetime changes.
Google's access/refresh token lifetime is separate from this App bearer token;
this change cannot prevent revoked Google Drive authorization from requiring
re-authorization.

Previously issued sessions retain their stored expiry, including old seven-day
tokens. Signing in again issues a new 180-day session. No retrospective token
renewal, production database write, index migration, environment setting, or
deployment is included. The existing `expiresAt` TTL index needs no alteration.

Offline access and unsynced-note preservation are App responsibilities. This
Server code neither runs while a phone is offline nor deletes local notes when
a session expires. The separate App restoration audit must verify its own
offline behavior; these Server fixtures do not claim native UI/phone proof.

## Disposable verification

`tests/sessionLifetime.fixture.test.ts` uses the guarded localhost HTTP fixture
and generated empty MongoDB namespace. No real Google login or Drive call occurs.
It checks:

- Token shape and hashed-only stored fields; a fixed 180-day persisted deadline.
- No requests until synthetic day 179, then successful validation; repeated
  reads at selected days leave the complete session document unchanged.
- Acceptance one millisecond before expiry and rejection at/after expiry.
- A generated legacy seven-day document retains its deadline and expires then.
- Six strictly ordered issued sessions keep exactly the newest five; other users
  remain authenticated. Same-millisecond ties and concurrent issuance are not
  claimed as solved by this change.
- Real HTTP auth/logout revoke only the newly issued session; the other
  same-owner session works. Notes/wallet/ledger/fake Drive diagnostics remain
  unchanged. Fixture cleanup completes before a passing proof is emitted.

The fixed-schema artifact is `sanitized-session-lifetime-proof` containing
`ci-session-lifetime-proof.json`. All nine named cases, complete phase, and pass
outcome are required alongside the existing 33 proof schemas and normal CI
checks. The prior real-session fixture now expects 180 days, preserving its
logout/expiry/cap coverage. CI is the execution authority; no local dependencies,
database, build, device, or production actions are used for this change.
