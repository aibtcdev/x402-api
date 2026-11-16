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
