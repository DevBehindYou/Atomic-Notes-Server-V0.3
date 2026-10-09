# Explicit disposable logout fixture — 10 October 2026

The loopback client fixture accepts exactly one optional CLI argument,
`--logout-sync`. With no argument, logout is disabled. The fixture assembly
always supplies an explicit boolean to the real notes routes, preventing an
inherited production feature flag from changing a regression run. Production
route defaults and deployments are unchanged.

Five pure assertions exercise enabled/default behavior and reject malformed,
duplicated and unknown arguments. Existing disposable HTTP tests exercise
enabled/disabled logout routes against generated Mongo databases and fake Drive.
The CLI retains its database guard, loopback listener, owned namespace cleanup
and fixed error messages; it does not load an environment file.

This prepares App/Hive-to-HTTP acceptance runs. It does not itself prove App
logout delivery, native keystore teardown, a signed upgrade, real Google Drive
or recovery of an expired session's saved logout. Those remain separate gates.
