# Synced note importance

`important?: boolean` is optional on sync rows, `.atomic` files, Mongo metadata,
and inactive recovery target flags. A missing field means false on old records.
The canonical sync and logout projection places an explicitly supplied field
after `pinned` and before `deleted`; parsing never supplies a default.

An old client omitting the field preserves the current stored value on an
existing note. Explicit `false` clears it. Push resolves omission against the
metadata preimage before content hashing and writing Drive/Mongo. Inactive
classified recovery resolves against the preimage for admission and the frozen
intent for pending replay. Original request rows remain the operation identity.

The content hash keeps the historical seven-element array for absent/false and
appends `true` only when important. Existing false hashes, missing-field sync
fingerprints, and frozen logout fingerprints retain their original bytes.
Pull and recovery staging/commit compare the semantic flag across metadata,
manifest, and Drive content, including legacy rows without a content hash.

Single-note create/patch endpoints remain closed; direct delete retains the
flag, and metadata reads expose stored optional values. No recovery route,
logout gate, index, schema migration, or production data write is activated.
Deploy Server support before releasing an App that writes the new flag.

Verification uses generated disposable local replica-set databases and a fake
Drive adapter, with no `.env` or external credentials. The required client
fixture suite includes `noteImportance.test.ts` and
`noteImportanceRecovery.fixture.test.ts`: legacy projection/hash compatibility,
plaintext and encrypted writes, omitted old-client updates, unchanged/stale
classification, explicit clearing, replay, tombstones with missing files,
metadata/Drive mismatch refusal, and immutable recovery generation replay.
