# Prepare an inactive create-only Drive generation adapter

The current overwrite-before-Mongo failure is characterized in #38. This
follow-up adds an **inactive** adapter and nine synthetic SDK contract tests.
No production route imports it. Existing notes writes, APIs, schemas, indexes,
privacy promises and prices are unchanged; there is no journal or activation.

**From official API documentation; live execution unverified:** Drive supports
pre-generated IDs passed to create/copy, with 409 on repeats of successful
creates. This excludes most native Google Workspace formats, while Atomic files
use ordinary `application/json`. The method supports the existing `drive.file`
scope. Sources checked 7 October 2026:
[create-file guide](https://developers.google.com/workspace/drive/api/guides/create-file),
[generateIds reference](https://developers.google.com/workspace/drive/api/reference/rest/v3/files/generateIds).
No live Google API, OAuth or device access was performed.

**Adapter behavior:** generate a bounded, exact list of unique IDs; the caller
must retain an ID durably before uploading. Create only with that ID, then verify
parent, identity, JSON MIME, non-trashed state and full canonical content readback.
A create 409 is accepted only after the same checks. It never searches by name,
updates, untrashes, deletes or overwrites an existing file. Current note wire
limits and mixed-plaintext/ciphertext refusal are reused. A changed collision is
an explicit error; other API errors propagate for the caller's retry policy.

**Verification boundary:** mocks exercise actual adapter/SDK request composition
and a create whose reply is lost after a fake file exists. They verify one file
on retained-ID retry, corruption/identity refusal and no overwrite calls. This
does not prove real Drive behavior, durable reservation, Mongo transactions,
process crashes, reader/lease/wipe races, cleanup policy or production recovery.
Initial creation uses one create plus metadata/media readback, with extra API
latency/quota/storage requiring measurement. A reviewed metadata-only journal,
retention/old-writer decisions and separate schema approval remain prerequisites.
R11/R16 stay partial; this preparation receives no closure credit.

**Local verification:** type checking and all 72 pure tests pass after correcting
the validation projection to include `deleted: false`. AtomicFile content has
no deletion field; deletion remains Mongo metadata-owned. The initial published
revision incorrectly omitted the required field and failed five new local tests;
its CI run 37667116921 also failed. That failed revision is retained as evidence,
not accepted for merge. No wire or storage schema was changed to correct it.
