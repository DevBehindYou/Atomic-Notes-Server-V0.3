# C28 identity and library migration dry run

This is a read-only planner. It shows what a future identity/library backfill would create from the current `users` and `google_accounts` rows, and which rows would block it. **It applies nothing.** There is no apply, backfill, index or provider-activation mode. No production database was read for this task.

## Contract v1 (`src/lib/identityContract.ts`)

### Identity record

The identity record has these fields: `{ contractVersion: 1, kind: 'external_identity', accountId, provider: 'google', issuer, subject }`.

| Field | Rule |
| --- | --- |
| `accountId` | The existing `users._id` UUID, kept byte for byte and never re-minted. It is the wallet owner, the note owner and the vault KDF input. |
| `issuer` | `accounts.google.com` and `https://accounts.google.com` are both accepted, case-insensitively, with at most one trailing slash. Both normalize to `https://accounts.google.com`. Everything else is rejected: `http`, other hosts, ports, paths, queries, userinfo and whitespace. |
| `subject` | The exact stored Google `sub`: 1–255 printable ASCII characters, compared case-sensitively and never trimmed. A subject containing `@` is rejected as `subject_email_shaped`, because email is never identity. |

`identityKey` encodes `(version, provider, issuer, subject)` as an unambiguous JSON tuple.

### Library record

The library record has these fields: `{ contractVersion: 1, kind: 'library', accountId, provider: 'google_drive', owner: { provider, issuer, subject }, locator: { folderId } }`.

- `folderId` comes from `google_accounts.driveRootFolderId`. It must be 1–256 characters from `[A-Za-z0-9_-]`.
- Library IDs are not part of v1. They are opaque server-generated UUIDs, and only an approved apply step may mint them.

### Parsing rules

- The version is checked first, so an unknown version is never partially interpreted.
- Unknown fields and missing fields are rejected, including in nested objects.
- Only Google is recognized. `dropbox` and any other provider is rejected as `unsupported_provider`.
- The parser returns new objects and never modifies its input.

### Old-reader compatibility

`checkOldReaderCompatibility` parses a stored document with the current `userSchema` or `googleAccountSchema`, both with and without the proposed additive field (`identityContractVersion`). Both parses must give the same acceptance and the same value.

The fixture test runs this check over documents written by the real sign-in path. The planner writes nothing, so current readers are unaffected.

## Planner (`src/db/identityMigrationPlan.ts`, runner `identityMigrationPlanRunner.ts`)

The planner reads projected fields only. It never requests the encrypted tokens.

| Collection | Fields read |
| --- | --- |
| `users` | `_id`, `email`, `displayName`, `createdAt`, `updatedAt` |
| `google_accounts` | `_id`, `userId`, `googleAccountId`, `driveRootFolderId`, `createdAt` |

Both collections are read in one snapshot session. Each population is capped at 200,000 rows; a larger population makes the run fail rather than produce a partial plan. Sessions are not read.

### Blocking problems

A blocking problem stops the identity mapping, the library mapping, or both.

| Problem | Meaning |
| --- | --- |
| `user_id_not_uuid` | The user's `_id` is not a UUID. |
| `no_google_account` | The user has no Google account row. |
| `multiple_google_accounts` | More than one Google account row points to the user. The `userId` index is not unique, so this is possible. |
| `subject_invalid` | The stored subject fails the contract rules. |
| `subject_email_shaped` | The stored subject contains `@`. |
| `subject_duplicate` | The same subject appears on more than one row. Subjects are compared exactly, and the check runs even if the unique index is missing. |
| `folder_missing` | The account has no `driveRootFolderId`. This is the real "Drive setup failed" state. The identity is still planned; only the library waits. |
| `folder_invalid` | The folder ID fails the contract rules. |
| `folder_shared` | Two users point to the same folder ID. |

### Advisory problems

In the target model, email is contact metadata only, so these problems never block a mapping keyed by subject.

| Problem | Meaning |
| --- | --- |
| `email_missing` | The user has no email. |
| `email_malformed` | The email is not a valid address. |
| `email_not_normalized` | The stored email is not lowercase and trimmed. |
| `email_duplicate` | Another user has the same email after case-insensitive comparison. |
| `legacy_reader_rejects_user` | The current `userSchema` would reject this user document. |

### Counts reported for the whole snapshot

- **Orphan Google accounts:** accounts whose user is missing, and accounts whose user ID is invalid.
- **Collision groups:** groups that share an email, a subject or a folder.
- **Index catalog:** whether `email` is unique, and whether that uniqueness is case-insensitive (it is exact-case in production); whether `googleAccountId` is unique; whether `userId` is unique.

### Determinism and resume

- **Ordering.** Users are processed in a fixed order: by type, then by the code units of `_id`. Input order does not matter.
- **Hashing.** Each entry is hashed. The hashes are chained, starting from a digest of every projected field.
- **Windows.** A window of `--limit` users ends with a checkpoint: `c28.1.<processed>.<lastUserRef>.<chain>.<inputDigest>`.
- **Resuming.** A resumed run recomputes the prefix. It refuses if any of these differ:
  - the input digest (`identity_plan_checkpoint_stale`);
  - the position, the user reference or the chain value (`identity_plan_checkpoint_mismatch`).
- **Result.** Chained windows reproduce the entries, the per-class totals and the final plan digest of an uninterrupted run exactly.

### Report contents

The report contains:

- counts;
- 16-hex domain-separated user references, with at most 5 samples per class;
- 20-hex digests;
- the checkpoint.

The report contains no IDs, emails, subjects, folder IDs, tokens or connection strings. The C25 sanitizer enforces this.

## Running it

```
IDENTITY_PLAN_MONGODB_URI=... npm run db:plan-identity -- --read-only --database <name> [--limit <1-100000>] [--resume <checkpoint>]
```

The script takes its connection string only from `IDENTITY_PLAN_MONGODB_URI`. It never reads `MONGODB_URI` or `.env`.

- Every command it sends is checked against the C25 read allowlist and the selected database. Any other command fails the run.
- Driver errors are never printed.

| Exit code | Meaning |
| --- | --- |
| 0 | Nothing blocking was found. |
| 2 | Blocking findings were counted: blocked users, orphan accounts or subject collisions. |
| 1 | The run failed. |

## Evidence

- `tests/identityContract.unit.test.ts`: 9 tests.
- `tests/identityMigrationPlan.unit.test.ts`: 7 tests. These cover classification, determinism under reordering, resume equivalence at 7 window sizes, refusal of stale or tampered checkpoints, sanitization and argument guards.
- `tests/identityMigrationPlan.fixture.test.ts` runs against disposable local Mongo, in CI only:
  - users are created by `completeGoogleLogin`;
  - problem rows are inserted by hand;
  - it checks exact counts, two identical runs, four resumed windows chaining to the one-shot digest, an unchanged `dbHash`, the read-only command set, and a checkpoint refused after a later write.

## Findings and decisions for review

1. **Same email, new subject cannot sign in today.** `completeGoogleLogin` upserts a new user with the lowercased email, and the exact-case unique `email` index rejects it with E11000, which login answers as `account_email_conflict`. The fixture characterizes this: the transaction rolls back and leaves no partial rows. The same failure happens when a returning subject's new email belongs to another user. Removing email uniqueness is step M3 and needs separate approval.
2. **Case variants can coexist.** Because the email index is exact-case, emails that differ only in case can coexist when they were written by older code or by hand. These are reported as `email_duplicate` and `email_not_normalized`.
3. **Library ID minting, the persistent identity storage form and any index changes are outside C28.** The identity storage form is either the exact subject or a keyed HMAC with a rotation plan. These belong to C29 or an approved apply step.
4. **Resume recomputes the prefix.** This costs O(N) per window. That is acceptable for a dry run at the current scale. Orphan accounts are not included in folder-sharing groups.
