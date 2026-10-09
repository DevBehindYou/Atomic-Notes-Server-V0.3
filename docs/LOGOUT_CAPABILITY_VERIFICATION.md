# Logout availability preflight

Authenticated GET `/api/notes/logout-capability` returns `{available: boolean}`
from the same deployment gate as logout admission. It does not create attempts,
charge/grant Energy, access note content or write Drive files. The App can avoid
persisting a new frozen attempt against a rollout that is still disabled.

This is advisory: a deployment can change after the read, so admission still
checks the gate and an already-saved attempt must not be silently discarded.
An older Server without this endpoint must be treated as unavailable by the App.

The disposable HTTP fixture verifies enabled/disabled responses, unauthenticated
refusal, unchanged wallet/ledger/Drive state and no created attempt. All existing
logout upload/replay/conflict/partial/completion cases run afterward. Local
typecheck/pure tests and the full CI with 21 fixed proofs gate merging. No App
caller, production configuration, rollout activation or migration is included.
