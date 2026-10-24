# Note image sync budgets

The updated App can attach at most three images, each automatically optimized to at most 60,000 raw JPEG bytes. Source formats share one count allowance. Existing saved bytes are not recompressed by this Server change. The Server transports the note envelope; it does not decode images or inspect encrypted bodies.

## Matching App and Server bounds

- Title: 300 UTF-16 code units, unchanged.
- Body: 262,144 UTF-16 code units. Three base64 images contribute 240,000 characters plus rich-document framing and prose.
- Encrypted payload: 393,216 base64 characters. The App envelope is base64 of 12-byte nonce, AES-GCM ciphertext and 16-byte tag. Three maximal images plus note framing produce roughly 321KB of payload.
- Complete parsed note wire: 400,000 UTF-8 bytes, including metadata and the Server encV refinement field. UTF-16/body bounds do not replace this byte check.

The 400KB ceiling preserves room for a maximum 393,216-character ciphertext payload and metadata. Ten bounded rows plus response metadata remain below 4.1MB in the regression fixture, below Vercel's documented 4.5MB request/response limit: [Vercel Functions limits](https://vercel.com/docs/functions/limitations). A 500KB ceiling would permit roughly 5MB pull pages from other API clients. PULL_PAGE remains 10; existing 2.5MB/50-row logout batch caps and 4MiB request middleware are unchanged. Ordinary push row policy is unchanged.

## Rollout order and compatibility

1. Merge, verify and deploy the Server budget update to the separate staging service first. A source merge is not a deployed endpoint.
2. Update the App CI wire-fixture pin to the verified Server commit; test actual App plaintext and encrypted sync against it.
3. Distribute the App 60KB build only after its target Server accepts the expanded envelopes. The older Server rejects larger notes; its rejection must leave local notes dirty and intact, not remove attachments or downgrade encryption.
4. Production rollout requires the separate deployment acceptance gate. Existing old-client notes and stored file envelopes remain readable; no migration, ciphertext rewrite, Drive reorganization or user-data cleanup is performed.

Tests cover valid synthetic 16x12 JPEG data padded by a JPEG comment segment to exactly 60,000 bytes, three-image plain and real Node AES-256-GCM envelopes, exact body/payload/wire boundaries, multibyte wire overflow, unchanged encryption separation, ten-row response headroom, actual HTTP push/pull, unchanged legacy notes and preserved metadata after rejected writes. Fixture cleanup is confined to its newly generated guarded test database; the physical-device fixture is separate. Existing externally edited oversized Drive files are a separate pre-existing read-validation concern.
