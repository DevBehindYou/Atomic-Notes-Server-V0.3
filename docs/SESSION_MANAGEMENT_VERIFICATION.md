# Manual App session management

Original R28 Level 2 follow-up, 12 October 2026. This adds an authenticated list
and selected-other-session revocation. App sessions still expire at their fixed
stored deadline: new sign-ins receive 180 days, with no inactivity expiry or
renewal. Controller sessions, Google token lifetimes and legacy App session
deadlines are unchanged.

## Wire contract

`GET /api/auth/sessions`, with the existing Bearer authentication, returns:

```json
{
  "sessions": [{
    "session_handle": "opaque 43-character base64url digest",
    "created_at": "ISO timestamp",
    "expires_at": "ISO timestamp",
    "is_current": true,
    "agent_label": null
  }],
  "limit": 5
}
```

`POST /api/auth/sessions/revoke` accepts only `{session_handle: string}` and
returns `{ok: true}`. The new mutation body has a 1 KiB limit and strict field
validation. Successful responses use `Cache-Control: no-store`. No bulk revoke
feature is added. The current handle is refused; current-device logout must
continue through the App's existing Safe Logout orchestration.

The handle is a domain-separated SHA-256 digest of
`atomic-notes/session-management/handle/v1\0 + ownerUserId + \0 + storedTokenHash`,
encoded base64url. It is not an authentication credential. Neither raw tokens,
stored token hashes, owner IDs nor logout internals appear in the DTO.
`agent_label` is an untrusted optional User-Agent display hint, never verified
device identity or last activity. Control/format characters and line separators
are removed; at most 80 Unicode codepoints are returned, or null when empty.

## Bounds and refusal behavior

Both operations select only the authenticated owner's nonrevoked, unexpired
rows. Sorting is creation time descending, then stored ID descending for ties;
the query returns at most six rows, with a fixed 2-second Mongo query deadline.
Five rows are the existing account cap; a sixth produces a refusal instead of
silently hiding or automatically deleting legacy surplus sessions. No inventory
count, pagination, cleanup, index, new field or environment variable is added.
The row limit bounds response/application memory; it does not guarantee six
database rows scanned or any production throughput. The existing owner/creation
index and query deadline constrain scans without claiming a new compound index.

| Condition | Response |
|---|---|
| Missing/invalid/expired/revoked current authentication | Existing 401 missing_token/invalid_token |
| More than five active owner rows | 409 session_inventory_overflow |
| Invalid projected session data | 409 session_inventory_invalid |
| Current row disappeared from inventory or target changed during guarded mutation | 409 session_inventory_changed |
| Mongo query deadline code 50 | 409 session_inventory_unavailable |
| Selected handle is current | 409 current_session_requires_safe_logout |
| Either relevant session has a bound Safe Logout attempt | 409 session_logout_active |
| Current auth-fence revision exhausted | 409 session_revision_exhausted |
| Unknown/foreign/already-revoked/expired selected handle | 200, identical ok response, no mutation |
| Invalid/extra fields or invalid JSON | Existing 400 validation/JSON behavior |
| Oversized new mutation body | 413 request_too_large |

Normal unexpected database failures retain the existing generic error response.
No raw database diagnostic is added to the public contract. A persisted bound
logout attempt can continue blocking management until it is resolved; this is
not an unconditional security-revocation bypass.

## Concurrency and data safety

The list is read-only and rechecks current authentication immediately before
returning its DTO. A response already in flight can finish after a later
revocation; the feature does not promise network-response cancellation.

Selected-other revocation uses the existing Mongo transaction wrapper. It
revalidates current owner/auth and the bounded inventory, then increments the
existing current-session `logoutAttemptRevision` with exact prior revision,
live-auth and absent-attempt predicates. The same transaction revokes only the
selected owner's live target with an absent-attempt predicate. This real write
fence conflicts with concurrent current revocation, avoiding read-only snapshot
authorization of a later target write. The existing driver transaction retry
rechecks all guards. Failed transactions roll back both writes.

If the target is already retired/unknown, no session mutation occurs; a final
live-auth check also retires no-op requests whose caller was revoked meanwhile.
No note, wallet, ledger, Drive, sync operation or logout-attempt mutation occurs.
No token deadline is touched. Other-session requests already authenticated
before remote revocation may still finish; future requests are denied. The
App must preserve that device's unsynced local work on the later 401. This API
cannot synchronize another offline device or prove its UI behavior.

## Disposable verification

`tests/sessionManagement.fixture.test.ts` runs against the existing guarded
localhost HTTP/fake Drive assembly and generated Mongo namespace. The fixture
disables its own TTL cleanup only to keep expired test documents stable; no
production index change is made. All 21 fixed cases cover:

- Whitelisted list, opaque handles, stable tie order, five-row cap, six-row
  overflow, exclusion of retired rows and sanitized 80-codepoint agent labels.
- Real HTTP auth, validation, body limits, selected-other revocation and current
  refusal; foreign/unknown/repeated/expired handles share the no-op response.
- Bound Safe Logout refusal, invalid inventory and revision exhaustion.
- Barrier-controlled helper reads/no-op responses retired by late auth changes;
  real Mongo current-revocation and target-attempt/revocation races across the
  transactional fence; rollback after both tentative writes.
- Full generated non-session collection snapshots stay unchanged, and owned
  fixture cleanup completes before a passing proof is emitted.

The query-timeout case is a fixed error-code classification control, not an
actual timed-out Mongo query or performance measurement. Races run through the
production helper and real Mongo transactions using internal test hooks; basic
contracts run through real HTTP routes. They do not prove native two-device UI,
real Google login/Drive, production latency, or cancellation of in-flight work.

The named fixed-schema artifact is `sanitized-session-management-proof`, file
`ci-session-management-proof.json`: version 1, the recorded scope, complete
phase, pass outcome, and all 21 named cases passing. All existing 34 proof schemas
and typecheck/audit/build/unit/integration checks remain required. CI execution
and exact-head/destination-main verification are merge gates. No local build,
dependency installation, production write, deployment, migration or device action
is included.
