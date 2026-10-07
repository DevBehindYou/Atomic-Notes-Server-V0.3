# Characterize Drive overwrite followed by Mongo metadata failure

Test-only characterization from verified Server main
`ac559d92bd4039408e8e8217a5876608b004d980`. No production source, schema,
index, recovery journal, economy or repair behavior is implemented here.

Inside one guarded, generated disposable database, the test commits an initial
note, then installs a Mongo validator that refuses updates to only that note.
An actual HTTP push successfully overwrites the fake Drive file before the real
metadata transaction fails. Assertions require a failed/refunded receipt, old
metadata and sequence, a changed Drive-write counter, and a 409 mismatch pull
without rows or a cursor. Exact failed-request replay must change nothing.

Removing the disposable validator does not reconstruct the old Drive content.
Resending the unchanged canonical old body takes the existing hash fast path:
the push acknowledges version one, charges ten, performs no Drive write and
the next pull still refuses the mismatch. A fresh request containing the retained
dirty newer body can rewrite/commit version two; subsequent pull succeeds.
These are existing behaviors being characterized, not desired repair guarantees.

The validator acts only after generated-database identity verification and is
never installed locally or in production. The owned database is dropped by the
existing guarded cleanup. No simulated pull fault, fabricated metadata version
or direct wallet rewrite is used. The fixed-code artifact exposes phase/outcome
only, never note IDs/content, exceptions or private values.

Local type checking and 63 pure controls must pass. Actual Mongo execution is
CI-only. A green characterization proves this failure boundary against fake
Drive and real Mongo; it does not prove real Drive outages, abrupt process death,
lease races, permanent loss across every client, or a recovery implementation.
R11/R16 remain partial. Immutable generations and a metadata-only journal are
proposed separately and still need concrete schema/identity/retention review.
