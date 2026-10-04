# Disposable-only restartable migration rehearsal

The test harness is under tests/, excluded from the deployed build. It rejects any database except an exact generated atomic_test_<20 hex> name, processes at most five explicitly supplied fixture accounts and ten bounded batches per call, and binds its checkpoint to the fixed account list, reference time and 50-entry limit.

Each checkpoint advance commits in the same transaction as statistics preservation and history deletion. A lost response after commit must resume from stored progress, rather than re-counting removed rows. Parallel workers contend on the checkpoint and account wallet; Mongo retries the complete transaction. Changing the plan after a run begins is rejected. Repeating a completed run is a no-op.

Fixture: 355 and 151 rows, interruption after the first committed batch, changed-plan refusal, parallel restart, 406 total deletions leaving 50 per account, exact preserved totals/balances and untouched third-account history. This is rehearsal in a disposable database, not an approved production migration.

Pending production design: paginated account enumeration, orphan/invalid-row handling, verified backup/restore, indexes and performance, old-writer exclusion, sequence/automatic writer integration, coherent global statistics and a reviewable operator preflight. The harness is not exposed as an apply command.
