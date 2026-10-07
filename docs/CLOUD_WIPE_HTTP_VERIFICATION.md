# Cloud-wipe HTTP and metadata verification

Fixture-only follow-up from verified Server main
`b6b113cf49594a8bcc748e1cc1921221e8097778`. Production routes, schemas,
dependencies, policies and credentials are unchanged.

The new disposable HTTP/Mongo case creates two owner notes and one other-account
note. An unauthenticated wipe is refused. The real authenticated wipe removes
the owner's fake Drive files and all owner metadata, with no tombstones. The
sequence counter is retained; both a fresh cursor and the earlier valid cursor
return an empty page with that same sequence. Other-account metadata and content
are untouched. Wallet and financial history are unchanged by the wipe.

A replay of the pre-wipe completed request still returns its historical receipt,
without recreating files or metadata or charging again. This is deliberate
characterization: an old replay is not a cloud-refill command. A repeated wipe
returns zero deleted and changes neither billing nor fake-file counters.

Local type checking and 59 pure tests must pass. Actual HTTP/Mongo execution is
CI-only in the guarded generated namespace. The fixture does not prove native
local-note retention, real Drive trash behavior, concurrent wipe/push safety,
vault-verifier retention or durable recovery. The matching real App case is a
separate follow-up. Exact-head and destination-main checks are required.
