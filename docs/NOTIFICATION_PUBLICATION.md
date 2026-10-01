# R20: atomic notification publication

1 October 2026. The admin publication route now inserts the notification and its resolved recipients in one MongoDB transaction. A duplicate notification ID fails before recipient writes. If recipient insertion fails, the new notification and all newly inserted recipients roll back. No schema, index, audience-policy or wire-format changes are required.

## Reproduced before the fix

Baseline commit `9c945a270eb5f91e7127445e56db7d8ed00f3430` adds only two tests to main `3a73032f3b80aaf055a92f6ffe812d596439c195`. [Disposable CI run 36853543838](https://github.com/DevBehindYou/Atomic-Notes-Server-V0.3/actions/runs/36853543838) fails both:

1. Publish to inactive accounts, then attempt publication to active accounts with the same accepted notification ID. The second request fails with HTTP 500, but its recipient rows make the first notice reachable by an active account. The regression requires no expanded audience and unchanged stored recipients.
2. Seed a synthetic orphan recipient, then publish an active-audience notice with that notification ID. The duplicate recipient makes insertMany fail, but other inserts remain. The regression requires no new notification and exactly the pre-existing recipient set.

The baseline reports two failed subtests plus the containing suite failure (three runner failures, not three defects). Existing unrelated integration cases pass. These are synthetic reproductions, not observed production incidents. The route requires admin authentication; this is not an unauthenticated publication exploit.

## Transaction boundary

Audience selection still resolves once before writes, and the same resolved list is retained across transaction retries. Selection is not an atomic snapshot of all account/session/grant reads. Insert the notification first, then ordered recipient inserts using the same session. The existing transaction helper commits both or aborts both.

Existing integration contracts cover successful all/active/inactive/new/targeted publication, audience counts, feed/public exclusion, version filters, read/dismiss and publish-time membership. The two new regression cases remain in the full suite. CI must pass on the fixed head before this PR is ready.

## Limits and rollback

- No historical orphan rows or incorrect memberships are repaired. Production inspection/repair would be a separate, explicitly approved data task.
- Publication is not retry-idempotent: an ambiguous successful response remains ambiguous, and reusing its ID returns the existing error behavior. No automatic republish guarantee is added.
- PATCH and deletion consistency are unchanged. No transaction or snapshot guarantee is claimed for them.
- Large audiences may encounter transaction or execution limits. Production-scale latency and capacity were not measured; the tested failure guarantee is rollback, not unlimited publication size.
- The existing replica-set requirement for Server transactions also applies here. No new infrastructure or dependency is added.
- Revert this isolated code change to roll back behavior. That restores the failure window and does not repair stored data. No production notification or database was accessed during verification.
