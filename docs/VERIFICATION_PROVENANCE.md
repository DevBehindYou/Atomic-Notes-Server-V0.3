# CI verification provenance and artifact secret scan (C46)

`Server verification` (`.github/workflows/typecheck.yml`) records exactly
what each run verified, and refuses to upload artifacts that contain a secret.

## What already existed

These were verified, not changed:

- Dependencies are installed with `npm ci` from `package-lock.json`, with Node
  22 pinned in the workflow and in `engines`.
- `npm audit --audit-level=high` runs on every push and pull request.
- `npm run check:deployment` builds and checks the isolated deployment
  entrypoints.
- A missing or malformed secret fails safely. `getEnvIssues` names only the
  variable and the problem, never the value. `assertProductionEnvironment`
  stops a production cold start with those names. Both are covered by
  `tests/unit.test.ts` and `tests/credentialEnvelope.unit.test.ts`.
- Test artifacts are small, bounded `ci-*-proof.json` files.

## Added

`src/lib/verificationProvenance.ts`, which is pure, and
`src/scripts/recordVerification.ts`. The script runs after the tests and
before any upload. It writes `ci-server-verification-proof.json`.

### What the report records

- `sourceHead`: the PR head or pushed commit. It must be a full 40-character
  SHA.
- `lockSha256`: the SHA-256 of `package-lock.json`.
- `runtime`: the Node and npm versions.
- `steps`: the outcome of each verification step (install, typecheck, audit,
  deployment, unit, integration, client fixture).
- `artifacts`: how many `ci-*.json` files were scanned, and each finding as a
  file name and a kind. Never the value and never its position.
- `canaryDetected`: whether the positive control below worked.

### The scan

- **Exact values.** It looks for the exact value of every environment variable
  whose name ends in `KEY`, `SECRET`, `TOKEN`, `PASSWORD` or `CANARY`, and of
  every URI that carries credentials. Values shorter than 8 characters are
  skipped.
- **Credential shapes.** It also looks for these shapes: PEM private keys,
  Google access tokens, refresh tokens, client secrets and API keys, JWTs, and
  credentialed URIs.
- **Positive control.** A fresh random canary (`ATOMIC_CI_CANARY`, 48 hex
  characters) is created each run. The scanner must detect it in a synthetic
  sample before its results are trusted.
- **Oversized files.** A file over 8 MiB cannot be scanned, and is reported as
  a finding.

### Upload gate

- Every artifact upload runs only when the scan step succeeded.
- The scan step fails only when uploads would be unsafe: a finding, the canary
  not detected, or no valid source head.
- Failed tests are recorded in the report and still fail the job through their
  own steps. Their sanitized proofs still upload.
- The provenance report itself is uploaded as
  `sanitized-server-verification-proof`.

## Not in scope

- No signed release and no deployment dispatch.
- No changes to Vercel or to secrets.
- App and Web repositories are handled separately. The App already records
  its source head, lockfile and APK digests in
  `tool/record_flutter_verification.py`.
- Codex's reserved Android and acceptance workflows are not touched.
