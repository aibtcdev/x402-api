import { describe, expect, test } from "bun:test";
import {
  MAX_SAME_PAYMENT_RETRY_ATTEMPTS,
  isInFlightPaymentState,
  isRelayRetryableTerminalReason,
  isSenderRebuildTerminalReason,
  shouldKeepSamePaymentForBoundedRetry,
} from "../src/utils/payment-status";

describe("payment-status classifier predicates", () => {
  test("keeps sender rebuild reasons separate from relay-owned retries", () => {
    expect(isSenderRebuildTerminalReason("sender_nonce_stale")).toBe(true);
    expect(isSenderRebuildTerminalReason("sender_nonce_gap")).toBe(true);
    expect(isSenderRebuildTerminalReason("sender_nonce_duplicate")).toBe(true);
    expect(isSenderRebuildTerminalReason("sender_hand_expired")).toBe(true);
    expect(isSenderRebuildTerminalReason("origin_chaining_limit")).toBe(true);
    expect(isSenderRebuildTerminalReason("expired")).toBe(false);
    expect(isSenderRebuildTerminalReason("queue_unavailable")).toBe(false);
    expect(isSenderRebuildTerminalReason(undefined)).toBe(false);

    expect(isRelayRetryableTerminalReason("queue_unavailable")).toBe(true);
    expect(isRelayRetryableTerminalReason("sponsor_failure")).toBe(true);
    expect(isRelayRetryableTerminalReason("sponsor_exhausted")).toBe(true);
    expect(isRelayRetryableTerminalReason("sponsor_nonce_conflict")).toBe(true);
    expect(isRelayRetryableTerminalReason("broadcast_failure")).toBe(true);
    expect(isRelayRetryableTerminalReason("broadcast_rate_limited")).toBe(true);
    expect(isRelayRetryableTerminalReason("internal_error")).toBe(true);
    expect(isRelayRetryableTerminalReason("sender_nonce_stale")).toBe(false);
    expect(isRelayRetryableTerminalReason("sender_hand_expired")).toBe(false);
    expect(isRelayRetryableTerminalReason(undefined)).toBe(false);
  });

  test("recognizes public in-flight states only", () => {
    expect(isInFlightPaymentState("queued")).toBe(true);
    expect(isInFlightPaymentState("broadcasting")).toBe(true);
    expect(isInFlightPaymentState("mempool")).toBe(true);
    expect(isInFlightPaymentState("submitted")).toBe(false);
    expect(isInFlightPaymentState("confirmed")).toBe(false);
    expect(isInFlightPaymentState(undefined)).toBe(false);
  });

  test("distinguishes dead BROADCAST_EXHAUSTED from bounded same-payment retry", () => {
    expect(
      shouldKeepSamePaymentForBoundedRetry({
        status: "failed",
        retryable: true,
        terminalReason: "internal_error",
        errorCode: "BROADCAST_EXHAUSTED",
        attemptCount: 1,
      })
    ).toBe(false);

    expect(
      shouldKeepSamePaymentForBoundedRetry({
        status: "failed",
        retryable: true,
        terminalReason: "internal_error",
        attemptCount: 1,
      })
    ).toBe(true);

    expect(
      shouldKeepSamePaymentForBoundedRetry({
        status: "failed",
        retryable: true,
        terminalReason: "internal_error",
        attemptCount: MAX_SAME_PAYMENT_RETRY_ATTEMPTS - 1,
      })
    ).toBe(true);

    expect(
      shouldKeepSamePaymentForBoundedRetry({
        status: "failed",
        retryable: true,
        terminalReason: "internal_error",
        attemptCount: MAX_SAME_PAYMENT_RETRY_ATTEMPTS,
      })
    ).toBe(false);

    expect(
      shouldKeepSamePaymentForBoundedRetry({
        status: "failed",
        retryable: true,
        terminalReason: "invalid_transaction",
        attemptCount: 1,
      })
    ).toBe(false);
  });
});
