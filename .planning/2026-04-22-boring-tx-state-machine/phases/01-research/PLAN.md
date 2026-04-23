<?xml version="1.0" encoding="utf-8"?>
<plan>
  <goal>
    Produce a written map from the current x402-api compat-shim code paths to the native
    boring-tx events the relay now emits, plus a port plan for the polling DO pattern from
    landing-page and agent-news. Output: NOTES.md with shim inventory, behavior table,
    tx-schemas entry points, relay endpoint shapes, DO API sketch, and risk list.
  </goal>

  <context>
    x402-api v1.6.1 uses x402-stacks ^2.0.1 and @aibtc/tx-schemas ^0.3.0 (installed: 1.0.0).
    The middleware at src/middleware/x402.ts calls verifier.settle() from x402-stacks.
    All payment event logs carry compat_shim_used: true, paymentId: null,
    checkStatusUrl_present: false because extractCanonicalPaymentDetails() falls through to
    the "inferred" path — the relay never returned paymentId/checkStatusUrl before boring-tx.

    x402-sponsor-relay v1.30.1 now generates paymentId (pay_ prefix) in submitPayment() and
    always populates checkStatusUrl on every response. The compat shim path (inferLegacyStatus,
    inferLegacyTerminalReason) is needed only for relay responses that predate boring-tx.

    Reference repos (read-only):
    - landing-page: lib/inbox/payment-contract.ts, lib/inbox/x402-verify.ts
    - agent-news: src/routes/payment-status.ts, src/services/x402.ts
    - tx-schemas: src/core/*, src/http/*, src/rpc/*
    - x402-sponsor-relay: src/rpc.ts (submitPayment, checkPayment), src/endpoints/payment-status.ts
  </context>

  <task id="1">
    <name>Read core source files and reference repos</name>
    <files>
      src/middleware/x402.ts,
      src/utils/payment-status.ts,
      src/utils/payment-observability.ts,
      src/utils/payment-contract.ts,
      src/types.ts,
      src/durable-objects/UsageDO.ts,
      wrangler.jsonc,
      package.json,
      ~/dev/aibtcdev/tx-schemas/src/core/enums.ts,
      ~/dev/aibtcdev/tx-schemas/src/core/terminal-reasons.ts,
      ~/dev/aibtcdev/tx-schemas/src/core/payment.ts,
      ~/dev/aibtcdev/tx-schemas/src/http/schemas.ts,
      ~/dev/aibtcdev/tx-schemas/src/rpc/schemas.ts,
      ~/dev/aibtcdev/x402-sponsor-relay/src/rpc.ts,
      ~/dev/aibtcdev/x402-sponsor-relay/src/endpoints/payment-status.ts,
      ~/dev/aibtcdev/agent-news/src/services/x402.ts,
      ~/dev/aibtcdev/agent-news/src/routes/payment-status.ts
    </files>
    <action>
      Read all listed files to understand:
      1. Exactly where compat-shim flags are set and logged in x402-api
      2. What fields the relay now emits (paymentId, checkStatusUrl, status, terminalReason)
      3. What tx-schemas exports are available under @aibtc/tx-schemas/{core,http,rpc}
      4. How agent-news verifyPayment() + payment-status route implement the polling DO
      5. What the relay RPC interface looks like (submitPayment, checkPayment signatures)
    </action>
    <verify>
      All files readable without error. Key values extracted:
      - current installed tx-schemas version
      - compat shim code locations (file:line)
      - relay checkStatusUrl URL pattern
      - agent-news DO polling implementation skeleton
    </verify>
    <done>
      Complete inventory of all compat-shim touch-points and relay native fields.
    </done>
  </task>

  <task id="2">
    <name>Write NOTES.md with all required sections</name>
    <files>
      .planning/2026-04-22-boring-tx-state-machine/phases/01-research/NOTES.md
    </files>
    <action>
      Create NOTES.md covering all six required sections:
      1. Shim inventory - every file, function, and log field carrying compat_shim semantics
      2. Behavior comparison table - landing-page vs agent-news vs x402-api
      3. tx-schemas entry points - which exports to use in each phase
      4. Relay endpoint/response shapes - submitPayment and checkPayment exact types
      5. DO public API sketch - concrete TypeScript interface and SQLite schema for PaymentPollingDO
      6. Risk list - versioning, #87 coupling, data migration, wrangler migration tag

      The DO public API sketch must be concrete enough to implement from (Phase 4 deliverable).
      Include the swap point comment at poll() as described in PHASES.md.
    </action>
    <verify>
      NOTES.md exists, has all 6 headings, is not a placeholder, DO sketch includes
      TypeScript interface with track/poll/status/derivedHints methods and SQLite CREATE TABLE.
    </verify>
    <done>
      NOTES.md written with substantive content in every section.
    </done>
  </task>

  <task id="3">
    <name>Commit PLAN.md and NOTES.md</name>
    <files>
      .planning/2026-04-22-boring-tx-state-machine/phases/01-research/PLAN.md,
      .planning/2026-04-22-boring-tx-state-machine/phases/01-research/NOTES.md
    </files>
    <action>
      Stage both files and commit with message:
      docs(planning): phase 1 research notes for boring-tx adoption
    </action>
    <verify>
      git log shows the commit with both files.
    </verify>
    <done>
      Conventional commit in git history.
    </done>
  </task>
</plan>
