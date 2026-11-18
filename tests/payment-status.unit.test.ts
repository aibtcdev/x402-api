import { describe, expect, test } from "bun:test";
import {
  MAX_SAME_PAYMENT_RETRIES,
  canRetrySamePaymentResubmission,
  classifySenderNonceState,
  isInFlightPaymentState,
  isRelayRetryableTerminalReason,
  isSenderRebuildTerminalReason,
  shouldRetrySamePaymentPoll,
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

  test("bounds same-payment resubmissions and DO poll retries to MAX_SAME_PAYMENT_RETRIES (2)", () => {
    expect(MAX_SAME_PAYMENT_RETRIES).toBe(2);

    // Middleware resubmission budget: failedAttempts 1 and 2 allow resending same payment; 3 exhausts budget
    expect(
      canRetrySamePaymentResubmission({
        status: "failed",
        retryable: true,
        terminalReason: "broadcast_failure",
        failedAttempts: 1,
      })
    ).toBe(true);
    expect(
      canRetrySamePaymentResubmission({
        status: "failed",
        retryable: true,
        terminalReason: "internal_error",
        failedAttempts: MAX_SAME_PAYMENT_RETRIES,
      })
    ).toBe(true);
    expect(
      canRetrySamePaymentResubmission({
        status: "failed",
        retryable: true,
        terminalReason: "internal_error",
        failedAttempts: MAX_SAME_PAYMENT_RETRIES + 1,
      })
    ).toBe(false);
    expect(
      canRetrySamePaymentResubmission({
        status: "failed",
        retryable: false,
        terminalReason: "broadcast_failure",
        failedAttempts: 1,
      })
    ).toBe(false);
    expect(
      canRetrySamePaymentResubmission({
        status: "failed",
        retryable: true,
        terminalReason: "invalid_transaction",
        failedAttempts: 1,
      })
    ).toBe(false);

    // DO poll retry: persisted relay errorCode (BROADCAST_EXHAUSTED, BROADCAST_FAILED) marks terminal immediately;
    // transient no-errorCode failure retries MAX_SAME_PAYMENT_RETRIES (2) times and marks terminal on 3rd observation.
    expect(
      shouldRetrySamePaymentPoll({
        status: "failed",
        retryable: true,
        terminalReason: "internal_error",
        errorCode: "BROADCAST_EXHAUSTED",
        retryCount: 1,
      })
    ).toBe(false);
    expect(
      shouldRetrySamePaymentPoll({
        status: "failed",
        retryable: true,
        terminalReason: "broadcast_failure",
        errorCode: "BROADCAST_FAILED",
        retryCount: 1,
      })
    ).toBe(false);
    expect(
      shouldRetrySamePaymentPoll({
        status: "failed",
        retryable: true,
        terminalReason: "internal_error",
        retryCount: 1,
      })
    ).toBe(true);
    expect(
      shouldRetrySamePaymentPoll({
        status: "failed",
        retryable: true,
        terminalReason: "internal_error",
        retryCount: MAX_SAME_PAYMENT_RETRIES,
      })
    ).toBe(true);
    expect(
      shouldRetrySamePaymentPoll({
        status: "failed",
        retryable: true,
        terminalReason: "internal_error",
        retryCount: MAX_SAME_PAYMENT_RETRIES + 1,
      })
    ).toBe(false);
  });

  test("classifies payer account nonces into consumed, pending, and unused before start_new_payment", () => {
    expect(
      classifySenderNonceState(7, {
        last_executed_tx_nonce: 7,
        last_mempool_tx_nonce: null,
        possible_next_nonce: 8,
        detected_missing_nonces: [],
      })
    ).toBe("consumed");

    expect(
      classifySenderNonceState(8, {
        last_executed_tx_nonce: 7,
        last_mempool_tx_nonce: 8,
        possible_next_nonce: 9,
        detected_missing_nonces: [],
      })
    ).toBe("pending");

    expect(
      classifySenderNonceState(9, {
        last_executed_tx_nonce: 7,
        last_mempool_tx_nonce: 9,
        possible_next_nonce: 10,
        detected_missing_nonces: [8],
        detected_mempool_nonces: [9],
      })
    ).toBe("pending");

    expect(
      classifySenderNonceState(8, {
        last_executed_tx_nonce: 7,
        last_mempool_tx_nonce: 9,
        possible_next_nonce: 10,
        detected_missing_nonces: [8],
        detected_mempool_nonces: [9],
      })
    ).toBe("unused");

    expect(
      classifySenderNonceState(8, {
        last_executed_tx_nonce: 7,
        last_mempool_tx_nonce: null,
        possible_next_nonce: 8,
        detected_missing_nonces: [],
      })
    ).toBe("unused");
  });
});
