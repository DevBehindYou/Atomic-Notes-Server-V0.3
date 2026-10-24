# Validator security migration

The server pins Zod 4.6.6 and Hono 4.13.11 to address the dependency audit findings without changing note limits, recovery policy, stored data, or accepted content projections.

## Security fixes and primary references

- [GHSA-mrhx-c7xc-m3w5](https://github.com/advisories/GHSA-mrhx-c7xc-m3w5): Zod versions below 4.6.6 process oversized constrained collections before rejecting their size. The regression exercises array and set limits and proves oversized input processes zero members.
- [GHSA-5r4p-p66f-jhc7](https://github.com/advisories/GHSA-5r4p-p66f-jhc7): Hono's static middleware double-decoding issue is fixed in 4.13.11. Upgrade the package even though this server does not serve static files with that middleware.
- [Zod migration guide](https://zod.dev/v4/changelog) and [GUID API](https://zod.dev/api#uuids): Zod 4 UUID validation enforces RFC variant/version bits; its GUID validator preserves the previous hexadecimal UUID-shaped identifiers.

## Compatibility contract

All production imports use patched Zod 4, never the vulnerable v3 compatibility entrypoint. Existing `z.string().uuid()` validators become `z.guid()` because stored identifiers and test/client wire identifiers already accept the generic hexadecimal 8-4-4-4-12 shape. Malformed identifiers remain rejected.

Zod 4 `int()` additionally rejects integers outside JavaScript's safe range. The migration uses `refine(Number.isInteger)` to preserve the previous integer acceptance on fields that were unbounded, including historical numeric metadata. Existing positive/nonnegative, minimum, maximum, and explicit `Number.MAX_SAFE_INTEGER` constraints remain in place. This is compatibility with the previous validator, not a new relaxation. Fractions and non-finite numbers remain rejected; values outside explicit safe counter bounds remain rejected.

Log metadata records declare string keys and arbitrary values explicitly. Existing object schemas still strip unknown keys. Optional importance, content hash, and update timestamp fields remain absent when omitted. Defaults remain unchanged, including checklist aliases, note versions, encryption defaults, wallet defaults, and recovery mode. No default is nested inside an optional wrapper in the current source. The tests assert exact JSON property order for note wire projections because recovery fingerprints depend on serialization.

The shared timestamp validator preserves the previous calendar checks, optional seconds and fractional seconds. Only fields that already accepted offsets continue accepting colon-separated or compact offsets; UTC-only fields remain UTC-only. It returns the original string unchanged so stored files and recovery fingerprints retain their timestamp representation.

## Verification

Use a fresh installation in an isolated checkout with its own normal `node_modules` directory. Never replace dependencies through a shared worktree junction.

```sh
npm ci --ignore-scripts --no-fund
npm run typecheck
npm test
npm audit --audit-level=high
npm run build
```

Run `test:integration`, `benchmark:admin-pages`, and `test:client-fixture` against an owned loopback disposable MongoDB replica set. The guarded fixture generates a unique `atomic_test_...` database, refuses preexisting collections, and drops only its own database. Use synthetic credentials and fake Drive adapters; never load a production environment file. CI repeats the complete verification on Node 22 with a disposable MongoDB 7 replica set.

## Release and rollback

This is an expand-only code/dependency change: no data rewrite, index migration, API version bump, or contract phase is needed. Existing clients and previously saved files remain readable while the upgraded server is deployed. Deploy the reviewed immutable server commit after required CI passes, then rebase dependent image-budget work onto it before pinning an app acceptance build.

A functional rollback reverts this source and lockfile commit and reinstalls the old lockfile in a separate checkout; it requires no data conversion. The prior dependencies remain affected by these advisories, so rollback is an emergency recovery option rather than an acceptable steady state. Keep the existing database and saved files intact, and restore the patched version promptly.
