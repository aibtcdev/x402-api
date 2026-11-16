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
 * Max retryable `failed` check observations on the same `paymentId` before
 * releasing the binding / marking terminal so the caller may resubmit.
 * Attempts 1..(MAX_SAME_PAYMENT_RETRY_ATTEMPTS - 1) keep the same `paymentId`;
 * attempt >= MAX_SAME_PAYMENT_RETRY_ATTEMPTS releases it.
 */
export const MAX_SAME_PAYMENT_RETRY_ATTEMPTS = 3;

/**
 * Max consecutive deterministic schema mismatches in `PaymentPollingDO` before
 * marking the payment row terminal (`failed` / `internal_error`).
 */
export const MAX_CONSECUTIVE_SCHEMA_MISMATCHES = 3;

/**
 * Shared bounded-retry rule for `checkPayment` results with `status === "failed"`
 * (`@aibtc/tx-schemas` `docs/boring-state-machine-contract.md` :81-82, :123):
 *   - `errorCode === "BROADCAST_EXHAUSTED"` (`finalizeExhaustedPayment`): the
 *     payment is permanently exhausted and relay dedup was released -> release immediately (`false`).
 *   - Other retryable relay/settlement (or untyped `retryable: true`) failures
 *     keep the same `paymentId` up to `MAX_SAME_PAYMENT_RETRY_ATTEMPTS - 1`, then release.
 */
export function shouldKeepSamePaymentForBoundedRetry(params: {
  status: string | undefined;
  retryable: boolean | undefined;
  terminalReason: string | undefined;
  errorCode?: string;
  attemptCount: number;
}): boolean {
  if (params.status !== "failed") return false;
  if (params.retryable !== true) return false;
  if (params.errorCode === "BROADCAST_EXHAUSTED") return false;
  if (
    params.terminalReason !== undefined &&
    !isRelayRetryableTerminalReason(params.terminalReason)
  ) {
    return false;
  }
  return params.attemptCount < MAX_SAME_PAYMENT_RETRY_ATTEMPTS;
}
