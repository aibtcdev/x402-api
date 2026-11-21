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
 * Dedicated error code for `verify_nonce_on_chain` (`409 Conflict`) so neither
 * x402 clients nor generic HTTP retry middleware mistake an unreadable payer-nonce
 * outcome for a transient `502 UNEXPECTED_SETTLE_ERROR` or a `402` re-pay challenge.
 */
export const PAYER_NONCE_UNVERIFIED_CODE = "PAYER_NONCE_UNVERIFIED" as const;

/**
 * Maximum payer-nonce guard `"unavailable"` verdicts (Hiro brownout,
 * unindexed consumed tx, or unparseable `raw_tx`) before stopping with a
 * non-402, non-5xx `"verify_nonce_on_chain"` (`409`, `PAYER_NONCE_UNVERIFIED`)
 * outcome rather than `start_new_payment` or uncapped `retry_later`.
 */
export const MAX_NONCE_GUARD_UNAVAILABLE_RETRIES = 2;

/**
 * Maximum `detected_missing_nonces` gap-driven `"pending"` verdicts on a
 * relay-failed payment before instructing the caller to `rebuild_and_resign`
 * at exact `payerNonce` `N` (filling/replacing the gap at `N` rather than
 * signing above the mempool frontier or waiting indefinitely).
 */
export const MAX_NONCE_GUARD_MISSING_GAP_RETRIES = 4;

/**
 * Maximum mempool-driven `"pending"` guard verdicts AND minimum elapsed stall
 * window (`90s`, matching 6 × 15s nominal retries) after the settlement relay
 * has already rejected or marked a payment `failed` before instructing the
 * caller to `rebuild_and_resign` at exact `payerNonce` `N` (a same-nonce RBF
 * replacement so at most one transaction at `N` can confirm, while fast or
 * parallel bursts within `< 90s` keep returning `retry_later`).
 */
export const MAX_NONCE_GUARD_MEMPOOL_PENDING_RETRIES = 6;
export const MIN_NONCE_GUARD_MEMPOOL_PENDING_ELAPSED_MS = 90_000;

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

export type PayerNonceUnavailableReason =
  | "nonce_state_unknown"
  | "consumed_tx_unindexed"
  | "consumed_tx_unparseable";

export type PayerNoncePendingReason = "mempool" | "missing_nonce_gap";

export type PayerNonceGuardVerdict =
  | { outcome: "unused"; pinToPayerNonce?: boolean }
  | { outcome: "pending"; reason?: PayerNoncePendingReason }
  | { outcome: "confirmed"; txid: string }
  | { outcome: "replaced" }
  | { outcome: "aborted" }
  | { outcome: "unavailable"; reason?: PayerNonceUnavailableReason };

export type PayerNonceGuardDecision =
  | {
      kind: "settle_confirmed";
      txid: string;
      resetCounters: true;
    }
  | {
      kind: "allow_base_hints";
      payerNonce?: number;
      mustUseNonce?: number;
      resetCounters: true;
    }
  | {
      kind: "replaced";
      status: "replaced";
      terminalReason: "nonce_replacement";
      nextSteps: "start_new_payment";
      retryable: false;
      httpStatus: 402;
      resetCounters: true;
    }
  | {
      kind: "aborted";
      status: "failed";
      terminalReason: "chain_abort";
      nextSteps: "start_new_payment";
      retryable: false;
      httpStatus: 402;
      resetCounters: true;
    }
  | {
      kind: "retry_later";
      status?: "mempool";
      errorReason:
        | "payer_nonce_pending"
        | "payer_nonce_missing_gap"
        | "payer_nonce_guard_unavailable";
      message: string;
      nextSteps: "retry_later";
      retryable: true;
      retryAfter: number;
      httpStatus: 402;
      resetCounters: false;
    }
  | {
      kind: "rebuild_at_same_nonce";
      status: "failed";
      terminalReason: "sender_nonce_gap" | "sender_nonce_duplicate";
      errorReason: "sender_nonce_gap" | "sender_nonce_duplicate";
      message: string;
      nextSteps: "rebuild_and_resign";
      retryable: true;
      httpStatus: 402;
      payerNonce: number;
      mustUseNonce: number;
      resetCounters: false;
    }
  | {
      kind: "verify_nonce_on_chain";
      code: typeof PAYER_NONCE_UNVERIFIED_CODE;
      status: "failed";
      errorReason: "payer_nonce_verification_unavailable";
      message: string;
      nextSteps: "verify_nonce_on_chain";
      retryable: false;
      httpStatus: 409;
      payerNonce: number;
      unavailableReason?: PayerNonceUnavailableReason;
      resetCounters: false;
    };

/**
 * Pure decision table mapping `(verdict, payerNonce, counters, retryAfterSec)`
 * to a deterministic middleware action:
 *   - Resolved verdicts (`confirmed`, `unused`, `replaced`, `aborted`) set
 *     `resetCounters: true`. When `unused` matches `possible_next_nonce`
 *     (`pinToPayerNonce !== false`), `mustUseNonce = N` is returned so any
 *     new payment remains mutually exclusive on-chain with a delayed gossip of
 *     the original tx; when `pinToPayerNonce === false` (`txNonce > possible_next_nonce`),
 *     `mustUseNonce` is omitted so the caller can sign at `possible_next_nonce`.
 *   - Unresolved verdicts (`pending`, `missing_nonce_gap`, `unavailable`) set
 *     `resetCounters: false` so alternating flaky responses never reset each
 *     other's cap.
 *   - Exceeding `MAX_NONCE_GUARD_MISSING_GAP_RETRIES` or stalling in `mempool`
 *     past both `MAX_NONCE_GUARD_MEMPOOL_PENDING_RETRIES` and
 *     `MIN_NONCE_GUARD_MEMPOOL_PENDING_ELAPSED_MS` returns `rebuild_and_resign`
 *     pinned to `payerNonce` `N` (`mustUseNonce: N` in both header and body)
 *     so at most one transaction at `N` can confirm on-chain.
 *   - Exceeding `MAX_NONCE_GUARD_UNAVAILABLE_RETRIES` returns HTTP `409` +
 *     `PAYER_NONCE_UNVERIFIED` (`verify_nonce_on_chain`, `retryable: false`,
 *     omitting `terminalReason` so `internal_error -> retry_later` table
 *     readers never loop) when the payer's nonce state cannot be read.
 */
export function resolvePayerNonceGuardDecision(params: {
  verdict: PayerNonceGuardVerdict;
  payerNonce: number;
  retryAfterSec: number;
  unavailableCount?: number;
  gapCount?: number;
  mempoolCount?: number;
  mempoolElapsedMs?: number;
  minMempoolStallMs?: number;
}): PayerNonceGuardDecision {
  const { verdict, payerNonce, retryAfterSec } = params;
  switch (verdict.outcome) {
    case "confirmed":
      return {
        kind: "settle_confirmed",
        txid: verdict.txid,
        resetCounters: true,
      };
    case "unused":
      if (verdict.pinToPayerNonce === false) {
        return {
          kind: "allow_base_hints",
          payerNonce,
          resetCounters: true,
        };
      }
      return {
        kind: "allow_base_hints",
        payerNonce,
        mustUseNonce: payerNonce,
        resetCounters: true,
      };
    case "replaced":
      return {
        kind: "replaced",
        status: "replaced",
        terminalReason: "nonce_replacement",
        nextSteps: "start_new_payment",
        retryable: false,
        httpStatus: 402,
        resetCounters: true,
      };
    case "aborted":
      return {
        kind: "aborted",
        status: "failed",
        terminalReason: "chain_abort",
        nextSteps: "start_new_payment",
        retryable: false,
        httpStatus: 402,
        resetCounters: true,
      };
    case "pending": {
      if (verdict.reason === "missing_nonce_gap") {
        const gapCount = params.gapCount ?? 1;
        if (gapCount > MAX_NONCE_GUARD_MISSING_GAP_RETRIES) {
          return {
            kind: "rebuild_at_same_nonce",
            status: "failed",
            terminalReason: "sender_nonce_gap",
            errorReason: "sender_nonce_gap",
            message: `Payer nonce ${payerNonce} is missing below higher-nonce mempool transactions; rebuild and re-sign using exact nonce ${payerNonce}`,
            nextSteps: "rebuild_and_resign",
            retryable: true,
            httpStatus: 402,
            payerNonce,
            mustUseNonce: payerNonce,
            resetCounters: false,
          };
        }
        return {
          kind: "retry_later",
          status: "mempool",
          errorReason: "payer_nonce_missing_gap",
          message: "Transaction pending on-chain for payer nonce, please retry",
          nextSteps: "retry_later",
          retryable: true,
          retryAfter: retryAfterSec,
          httpStatus: 402,
          resetCounters: false,
        };
      }
      const mempoolCount = params.mempoolCount ?? 1;
      const minStallMs =
        params.minMempoolStallMs ?? MIN_NONCE_GUARD_MEMPOOL_PENDING_ELAPSED_MS;
      const mempoolStallElapsed =
        params.mempoolElapsedMs === undefined ||
        params.mempoolElapsedMs >= minStallMs;
      if (
        mempoolCount > MAX_NONCE_GUARD_MEMPOOL_PENDING_RETRIES &&
        mempoolStallElapsed
      ) {
        return {
          kind: "rebuild_at_same_nonce",
          status: "failed",
          terminalReason: "sender_nonce_duplicate",
          errorReason: "sender_nonce_duplicate",
          message: `Transaction at payer nonce ${payerNonce} remains unconfirmed in mempool after relay failure; rebuild and re-sign using exact nonce ${payerNonce} to replace it safely`,
          nextSteps: "rebuild_and_resign",
          retryable: true,
          httpStatus: 402,
          payerNonce,
          mustUseNonce: payerNonce,
          resetCounters: false,
        };
      }
      return {
        kind: "retry_later",
        status: "mempool",
        errorReason: "payer_nonce_pending",
        message: "Transaction pending on-chain for payer nonce, please retry",
        nextSteps: "retry_later",
        retryable: true,
        retryAfter: retryAfterSec,
        httpStatus: 402,
        resetCounters: false,
      };
    }
    case "unavailable": {
      const unavailableCount = params.unavailableCount ?? 1;
      if (unavailableCount <= MAX_NONCE_GUARD_UNAVAILABLE_RETRIES) {
        return {
          kind: "retry_later",
          errorReason: "payer_nonce_guard_unavailable",
          message: "Unable to verify payer account nonce, please retry",
          nextSteps: "retry_later",
          retryable: true,
          retryAfter: retryAfterSec,
          httpStatus: 402,
          resetCounters: false,
        };
      }
      return {
        kind: "verify_nonce_on_chain",
        code: PAYER_NONCE_UNVERIFIED_CODE,
        status: "failed",
        errorReason: "payer_nonce_verification_unavailable",
        message: `Unable to verify on-chain outcome for payer nonce ${payerNonce}; check payer nonce ${payerNonce} on-chain before re-signing`,
        nextSteps: "verify_nonce_on_chain",
        retryable: false,
        httpStatus: 409,
        payerNonce,
        unavailableReason: verdict.reason,
        resetCounters: false,
      };
    }
  }
}
