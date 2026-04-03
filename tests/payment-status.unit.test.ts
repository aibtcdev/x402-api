import { describe, expect, test } from "bun:test";
import {
  extractCanonicalPaymentDetails,
  getRetryDecisionContext,
  isInFlightPaymentState,
  isRelayRetryableTerminalReason,
  isSenderRebuildTerminalReason,
} from "../src/utils/payment-status";

describe("payment-status adapter", () => {
  test("prefers canonical relay status fields", () => {
    const result = extractCanonicalPaymentDetails({
      success: false,
      paymentId: "pay_123",
      status: "mempool",
      retryable: true,
    });

    expect(result).toEqual({
      paymentId: "pay_123",
      status: "mempool",
      retryable: true,
      error: undefined,
      errorCode: undefined,
      checkStatusUrl: undefined,
      txid: undefined,
      terminalReason: undefined,
      compatShimUsed: false,
      source: "canonical",
    });
  });

  test("collapses submitted to queued before callers see it", () => {
    const result = getRetryDecisionContext({
      paymentId: "pay_queued",
      status: "submitted",
    });

    expect(result).toEqual({
      paymentId: "pay_queued",
      status: "queued",
      terminalReason: undefined,
      retryable: undefined,
      compatShimUsed: true,
      source: "canonical",
    });
  });

  test("preserves nested canonical checkStatusUrl from wrapped relay responses", () => {
    const result = extractCanonicalPaymentDetails({
      details: {
        canonical: {
          paymentId: "pay_nested",
          status: "submitted",
          checkStatusUrl: "https://relay.example/status/pay_nested",
        },
      },
    });

    expect(result).toEqual({
      paymentId: "pay_nested",
      status: "queued",
      retryable: undefined,
      error: undefined,
      errorCode: undefined,
      checkStatusUrl: "https://relay.example/status/pay_nested",
      txid: undefined,
      terminalReason: undefined,
      compatShimUsed: true,
      source: "canonical",
    });
  });

  test("infers terminal state from canonical terminalReason when needed", () => {
    const result = getRetryDecisionContext({
      paymentId: "pay_failed",
      terminalReason: "queue_unavailable",
      retryable: true,
    });

    expect(result).toEqual({
      paymentId: "pay_failed",
      status: "failed",
      terminalReason: "queue_unavailable",
      retryable: true,
      compatShimUsed: true,
      source: "inferred",
    });
  });

  test("preserves checkStatusUrl when inferring terminal state from nested canonical terminalReason", () => {
    const result = extractCanonicalPaymentDetails({
      details: {
        canonical: {
          paymentId: "pay_poll",
          terminalReason: "queue_unavailable",
          checkStatusUrl: "https://relay.example/status/pay_poll",
          retryable: true,
        },
      },
    });

    expect(result).toEqual({
      paymentId: "pay_poll",
      status: "failed",
      terminalReason: "queue_unavailable",
      retryable: undefined,
      error: undefined,
      errorCode: undefined,
      checkStatusUrl: "https://relay.example/status/pay_poll",
      txid: undefined,
      compatShimUsed: true,
      source: "inferred",
    });
  });

  test("maps legacy client_bad_nonce relay details to sender rebuild semantics", () => {
    const result = getRetryDecisionContext({
      details: {
        errorReason: "client_bad_nonce",
      },
    });

    expect(result).toEqual({
      paymentId: undefined,
      status: "failed",
      terminalReason: "sender_nonce_duplicate",
      retryable: undefined,
      compatShimUsed: true,
      source: "inferred",
    });
  });

  test("maps legacy conflicting_nonce relay details to sender rebuild semantics", () => {
    const result = getRetryDecisionContext({
      details: {
        errorReason: "conflicting_nonce",
      },
    });

    expect(result).toEqual({
      paymentId: undefined,
      status: "failed",
      terminalReason: "sender_nonce_duplicate",
      retryable: undefined,
      compatShimUsed: true,
      source: "inferred",
    });
  });

  test("marks legacy terminal inference as compat shim usage", () => {
    const result = extractCanonicalPaymentDetails({
      details: {
        errorReason: "transaction_failed",
      },
    });

    expect(result).toEqual({
      paymentId: undefined,
      status: "failed",
      terminalReason: "invalid_transaction",
      retryable: undefined,
      error: undefined,
      errorCode: undefined,
      checkStatusUrl: undefined,
      txid: undefined,
      compatShimUsed: true,
      source: "inferred",
    });
  });

  test("keeps sender rebuild reasons separate from relay-owned retries", () => {
    expect(isSenderRebuildTerminalReason("sender_nonce_stale")).toBe(true);
    expect(isSenderRebuildTerminalReason("sender_nonce_gap")).toBe(true);
    expect(isSenderRebuildTerminalReason("sender_nonce_duplicate")).toBe(true);
    expect(isSenderRebuildTerminalReason("queue_unavailable")).toBe(false);

    expect(isRelayRetryableTerminalReason("queue_unavailable")).toBe(true);
    expect(isRelayRetryableTerminalReason("sponsor_failure")).toBe(true);
    expect(isRelayRetryableTerminalReason("broadcast_failure")).toBe(true);
    expect(isRelayRetryableTerminalReason("internal_error")).toBe(true);
    expect(isRelayRetryableTerminalReason("sender_nonce_stale")).toBe(false);
  });

  test("recognizes public in-flight states only", () => {
    expect(isInFlightPaymentState("queued")).toBe(true);
    expect(isInFlightPaymentState("broadcasting")).toBe(true);
    expect(isInFlightPaymentState("mempool")).toBe(true);
    expect(isInFlightPaymentState("submitted")).toBe(false);
    expect(isInFlightPaymentState("confirmed")).toBe(false);
  });
});
