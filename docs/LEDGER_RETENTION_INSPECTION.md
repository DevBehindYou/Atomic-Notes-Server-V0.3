# Read-only history retention inspection

`npm run db:inspect-ledger-history` reports account/row counts, accounts over 50 entries, potentially removable rows, largest history, orphan history, and archived/recent statistics counts. It prints no account IDs, notes, balances, database names, connection information or driver errors. All arguments are rejected before importing the database runtime; there is no apply mode.

Data counts share a snapshot. Index/catalog readiness is a later separate read. Missing collections remain missing. An exact full ordering index is reported as a prerequisite, not created. Orphan rows are reported for review, not silently discarded. The report always says activationReady=false because rollout readiness cannot be established by database counts alone.

This report is a rehearsal/preflight building block. Snapshot aggregates may scan a large ledger; no production query has been run and no performance promise is made. RemovableRows is a snapshot estimate including orphan partitions; it is not authorization to delete that count. The next step is a bounded, resumable migration rehearsal, then index/performance and cutoff tests, writer-overlap prevention, verified backup/restore and an approved production preflight.
