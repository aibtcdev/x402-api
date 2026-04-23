# Phase 10 Plan: PR Handoff

Date: 2026-04-22
Phase: 10 — Push branch, open PR, post issue comments

---

## PR Title

`feat(payments): adopt native boring-tx state machine`

---

## PR Body

See below (used verbatim in `gh pr create`):

```
## Summary

- Adopts the relay's native boring-tx state machine, eliminating the
  compat shim that inferred payment state from relay error strings.
- Adds `PaymentPollingDO` — a Durable Object that registers every
  in-flight payment, polls `checkStatusUrl` with exponential backoff,
  and surfaces a `/payment-status/:paymentId` route for agents.
- Emits structured `payment.*` events (`payment.initiated`,
  `payment.poll`, `payment.finalized`) with canonical `paymentId`,
  `status`, and `terminalReason` fields — replacing the old
  `compat_shim_used: true` log pattern.
- Adds `retryable`, `retryAfter`, and `nextSteps` fields to payment
  error responses so agents know exactly what action to take next.
- Routes all payment types through `@aibtc/tx-schemas` enums and
  Zod schemas, replacing hand-rolled state checks and string matching.

## Closes

Closes #99
Closes #93
Closes #84

Addresses part of #85 (the error-response shape portion — remaining
items in #85 stay open and are tracked separately).

## Supersedes (prose — not auto-close keywords)

This PR supersedes #94 (`transaction_held` classification via
string-matching) and #106 (`conflicting_nonce` retry logic). Both of
those approaches are now handled natively by the relay's boring-tx
state machine: `terminalReason` values map directly to
`TERMINAL_REASON_TO_CATEGORY` and `TERMINAL_REASON_CATEGORY_HANDLING`
from `@aibtc/tx-schemas`. Authors of #94 and #106 have been asked to
close those PRs once they've confirmed.

## References

#87 (stage-2 follow-up): `PaymentPollingDO._fetchStatus()` is the
single swap point for the RPC service binding. Once the `X402_RELAY`
service binding is configured, replace the `fetch(checkStatusUrl)` call
in `PaymentPollingDO` with `env.X402_RELAY.checkPayment(paymentId)` —
the method signature does not change and no other callers need updating.

## Verification

The following were run and passed before this PR was opened:

- `npm run check` — TypeScript type-check clean
- `npm run deploy:dry-run` — Cloudflare Worker build succeeds
- Unit tests covering boring-tx lifecycle (payment.initiated →
  payment.poll → payment.finalized) pass without live relay

**Deployment-gated note:** The `test:full` payment-polling lifecycle
test asserts the `X-PAYMENT-ID` response header, which is only present
after this branch is deployed to the staging environment
(`x402.aibtc.dev`). Do not chase a failing `X-PAYMENT-ID` assertion
locally against live staging until this branch is deployed. The test
itself is correct — it is gated on deployment.

## Migration

This PR adds a Durable Object migration tag `v3`
(`new_sqlite_classes: ["PaymentPollingDO"]`). A single-PR merge must
ship atomically with the migration — do not cherry-pick the DO files
without the wrangler.jsonc migration entry.
```

---

## Comments to Post

### On #94 (transaction_held classification)

> Hi! I wanted to let you know that [this PR](PR_URL) supersedes the
> transaction_held classification work here. The relay now surfaces
> `terminalReason` values natively via the boring-tx state machine, so
> the string-matching approach in this PR is no longer needed —
> `TERMINAL_REASON_TO_CATEGORY` from `@aibtc/tx-schemas` handles the
> classification directly.
>
> Once you've had a chance to look at the new PR and confirm, would you
> mind closing this one? No rush — just want to avoid confusion once
> the branch lands. Thanks for the work here, the problem framing was
> helpful context for the design.

### On #106 (conflicting_nonce retry)

> Hi! Wanted to flag that [this PR](PR_URL) supersedes the
> conflicting_nonce retry logic here. The relay now tracks nonce state
> natively and exposes it via `terminalReason` in the boring-tx state
> machine — `TERMINAL_REASON_CATEGORY_HANDLING` from `@aibtc/tx-schemas`
> maps directly to the right client action (rebuild-and-resign vs
> bounded-retry-same-payment).
>
> Once you've reviewed the new PR and are comfortable, would you mind
> closing this one? Happy to answer questions about how the new approach
> works. Thanks for the detailed nonce analysis — it fed directly into
> the error-hints design.

### On #87 (RPC service binding)

> The DO seam for this issue is now in place. `PaymentPollingDO` (added
> in [this PR](PR_URL)) polls `checkStatusUrl` via HTTP in Phase 4.
> The single swap point for the RPC service binding (#87) is
> `PaymentPollingDO._fetchStatus()` — replace the `fetch(checkStatusUrl)`
> call there with `env.X402_RELAY.checkPayment(paymentId)` and nothing
> else changes. The `status()` route, alarm backoff, and `derivedHints()`
> logic are all binding-agnostic.

---

## URLs (filled in after PR creation)

- PR URL: https://github.com/aibtcdev/x402-api/pull/107
- Comment on #94: https://github.com/aibtcdev/x402-api/pull/94#issuecomment-4302695219
- Comment on #106: https://github.com/aibtcdev/x402-api/pull/106#issuecomment-4302695998
- Comment on #87: https://github.com/aibtcdev/x402-api/issues/87#issuecomment-4302696710
