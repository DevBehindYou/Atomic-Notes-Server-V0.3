# Isolate the encrypted-payload wire fixture

Test-only extension from verified main `bd37028fe6026da1ad4c1f0466fd4826cafa56cb`.
The guarded loopback assembly adds one synthetic owner and public test session
with the existing thirty-note free tier and a seeded 100-energy budget. Its state
cannot depend on earlier plaintext, conflict, wipe or refund scenarios. No
production route, dependency, schema, index, capacity or economy policy changes.

A real HTTP/Mongo test uploads a synthetically AES-GCM sealed payload through
the actual notes route. It checks the ten-energy receipt, metadata without title,
body, items or payload fields, and an unchanged opaque payload on pull. The
current `encOnly=true` behavior excludes encrypted rows while advancing the
cursor; a pull from zero receives the ciphertext with empty visible fields.
This labels that existing parameter behavior explicitly rather than guessing
from its name. The Server does not decrypt or authenticate the plaintext.

The matching App follow-up will test real AES-GCM/base64 expansion in its byte
batcher and independent logical-client decryption. This Server case alone does
not prove App batching, Argon2/recovery phrase, verifier lifecycle, native
keystore, Google/Drive, two physical devices or cross-store recovery. A fixed
phase/outcome artifact contains no IDs, bodies, ciphertext, tokens or key values.
Local type checking and 63 pure controls remain required; actual disposable
database execution and cleanup occur only in CI. R25 remains partial.
