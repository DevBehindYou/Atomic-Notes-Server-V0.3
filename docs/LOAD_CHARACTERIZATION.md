# Load and resource characterization (C48)

A synthetic harness that drives the App Server's real sync routes under load and records latency,
throughput, memory, logical call counts and bytes. It runs only against local disposable services.

## What it is not

- Not a production capacity claim. Nothing here measures Vercel, MongoDB Atlas, Google Drive or a
  real network. The numbers describe one CI runner (or one developer machine) running three local
  processes and a local MongoDB container.
- Not a test of Google's behavior. The Drive stand-in answers instantly (or after an injected delay)
  and its 429/503 faults are synthetic. Real Drive latency, quotas and error mixes are different.
- Not a cold-start or serverless measurement. The App Server is one long-lived Node process with a
  warm MongoDB pool; Vercel instances start, scale and share nothing like that.
- No wallet, Energy or billing behavior is changed. Synthetic accounts in the disposable database are
  seeded with enough Energy that charging never limits the load.

## How to run

```sh
# A disposable local replica set (CI starts one with Docker):
docker run -d --name atomic-test-mongo -p 127.0.0.1:27017:27017 mongo:7.0 --replSet rs0 --bind_ip_all
docker exec atomic-test-mongo mongosh --quiet --eval 'rs.initiate({_id:"rs0",members:[{_id:0,host:"127.0.0.1:27017"}]})'

MONGODB_URI='mongodb://127.0.0.1:27017/?replicaSet=rs0&directConnection=true' npm run bench:load -- --smoke
MONGODB_URI='mongodb://127.0.0.1:27017/?replicaSet=rs0&directConnection=true' npm run bench:load -- --full
```

The report is written to `ci-load-characterization.json` in the working directory.

In CI (`.github/workflows/typecheck.yml`) the smoke variant runs on every push and pull request, after
the client fixture step, against the job's disposable MongoDB. The full variant runs only on manual
`workflow_dispatch` (Actions, "Server verification", Run workflow), which also raises the job timeout.
The report is uploaded as the `sanitized-load-characterization` artifact only after the C46
provenance and secret scan passes. No deployment workflow is involved.

## Safety guards

- `MONGODB_URI` must name one loopback host (`127.0.0.1`, `localhost` or `::1`) with a port, no
  credentials, no database path and only `replicaSet`/`directConnection` options. `mongodb+srv`,
  Atlas and other remote hosts, seed lists and a preset `MONGODB_DB_NAME` are refused before any
  helper process starts. The App Server process re-checks, generates a fresh `atomic_test_…`
  database, refuses one that already has collections, and drops only that database on exit.
- The Google origin must be `http://` on a loopback address with a port; real Google hosts are refused.
- In all three processes every TCP connection is refused unless it goes to a loopback address
  (`installLoopbackOnlyNetwork`), so a missed override cannot reach Google or Atlas.
- Google tokens are seeded far from expiry, so the route never asks for a refresh.
- The report must contain only numbers and snake_case codes (`assertNumbersAndCodesOnly`): no tokens,
  ids, note text or error messages. It is also scanned by C46 before upload.

## Processes

| Process | File | Measures |
| --- | --- | --- |
| Load client | `tests/loadCharacterize.ts` | client-side latency, payload bytes, errors, Server-Timing Drive call counts |
| App Server | `tests/loadCharacterizeApp.ts` | RSS and heap (sampled every 20 ms), MongoDB commands started, HTTP transport bytes |
| Drive stand-in | `tests/loadCharacterizeDrive.ts` | upstream requests (including retries), faulted answers, in-flight high-water mark, transport bytes |

The App Server process mounts the real `createNotesRoute` (auth, per-user operation lock, push,
pull, retries, timeouts) behind the same 4 MiB body limit and error handler as `src/app.ts`, with the
production `driveSession` pointed at the stand-in. It is the C24 fixture shape, in its own process so
its memory is measured alone. Client, App Server and stand-in still share the runner's CPUs.

## Workloads

32 synthetic accounts, each with ten notes seeded by one ten-row push (the first-sync shape):
three small plaintext notes, one each of medium plaintext, plaintext with three 60 000-byte JPEGs
(the image budget), plaintext just under the 400 000-byte wire limit, and the encrypted (`enc_v` 1,
App-compatible AES-GCM) equivalents of small, medium, three images and near-limit payload. The exact
wire size of each envelope is in `envelope_wire_bytes`. Every push changes content (a counter in the
title, or a fresh nonce), so no push takes the unchanged shortcut. Worker *i* acts only as account *i*,
because writes are serialized per account.

| Scenario | Operation | Concurrency | Provider |
| --- | --- | --- | --- |
| `pull_mix_c{1,4,16,32}` | full ten-note pull page | 1, 4, 16, 32 | instant |
| `push_mix_c{1,4,16,32}` | one-row push, cycling through the ten notes | 1, 4, 16, 32 | instant |
| `push_<envelope>_c4` | one-row push of one envelope kind | 4 | instant |
| `push_mix_c16_latency{100,500}` | one-row push | 16 | 100 / 500 ms per answer |
| `pull_mix_c16_latency100` | pull page | 16 | 100 ms per answer |
| `push_mix_c16_burst429` | one-row push | 16 | 429 for 1 s (inside the retry budget) |
| `push_mix_c16_outage503` | one-row push | 16 | 503 for 6 s (longer than the retry budget) |
| `pull_mix_c4_outage503` (full only) | pull page | 4 | 503 for 6 s |

Points take 240 samples in the full variant (200 or more is marked `samples_sufficient: 1`); the smoke
variant takes 24 to 40 and is only a harness check. Fault scenarios run for a fixed window (1.5 s
before the fault, the fault, 6 s after) and at least 200 samples. Each point is preceded by
`2 x concurrency` (at least 4) unrecorded warm-up requests.

## Reading the report

- `latency_ms`: client-side, request start to full response body. Nearest-rank p50/p90/p99, min, mean, max.
- `throughput_rps`: recorded requests divided by the point's wall time.
- `app_memory_mb`: App Server process only. `before` is after a forced GC; `peak` is the highest
  20 ms sample during the point; `after` is at the end, without GC.
- `logical`: `provider_calls` are the route's Drive calls (each `withDriveRetry` call counts once,
  from Server-Timing); `mongo_commands` are MongoDB commands the App Server started (driver command
  monitoring, includes lock polling and transactions).
- `app_bytes`: `request_payload` and `response_payload` are HTTP bodies at the App Server boundary;
  `transport_in`/`transport_out` are socket bytes including HTTP framing.
- `provider_transport`: requests the stand-in received (retries included, so
  `requests_per_logical_call` above 1 means retries), faulted answers, its in-flight high-water mark,
  and socket bytes including multipart framing.
- `errors`: counts by code: `http_<status>_<error>` for non-200 answers, `row_<error>` for failed
  push rows, `pull_page_incomplete`, `client_request_failed`. `error_rate` is the failed fraction.
- `recovery` (fault scenarios): `pre_fault_p99_ms`; `disturbed_threshold_ms` (2 x that p99, at least
  +50 ms); requests that failed or exceeded it; and descriptive `recovery_ms`, from the end of the
  fault window to the end of the last disturbed request. Qualification uses a separate window chosen
  in advance: starts 4 seconds after the fault ends, lasts 2 seconds, and needs at least 20 completed
  requests plus evidence that the window elapsed. All failures within that window count, including
  ones followed by successes. Its boundaries, p50/p99, count, failures and `qualified` are recorded.
- `saturation`: for the instant-provider push and pull sweeps, the first concurrency where throughput
  grows by less than 10% over the previous level, or more than 1% of requests fail (0: not reached).
- `outcome`/`checks`: the run fails if any Drive request lacked the stored token, a point recorded
  nothing or hit the hard time limit, a fault was not injected, recovery did not qualify, or the
  App Server did not acknowledge successful deletion of its generated disposable database. Cleanup
  has a 10-second deadline; the report is written only after it finishes. `seed.duration_ms` measures
  seeding only and excludes all characterization scenarios.

## Recorded runs

Numbers below are from GitHub-hosted `ubuntu-24.04` runners, MongoDB 7.0 in Docker, Node 22.
They will differ on other machines and say nothing about production capacity.

_Pending the first CI run._
