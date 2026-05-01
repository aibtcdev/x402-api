# Cloudflare Cost Runbook

This repo is part of the April 2026 bill-reduction sprint. Every cost
PR must record the Cloudflare metric it is expected to move, the
before/after window, and the rollback signal. See
`cloudflare-bill-audit-2026-04.md` (in the org root) for full context.

`x402-api` is a smaller cost surface than `agent-news` or `worker-logs`,
but it is involved in two decisions Phase -1 and Phase 2 must settle.

## Inventory: current observability config (2026-05-01)

`wrangler.jsonc` snapshot:

| Scope | `observability.enabled` | LOGS RPC binding |
|-------|------------------------|------------------|
| Top-level (local dev) | `false` | unset |
| `env.staging` (`x402-api-staging`, `x402.aibtc.dev`) | `true` | `worker-logs-staging.LogsRPC` |
| `env.production` (`x402-api-production`, `x402.aibtc.com`) | `true` | `worker-logs-production.LogsRPC` |

Logger: `src/utils/logger.ts`. APP_ID is `x402-api-host`. Logger uses
`ctx.waitUntil` to fire-and-forget LOGS RPC writes, with a console
fallback when LOGS is unbound. Same shape as the relay logger.

Net effect today: production and staging **double-write** every log
line — once to native Workers Logs (via `observability.enabled` +
`console.*` fallback path) and once to `worker-logs` via RPC.

## 7-day baseline (audit reference)

Per `cloudflare-bill-audit-2026-04.md` Section 4 / F3 table:

| App | 7d logs | Share |
|-----|--------:|------:|
| x402-api-host | 18,043 | 1% |

This is the smallest active producer in the worker-logs sink. Volume
itself is not a cost-driver. The reason this repo still appears in the
audit is the **double-write** posture, plus the deploy-script safety
issue on `worker-logs` that the audit calls out for several services.

## Decision A: native Workers Logs disposition (operator-gated)

Two options, both safe. Pick before Phase 2 starts.

**Option 1 - keep both, no sampling.** Native Workers Logs stays
enabled, worker-logs RPC keeps writing. Cost impact is ~zero given the
event volume. Simplest path to Phase 2: when `@aibtc/platform/logger`
ships, swap the RPC sink for the native sink and delete the LOGS
binding. Recommended unless invocation-log volume becomes a cost surface.

**Option 2 - disable invocation logs now.** Set
`observability.logs.invocation_logs = false` in both envs. Keeps
custom structured logs for request/payment context, drops Cloudflare's
auto-generated per-invocation lines. Reduces Workers Logs event count
without touching the RPC path. Useful only if Phase 2's Workers Logs
budget shows pressure.

**Recommended default:** Option 1. Revisit if `x402-api` traffic grows
past one or two orders of magnitude or the Phase 2 event budget is
tight.

## Decision B: deploy-script safety (parity with worker-logs PR #19)

`x402-api`'s `package.json` already exposes `deploy:dry-run`. It does
not yet have `deploy:staging` / `deploy:production` named scripts —
the deploy command in CLAUDE.md is "commit and push for automatic
deployment". As long as no human ever runs `npm run deploy` directly,
we are safe. If we want belt-and-braces, mirror the worker-logs PR by
adding named scripts so an accidental local deploy cannot target the
top-level dev config.

**Recommended default:** add named scripts to match the worker-logs and
agent-news pattern; the marginal cost is one PR.

## F-track participation

| Fix | x402-api involvement | Status |
|-----|---------------------|--------|
| F1 (NewsDO) | none | n/a |
| F2 (KV rate-limit) | none — uses payment middleware, not KV counters | n/a |
| F3a (INFO log sampling) | not yet — volume is small enough that sampling is optional | open |
| F3b (Workers Logs migration) | yes — swap LOGS RPC for `@aibtc/platform/logger` once it lands | Phase 2 |
| F6 (landing-page KV) | none | n/a |
| F7 (`@aibtc/platform`) | yes — adopts `/auth`, `/logger`, `/tracing` per Phase 1 / Phase 2 | upcoming |

## Operating loop

Every cost PR in this repo follows the same loop as the rest of the
sprint:

1. **Plan** - state the metric, expected direction, rollback path.
2. **Implement** - keep PR scope tight to one cost surface.
3. **Release** - record commit SHA, environment, deploy time.
4. **Verify** - 15-30 min health check, same-day cost check, 24-48h
   confirmation.
5. **Record** - update this runbook with before/after numbers and
   follow-up risks.
6. **Advance** - only start the next dependent step after verification
   passes or a rollback decision is made.
