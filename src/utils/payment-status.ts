import { InFlightPaymentStateSchema } from "@aibtc/tx-schemas/core";
import { TERMINAL_REASON_TO_CATEGORY } from "../services/payment-contract";
import type { TerminalReason } from "../services/payment-contract";

/**
 * Grace window after enqueue where KV eventual-consistency `not_found` from a
 * remote edge POP is treated as still pending instead of marking a payment
 * terminal or clearing its bound state.
 * Cloudflare KV docs note: "Changes may take up to 60 seconds or more to be
 * visible in other global network locations as their cached versions of the
 * data time out." Sized to 90s as a practical buffer above typical propagation.
 */
export const NOT_FOUND_ENQUEUE_GRACE_MS = 90_000;

// =============================================================================
// Retry Decision Context
// =============================================================================

/**
 * Structured context extracted from a payment error response body.
 * Callers use this to decide whether to retry, reuse, or rebuild a payment.
 */
export interface RetryDecisionContext {
  /** Canonical payment state from relay (e.g. "queued", "failed", "confirmed") */
  status?: string;
  /** Terminal reason if payment failed (e.g. "sender_nonce_stale") */
  terminalReason?: string;
  /** Relay-assigned payment identifier */
  paymentId?: string;
  /** True if the relay indicates the caller should retry */
  retryable?: boolean;
}

/**
 * Extract a RetryDecisionContext from a parsed (unknown) error response body.
 * Returns null if the body has no recognizable retry context fields.
 *
 * Handles the canonical 402 error body shape:
 *   { status, terminalReason, paymentId, retryable, ... }
 */
export function getRetryDecisionContext(body: unknown): RetryDecisionContext | null {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return null;
  }
  const record = body as Record<string, unknown>;

  // Require at least status or paymentId to be present for a meaningful context
  if (typeof record.status !== "string" && typeof record.paymentId !== "string") {
    return null;
  }

  const ctx: RetryDecisionContext = {};
  if (typeof record.status === "string") ctx.status = record.status;
  if (typeof record.terminalReason === "string") ctx.terminalReason = record.terminalReason;
  if (typeof record.paymentId === "string") ctx.paymentId = record.paymentId;
  if (typeof record.retryable === "boolean") ctx.retryable = record.retryable;

  return ctx;
}

export function isInFlightPaymentState(
  status: string | undefined
): status is "queued" | "broadcasting" | "mempool" {
  const parsed = InFlightPaymentStateSchema.safeParse(status);
  return parsed.success;
}

export function isSenderRebuildTerminalReason(reason: string | undefined): boolean {
  if (!reason) return false;
  return TERMINAL_REASON_TO_CATEGORY[reason as TerminalReason] === "sender";
}

export function isRelayRetryableTerminalReason(reason: string | undefined): boolean {
  if (!reason) return false;
  const category = TERMINAL_REASON_TO_CATEGORY[reason as TerminalReason];
  return category === "relay" || category === "settlement";
}

/**
 * Maximum bounded retries of the same signed payment (`MAX_SAME_PAYMENT_RETRIES = 2`
 * means 1 initial attempt + up to 2 retries = 3 total attempts before requiring a new payment).
 */
export const MAX_SAME_PAYMENT_RETRIES = 2;

/**
 * Maximum consecutive payer-nonce guard `"unavailable"` verdicts on released
 * payments (Hiro brownout, unindexed consumed tx, or unparseable `raw_tx`)
 * that convert a terminal failure into `retry_later` before stopping with a
 * non-retryable `"verify_nonce_on_chain"` (`terminalReason: "internal_error"`)
 * outcome rather than `start_new_payment`.
 */
export const MAX_NONCE_GUARD_UNAVAILABLE_RETRIES = 2;

/**
 * Maximum consecutive `detected_missing_nonces` gap-driven `"pending"` verdicts
 * after the relay has already failed/released a payment before treating the
 * persistently unexecuted gap at `txNonce` as `"unused"` (avoiding an uncapped
 * `retry_later` wait while higher-nonce transactions sit in the mempool).
 */
export const MAX_NONCE_GUARD_MISSING_GAP_RETRIES = 4;

/**
 * Max consecutive deterministic schema mismatches in `PaymentPollingDO` before
 * marking the payment row terminal (`failed` / `internal_error`).
 */
export const MAX_CONSECUTIVE_SCHEMA_MISMATCHES = 3;

/**
 * Bounded resubmission rule for `x402Middleware` after releasing a failed
 * `relayPaymentId`. On `x402-sponsor-relay`, `failed` is final for that record
 * (`skip_terminal_payment`), and `getReusablePaymentRecord` drops terminal records
 * so resubmitting the same signed tx under a rotated `settlementAttemptId` is
 * nonce-safe (at most one tx at that sender nonce can confirm) and mints a fresh
 * relay attempt. Allows up to `MAX_SAME_PAYMENT_RETRIES` retries (`failedAttempts <= 2`);
 * once `failedAttempts > MAX_SAME_PAYMENT_RETRIES`, callers must start a new payment.
 */
export function canRetrySamePaymentResubmission(params: {
  status: string | undefined;
  retryable: boolean | undefined;
  terminalReason: string | undefined;
  failedAttempts: number;
}): boolean {
  if (params.status !== "failed") return false;
  if (params.retryable === false) return false;
  if (params.terminalReason !== undefined) {
    if (!isRelayRetryableTerminalReason(params.terminalReason)) {
      return false;
    }
  } else if (params.retryable !== true) {
    return false;
  }
  return params.failedAttempts > 0 && params.failedAttempts <= MAX_SAME_PAYMENT_RETRIES;
}

/**
 * Bounded poll-retry rule for `PaymentPollingDO.poll()`, which only polls
 * `checkPayment(paymentId)` and cannot resubmit a signed transaction:
 *   - Any `failed` status carrying a relay `errorCode` (e.g. `BROADCAST_EXHAUSTED`,
 *     `BROADCAST_FAILED`, `SPONSOR_EXHAUSTED`) reflects a persisted terminal record
 *     on the relay -> mark terminal immediately (`false`).
 *   - Transient no-`errorCode` `checkPayment` failures (e.g. `RELAY_KV` missing in
 *     `rpc.ts:585-593`) retry up to `MAX_SAME_PAYMENT_RETRIES` polls, then mark terminal.
 */
export function shouldRetrySamePaymentPoll(params: {
  status: string | undefined;
  retryable: boolean | undefined;
  terminalReason: string | undefined;
  errorCode?: string;
  retryCount: number;
}): boolean {
  if (params.status !== "failed") return false;
  if (params.retryable !== true) return false;
  if (params.errorCode !== undefined) return false;
  if (
    params.terminalReason !== undefined &&
    !isRelayRetryableTerminalReason(params.terminalReason)
  ) {
    return false;
  }
  return params.retryCount > 0 && params.retryCount <= MAX_SAME_PAYMENT_RETRIES;
}

export interface AccountNoncesSnapshot {
  last_executed_tx_nonce: number | null;
  last_mempool_tx_nonce: number | null;
  possible_next_nonce: number;
  detected_missing_nonces: number[];
  detected_mempool_nonces?: number[];
}

export type SenderNonceLifecycleState = "consumed" | "pending" | "unused";

/**
 * Classify a payment transaction's sender nonce against Hiro's
 * `/extended/v1/address/{payer}/nonces` snapshot before emitting `start_new_payment`
 * or `rebuild_and_resign`:
 *   - `"consumed"`: `txNonce <= last_executed_tx_nonce` (an anchored tx already used this nonce).
 *   - `"pending"`: `txNonce` is still present in the mempool (`detected_mempool_nonces`),
 *     reported as a gap below `last_mempool_tx_nonce` (`detected_missing_nonces`, where the
 *     relay or peer nodes may still rebroadcast the signed tx to fill the gap), or within
 *     `(last_executed_tx_nonce, last_mempool_tx_nonce]`.
 *   - `"unused"`: `txNonce` has neither executed nor sits in or below the mempool frontier,
 *     so signing a new payment is safe.
 */
export function classifySenderNonceState(
  txNonce: number,
  nonces: AccountNoncesSnapshot
): SenderNonceLifecycleState {
  if (!Number.isSafeInteger(txNonce) || txNonce < 0) {
    return "unused";
  }
  const lastExecuted = nonces.last_executed_tx_nonce;
  if (typeof lastExecuted === "number" && txNonce <= lastExecuted) {
    return "consumed";
  }
  const mempoolSet = new Set(nonces.detected_mempool_nonces ?? []);
  if (mempoolSet.has(txNonce)) {
    return "pending";
  }
  const missingSet = new Set(nonces.detected_missing_nonces ?? []);
  if (missingSet.has(txNonce)) {
    return "pending";
  }
  const lastMempool = nonces.last_mempool_tx_nonce;
  if (typeof lastMempool === "number") {
    const floor = typeof lastExecuted === "number" ? lastExecuted : -1;
    if (txNonce > floor && txNonce <= lastMempool) {
      return "pending";
    }
  } else if (
    lastExecuted === null &&
    typeof nonces.possible_next_nonce === "number" &&
    txNonce < nonces.possible_next_nonce
  ) {
    return "consumed";
  }
  return "unused";
}

/**
 * True when `txNonce` has not executed, is absent from `detected_mempool_nonces`,
 * and is explicitly reported in `detected_missing_nonces` (a nonce gap below
 * higher-nonce mempool transactions).
 */
export function isMissingSenderNonceGap(
  txNonce: number,
  nonces: AccountNoncesSnapshot
): boolean {
  if (!Number.isSafeInteger(txNonce) || txNonce < 0) {
    return false;
  }
  const lastExecuted = nonces.last_executed_tx_nonce;
  if (typeof lastExecuted === "number" && txNonce <= lastExecuted) {
    return false;
  }
  const mempoolSet = new Set(nonces.detected_mempool_nonces ?? []);
  if (mempoolSet.has(txNonce)) {
    return false;
  }
  const missingSet = new Set(nonces.detected_missing_nonces ?? []);
  return missingSet.has(txNonce);
}
