# Phase 1 Research Notes: boring-tx State Machine Adoption

Date: 2026-04-22
Quest: boring-tx-state-machine
Researcher: Claude Sonnet 4.6

---

## 1. Shim Inventory

The compat shim path is the code that infers payment state from relay responses that
predate the boring-tx protocol (no paymentId, no checkStatusUrl, error-string-based
status inference). Three files carry shim semantics:

### src/utils/payment-status.ts

**Functions that produce `compatShimUsed: true`:**

| Function | Line | Trigger condition |
|---|---|---|
| `inferLegacyStatus()` | ~116 | relay error string contains "transaction_pending", "queued_with_warning", "submitted", "broadcasting", "mempool" |
| `inferLegacyTerminalReason()` | ~154 | relay error string contains nonce/conflict/broadcast keywords |
| `extractStatus()` | ~129 | falls through to `inferLegacyStatus` when no canonical status field found |
| `extractTerminalReason()` | ~195 | falls through to `inferLegacyTerminalReason` when no canonical terminalReason field found |
| `normalizeStatus()` | ~104 | sets `compatShimUsed: true` when a STATUS_ALIASES mapping is applied (e.g. "queued_with_warning" → "queued") |

**Interface `CanonicalPaymentDetails` carries the shim flag:**
```ts
export interface CanonicalPaymentDetails {
  paymentId?: string;       // null in compat path — relay never returned one
  checkStatusUrl?: string;  // null in compat path
  compatShimUsed: boolean;  // true when any inference was required
  source: "canonical" | "inferred";
}
```

**`extractCanonicalPaymentDetails(input)`** — the main entry point called from middleware.
Returns `source: "inferred"` and `compatShimUsed: true` whenever it cannot find a valid
`paymentId` + `status` pair from the relay response directly (i.e., always with old relay).

### src/middleware/x402.ts

**Where shim flag surfaces:**

1. `classifyPaymentError()` — calls `extractCanonicalPaymentDetails(settleResult)` to get
   canonical; the returned canonical may have `compatShimUsed: true`.

2. Settlement failure branch (~line 564):
   ```ts
   if (canonical?.compatShimUsed) {
     logPaymentEvent(log, "warn", "payment.fallback_used", {
       ...
       compatShimUsed: canonical.compatShimUsed,  // <- compat flag emitted
     });
   }
   ```

3. All `logPaymentEvent()` calls pass `compatShimUsed: canonical?.compatShimUsed`:
   - `payment.poll` event (in-flight)
   - `payment.finalized` event (terminal)
   - `payment.retry_decision` event

4. `paymentId` is never generated or minted by x402-api itself. It is only extracted from
   the relay settle response via `extractCanonicalPaymentDetails()`. Since old relay responses
   did not include `paymentId`, `canonical.paymentId` is `undefined` → logs show
   `paymentId: null`.

5. `checkStatusUrl` is also only extracted from settle result; old relay did not return it →
   `checkStatusUrl_present: false` in all logs.

### src/utils/payment-observability.ts

**`buildPaymentLogFields()`** hard-codes the log keys that appear in every event:
```ts
paymentId: context.paymentId ?? null,           // null without boring-tx
checkStatusUrl_present: Boolean(context.checkStatusUrl),  // false without boring-tx
compat_shim_used: Boolean(context.compatShimUsed),        // true on shim path
```

These three fields confirm the quest's observation: all events show
`compat_shim_used: true`, `paymentId: null`, `checkStatusUrl_present: false`.

### src/utils/payment-contract.ts

Thin wrapper re-exporting from `@aibtc/tx-schemas/core`:
```ts
import { CanonicalDomainBoundary, PAYMENT_STATES } from "@aibtc/tx-schemas/core";
```
Not a shim carrier itself, but is the seam to widen in Phase 3.

### Summary of what must be removed in Phase 5

- `inferLegacyStatus()` — entire function
- `inferLegacyTerminalReason()` — entire function
- `compatShimUsed` field from `CanonicalPaymentDetails` and `RetryDecisionContext`
- `source: "inferred" | "legacy"` from `RetryDecisionContext`
- `compat_shim_used` from `buildPaymentLogFields()`
- `checkStatusUrl_present` can stay but must become reliably `true` after Phase 5

---

## 2. Behavior Comparison Table

| Behavior | landing-page | agent-news | x402-api (current) |
|---|---|---|---|
| Payment submission | HTTP POST /settle via x402-verify.ts + relay RPC via relay-rpc.ts | RPC submitPayment via X402_RELAY service binding; HTTP fallback for local dev | HTTP POST via x402-stacks `X402PaymentVerifier.settle()` — no RPC path |
| paymentId source | relay response `.paymentId` (native) | relay `submitResult.paymentId` (native, required) | `extractCanonicalPaymentDetails(settleResult).paymentId` — inferred or null |
| checkStatusUrl source | relay response `.checkStatusUrl` | `submitResult.checkStatusUrl` + local fallback via `buildLocalPaymentStatusUrl()` | `extractCanonicalPaymentDetails(settleResult).checkStatusUrl` — inferred or null |
| Pending detection | `status === "pending"` from HTTP relay | poll exhausted → `paymentStatus: "pending"` | compat shim infers from error strings |
| Poll-on-pending | KV reconciliation queue + `/api/payment-status/:paymentId` route | `/api/payment-status/:paymentId` route calls `c.env.X402_RELAY.checkPayment()` | No polling DO; no /payment-status route; no paymentId to poll with |
| Terminal-reason normalization | `collapseSubmittedStatus()` handles "submitted" → "queued" shim | `parseCheckPaymentResult()` via RpcCheckPaymentResultSchema | `extractTerminalReason()` + `inferLegacyTerminalReason()` (heuristic) |
| Error hints | Not surfaced in response body | `mapVerificationError()` returns `{ retryable, hint, code }` | `classifyPaymentError()` returns `{ code, message, httpStatus, retryAfter }` — no `nextSteps` |
| compat_shim flag | `collapseSubmittedStatus()` fires callback when old "submitted" state seen | `interpretHttpRelayResult()` on HTTP fallback path | `CanonicalPaymentDetails.compatShimUsed: true` on all current events |
| x402-stacks usage | Not used directly | Not used (own payment requirements builder) | `X402PaymentVerifier`, all types from x402-stacks |
| DO for payment state | KV + `/api/payment-status` route (no Durable Object) | No DO for payment state (route + RPC binding) | No DO for payment state at all |

### Key delta: what x402-api needs that it currently lacks

1. **`paymentId` generation on initiation** — relay now always returns `paymentId` from
   `submitPayment()`. The x402-api settle call needs to extract it from the relay response.
   After Phase 4 (DO), middleware registers the paymentId with PaymentPollingDO.

2. **`checkStatusUrl` consumption** — relay now returns this on every response. Middleware
   must save it to the DO so the DO can call it during polling.

3. **Polling DO** — agent-news shows the pattern: DO wraps `checkPayment()` (RPC or HTTP),
   stores state, derives hints. x402-api needs the same thing.

4. **`/payment-status/:paymentId` route** — agent-news exposes it at `/api/payment-status/:paymentId`.
   x402-api needs an equivalent (designed for #87 RPC swap in Phase 4).

---

## 3. tx-schemas Entry Points

Currently installed: `@aibtc/tx-schemas@1.0.0` (constraint `^0.3.0` in package.json).
Latest published on npm: `1.0.0` — constraint satisfies, no version bump needed for Phase 2.

Note: local source at `~/dev/aibtcdev/tx-schemas` shows `version: "1.0.0"` — same version,
so the published package matches the local source we researched.

### Which exports to use in each phase

**Phase 3 (schema adoption):**

```ts
// Core enums — state machine constants
import {
  PAYMENT_STATES, TRACKED_PAYMENT_STATES, IN_FLIGHT_STATES,
  PaymentStateSchema, TrackedPaymentStateSchema, InFlightPaymentStateSchema,
  PAYMENT_STATE_TO_CATEGORY, CanonicalDomainBoundary, RELAY_LIFECYCLE_BRIDGE,
} from "@aibtc/tx-schemas/core";

// Terminal reasons — normalization and category-based client action
import {
  TERMINAL_REASONS, TERMINAL_REASON_TO_STATE, TERMINAL_REASON_TO_CATEGORY,
  TERMINAL_REASON_CATEGORY_HANDLING,
  TerminalReasonSchema, TerminalReasonDetailSchema,
  type TerminalReason, type TerminalReasonCategory,
} from "@aibtc/tx-schemas/core";
// Shorthand export path also available:
import { TERMINAL_REASON_TO_STATE } from "@aibtc/tx-schemas/terminal-reasons";

// HTTP schemas — relay HTTP endpoint response parsing
import {
  HttpPaymentStatusResponseSchema, type HttpPaymentStatusResponse,
  HttpSettleSuccessResponseSchema, HttpSettleFailureResponseSchema,
} from "@aibtc/tx-schemas/http";

// RPC schemas — relay service binding response parsing
import {
  RpcSubmitPaymentResultSchema, RpcCheckPaymentResultSchema,
  type RpcSubmitPaymentResult, type RpcCheckPaymentResult,
  RPC_ERROR_CODES, type RpcErrorCode,
} from "@aibtc/tx-schemas/rpc";
```

**Phase 4 (PaymentPollingDO):**

```ts
import {
  TrackedPaymentStateSchema, InFlightPaymentStateSchema,
  TERMINAL_REASON_TO_STATE, TERMINAL_REASON_CATEGORY_HANDLING,
  type TrackedPaymentState, type TerminalReason, type TerminalReasonCategory,
} from "@aibtc/tx-schemas/core";
import { HttpPaymentStatusResponseSchema } from "@aibtc/tx-schemas/http";
```

**Phase 5 (middleware rewrite):**

```ts
// After shim removal, canonical PaymentPollingDO stores parsed RpcSubmitPaymentResult
import { RpcSubmitPaymentResultSchema } from "@aibtc/tx-schemas/rpc";
// Replace CanonicalPaymentDetails with:
import type { RpcCheckPaymentResult } from "@aibtc/tx-schemas/rpc";
```

**`@aibtc/tx-schemas` flat barrel (`import from "@aibtc/tx-schemas"`) exports everything.**
Prefer sub-path imports for bundle optimization in a Cloudflare Worker (tree-shaking).

### Key constants from tx-schemas used by shim removal

```ts
// Replaces isSenderRebuildTerminalReason() custom function:
TERMINAL_REASON_TO_CATEGORY.sender_nonce_stale === "sender"
TERMINAL_REASON_CATEGORY_HANDLING["sender"].clientAction === "rebuild-signed-payment"

// Replaces isRelayRetryableTerminalReason() custom function:
TERMINAL_REASON_TO_CATEGORY.queue_unavailable === "relay"
TERMINAL_REASON_CATEGORY_HANDLING["relay"].clientAction === "bounded-retry-same-payment"

// TERMINAL_REASON_TO_STATE replaces manual switch/if chains in classifyPaymentError
```

---

## 4. Relay Endpoint / Response Shapes (v1.30.1)

### RPC: `submitPayment(txHex, settle?)` → `RpcSubmitPaymentResult`

**Accepted response:**
```ts
{
  accepted: true,
  paymentId: string,           // "pay_" + uuid, e.g. "pay_a1b2c3..."
  status: "queued" | "broadcasting" | "mempool" | "queued_with_warning",
  checkStatusUrl: string,      // "https://x402-relay.aibtc.dev/payment/pay_..."
  senderNonce?: {
    provided: number,
    expected: number,
    healthy: boolean,
    warning?: string,
  },
  warning?: {                  // only on "queued_with_warning"
    code: "SENDER_NONCE_GAP",
    detail: string,
    senderNonce: { provided, expected, lastSeen },
    help: string,
    action: string,
  },
}
```

**Rejected response:**
```ts
{
  accepted: false,
  error: string,
  code?: RpcErrorCode,   // e.g. "SENDER_NONCE_STALE", "INVALID_TRANSACTION"
  retryable?: boolean,
  help?: string,
  action?: string,
  senderNonce?: { provided, expected, healthy },
}
```

### RPC: `checkPayment(paymentId)` → `RpcCheckPaymentResult`

```ts
{
  paymentId: string,
  status: TrackedPaymentState,     // "queued"|"broadcasting"|"mempool"|"confirmed"|"failed"|"replaced"|"not_found"
  txid?: string,
  blockHeight?: number,
  confirmedAt?: string,            // ISO datetime
  explorerUrl?: string,
  terminalReason?: TerminalReason, // from TERMINAL_REASONS list
  error?: string,
  errorCode?: RpcErrorCode,
  retryable?: boolean,
  senderNonceInfo?: { provided, expected, healthy },
  checkStatusUrl?: string,         // always present in v1.30.1
  // extended relay-internal fields (beyond RpcCheckPaymentResultSchema):
  relayState?: "held" | "queued" | "broadcasting" | "mempool",
  holdReason?: "gap" | "capacity",
  nextExpectedNonce?: number,
  missingNonces?: number[],
  holdExpiresAt?: string,
}
```

### HTTP: `GET /payment/:id` → relay's public status endpoint

Returns same shape as `checkPayment()` but wrapped in:
```ts
{
  success: true,
  requestId: string,
  paymentId: string,
  status: TrackedPaymentState,
  checkStatusUrl: string,          // always returned
  ... (all other RpcCheckPaymentResult fields)
}
```

`404` response when payment not found:
```ts
{
  success: true,
  requestId: string,
  paymentId: string,
  status: "not_found",
  terminalReason: "expired" | "unknown_payment_identity",
  error: string,
  retryable: false,
  checkStatusUrl: string,
}
```

### HTTP: `POST /settle` → relay's HTTP settle endpoint (x402-stacks path)

This is what `X402PaymentVerifier.settle()` currently calls. Response shape:
```ts
// Success:
{ success: true, transaction: string, network: string, payer?: string }
// Failure (boring-tx relay now adds paymentId/checkStatusUrl here too):
{ success: false, errorReason: HttpSettleErrorReason, ... }
```

NOTE: The HTTP `/settle` endpoint does NOT return `paymentId` or `checkStatusUrl` in the
failure body — that is only on the RPC path. Switching to the RPC path (via `X402_RELAY`
service binding) is the prerequisite for native `paymentId` generation. The RPC path
already exists in x402-sponsor-relay as `RelayRPC.submitPayment()`.

---

## 5. PaymentPollingDO Public API Sketch

The DO is namespaced by `paymentId` (one DO instance per in-flight payment). Its job:
1. Persist the paymentId and checkStatusUrl received from the relay on payment acceptance.
2. Use Durable Object alarms to poll `checkStatusUrl` with exponential backoff until terminal.
3. Cache the latest status so the public `/payment-status/:paymentId` route can serve fast.
4. Derive structured error hints (`retryable`, `retryAfter`, `nextSteps`) from terminal state.

**Phase 4 implements HTTP polling inside `poll()`. Phase 5 (issue #87 follow-up) replaces
the `fetch(checkStatusUrl)` call with `env.X402_RELAY.checkPayment(paymentId)` — the method
signature does not change.**

### TypeScript Interface

```ts
// src/durable-objects/PaymentPollingDO.ts

import { DurableObject } from "cloudflare:workers";
import type { Env } from "../types";

export interface PaymentTrackInput {
  paymentId: string;       // pay_ prefix from relay submitPayment
  checkStatusUrl: string;  // URL from relay submitPayment accepted response
  payerAddress: string;    // Stacks address that paid
  route: string;           // e.g. "/hashing/sha256"
  tokenType: string;       // "STX" | "sBTC" | "USDCx"
}

export interface PaymentStatusSnapshot {
  paymentId: string;
  status: string;          // TrackedPaymentState
  terminalReason?: string; // TerminalReason if terminal
  txid?: string;
  confirmedAt?: string;
  checkStatusUrl: string;
  polledAt: string;        // ISO datetime of last poll
  pollCount: number;
}

export interface DerivedHints {
  retryable: boolean;
  retryAfter?: number;     // seconds
  nextSteps: string;       // stable token, e.g. "rebuild_and_resign" | "retry_later" | "start_new_payment" | "wait_for_confirmation"
}

export class PaymentPollingDO extends DurableObject<Env> {
  /**
   * Register a new payment for polling. Called by middleware immediately after
   * a successful submitPayment() that returns accepted:true with a paymentId.
   * Schedules the first alarm for immediate polling (5s).
   */
  async track(input: PaymentTrackInput): Promise<void>;

  /**
   * Poll the relay for current payment status. Called by the alarm handler.
   *
   * SWAP POINT FOR #87: Replace the fetch(this.checkStatusUrl) call here with
   *   env.X402_RELAY.checkPayment(this.paymentId)
   * once the service binding is configured. Signature does not change.
   */
  async poll(): Promise<PaymentStatusSnapshot>;

  /**
   * Return the latest cached status. Fast path — no relay call.
   * Used by GET /payment-status/:paymentId route.
   */
  async status(): Promise<PaymentStatusSnapshot | null>;

  /**
   * Derive structured error hints from current terminal state.
   * Returns null if payment is not yet terminal.
   * Used by Phase 6 error-response shape.
   */
  async derivedHints(): Promise<DerivedHints | null>;
}
```

### SQLite Schema

```sql
-- Single-row state table (one DO per paymentId)
CREATE TABLE IF NOT EXISTS payment_state (
  payment_id       TEXT PRIMARY KEY,
  check_status_url TEXT NOT NULL,
  payer_address    TEXT NOT NULL,
  route            TEXT NOT NULL,
  token_type       TEXT NOT NULL,
  status           TEXT NOT NULL DEFAULT 'queued',
  terminal_reason  TEXT,
  txid             TEXT,
  confirmed_at     TEXT,
  polled_at        TEXT NOT NULL,
  poll_count       INTEGER NOT NULL DEFAULT 0,
  created_at       TEXT NOT NULL,
  is_terminal      INTEGER NOT NULL DEFAULT 0  -- 0/1 boolean
);
```

### Alarm Backoff Schedule

```ts
// Initial alarm: 5 seconds after track()
// Subsequent polls (in-flight states):
//   poll 1-3: every 5 seconds
//   poll 4-6: every 15 seconds
//   poll 7+:  every 60 seconds (cap)
// Max duration: 10 minutes total polling before declaring internal_error
```

### DO Naming and Binding

```ts
// Middleware gets DO stub by paymentId (unique per payment):
const id = env.PAYMENT_POLLING_DO.idFromName(paymentId);
const stub = env.PAYMENT_POLLING_DO.get(id);
await stub.track({ paymentId, checkStatusUrl, payerAddress, route, tokenType });
```

**wrangler.jsonc additions:**
```jsonc
// durable_objects.bindings — add in all three environments (local, staging, production):
{ "name": "PAYMENT_POLLING_DO", "class_name": "PaymentPollingDO" }

// migrations — add after existing v2 tag:
{ "tag": "v3", "new_sqlite_classes": ["PaymentPollingDO"] }
```

**types.ts Env interface addition:**
```ts
PAYMENT_POLLING_DO: DurableObjectNamespace<PaymentPollingDO>;
```

### GET /payment-status/:paymentId Route

```ts
// Mount in src/index.ts at root level (before x402 middleware):
app.get("/payment-status/:paymentId", async (c) => {
  const paymentId = c.req.param("paymentId");
  if (!paymentId?.startsWith("pay_")) {
    return c.json({ error: "Invalid paymentId" }, 400);
  }
  const id = c.env.PAYMENT_POLLING_DO.idFromName(paymentId);
  const stub = c.env.PAYMENT_POLLING_DO.get(id);
  const snapshot = await stub.status();
  if (!snapshot) {
    return c.json({ error: "Payment not found" }, 404);
  }
  return c.json(snapshot);
});
```

### derivedHints Logic (maps to TERMINAL_REASON_CATEGORY_HANDLING)

```ts
// Terminal reason → category → client action → nextSteps token
const category = TERMINAL_REASON_TO_CATEGORY[terminalReason];
const handling = TERMINAL_REASON_CATEGORY_HANDLING[category];
// category === "sender"     → nextSteps: "rebuild_and_resign", retryable: true
// category === "relay"      → nextSteps: "retry_later",        retryable: true, retryAfter: 30
// category === "settlement" → nextSteps: "retry_later",        retryable: true, retryAfter: 30
// category === "replacement"→ nextSteps: "start_new_payment",  retryable: false
// category === "identity"   → nextSteps: "start_new_payment",  retryable: false
// category === "validation" → nextSteps: "fix_and_resend",     retryable: false
// status === "confirmed"    → nextSteps: "wait_for_confirmation" (not terminal from DO POV)
```

---

## 6. Risk List

### R1: tx-schemas version already at 1.0.0 — no bump needed
**Severity: Low.**
Current install is 1.0.0, latest published is 1.0.0. Phase 2 "dependency refresh" will
confirm `npm ls @aibtc/tx-schemas` shows 1.0.0. The package.json constraint `^0.3.0`
satisfies 1.0.0 (semver range logic: `^0.3.0` means `>=0.3.0 <0.4.0`... wait — actually
for `0.x.y`, `^0.3.0` means `>=0.3.0 <0.4.0`). **This is a risk**: 1.0.0 is OUTSIDE the
`^0.3.0` range (0.x.y semver locking). The package.json constraint must be bumped to
`^1.0.0` in Phase 2 before the install can pick up 1.0.0 features.

**Action**: Phase 2 must update `"@aibtc/tx-schemas": "^1.0.0"` and run `npm install`.

### R2: x402-stacks HTTP path vs RPC path for paymentId
**Severity: High.**
The current flow uses `X402PaymentVerifier.settle()` which hits the relay's HTTP `/settle`
endpoint. The HTTP `/settle` endpoint does NOT return `paymentId` in the response body
(per tx-schemas `HttpSettleSuccessResponseSchema` — no paymentId field). The `paymentId`
is only available via the RPC `submitPayment()` result.

**Options:**
- Option A: Add `X402_RELAY` service binding (RPC path) to x402-api — would skip most of
  the x402-stacks library. Requires `wrangler.jsonc` service binding and logic refactor.
- Option B: Relay may add `paymentId`/`checkStatusUrl` to HTTP `/settle` response as an
  extension. Need to verify current v1.30.1 `/settle` response shape.
- Option C: x402-api mints its own `paymentId` (UUID) and uses `checkStatusUrl` from
  the relay's check endpoint pattern — but this violates the contract (relay owns paymentId).

**Recommended**: Option A (RPC binding). This aligns with #87 design goal and is what
agent-news uses. The service binding must be wired in Phase 4 alongside the DO.

**If Option A is not viable before Phase 5:** Check if relay HTTP `/settle` was updated
in v1.30.1 to return `paymentId`. If yes, extract from `settleResult` directly. If no,
Phase 5 cannot drop the compat shim without the RPC binding.

### R3: No existing /payment-status route in x402-api
**Severity: Medium.**
The polling DO requires a public route for agents to poll. This route is new and must be:
- Registered BEFORE any x402 payment middleware (it must be free/unauthenticated)
- Mounted at `/payment-status/:paymentId` (or `/api/payment-status/:paymentId`)
- Validated with `pay_` prefix check to prevent probing

### R4: Wrangler migration tag ordering
**Severity: Medium.**
Existing migration tags: `v1` (UsageDO, StorageDO), `v2` (MetricsDO). New tag `v3`
must be added for PaymentPollingDO. Wrangler migrations are immutable once deployed.
Do not renumber existing tags. The new DO must use `new_sqlite_classes` list.

### R5: #87 RPC swap coupling
**Severity: Low (design risk).**
Phase 4 adds `PaymentPollingDO.poll()` calling `fetch(checkStatusUrl)` via HTTP.
Phase 5 (issue #87 follow-up) swaps this to `env.X402_RELAY.checkPayment(paymentId)`.
Risk: if the DO alarm fires AFTER the service binding is added but before the new
`poll()` code is deployed, a transient inconsistency could occur. Mitigation: deploy
DO + HTTP polling as one unit (Phase 4), keep the swap isolated to Phase 5.

The public method signature `poll(): Promise<PaymentStatusSnapshot>` must not change
between Phase 4 and #87. The status route and derivedHints callers depend on it.

### R6: Existing compat-shim tests and _shared_utils.ts staged diff
**Severity: Low.**
`tests/_shared_utils.ts` has a staged diff (git status shows `M tests/_shared_utils.ts`)
adding `NonceTracker` class and `signPaymentWithNonce()`. This is not committed. Phase 7
must incorporate this diff. Do not lose it during Phase 2 branch creation.

**Action**: Phase 2 must `git stash` or include the staged changes before branching, or
create the branch with the staged changes already applied.

### R7: `payment-observability.ts` hard-codes `compat_shim_used` log field name
**Severity: Low.**
The field name `compat_shim_used` (snake_case) is logged to the remote worker-logs service.
Removing it will cause dashboards/alerts using that field to silently get `undefined`.
Coordinate with any dashboards before Phase 5 deploys to production.

### R8: `classifyPaymentError()` uses both text-matching and canonical path
**Severity: Medium.**
After shim removal, `classifyPaymentError()` will only receive relay responses with
proper `terminalReason` fields — the text-matching fallback chains (lines ~195-245 in
x402.ts) become dead code. Phase 5 should delete them and rely entirely on
`TERMINAL_REASON_TO_CATEGORY`/`TERMINAL_REASON_CATEGORY_HANDLING` for classification.
This simplifies ~100 lines of error-string matching.
