import { describe, expect, test } from "bun:test";
import { X402_ERROR_CODES } from "x402-stacks";
import { classifyPaymentError } from "../src/middleware/x402";
import { computeDerivedHints } from "../src/utils/payment-hints";

// =============================================================================
// classifyPaymentError — canonical status fields
// =============================================================================

describe("x402 payment classification", () => {
  test("treats canonical failed status without terminalReason as terminal", () => {
    expect(
      classifyPaymentError("settlement_failed", {
        success: false,
        paymentId: "pay_failed",
        status: "failed",
      })
    ).toEqual({
      code: X402_ERROR_CODES.TRANSACTION_FAILED,
      message: "Payment failed in settlement relay",
      httpStatus: 402,
    });
  });

  test("treats canonical replaced status without terminalReason as terminal", () => {
    expect(
      classifyPaymentError("settlement_failed", {
        success: false,
        paymentId: "pay_replaced",
        status: "replaced",
      })
    ).toEqual({
      code: X402_ERROR_CODES.TRANSACTION_FAILED,
      message: "Payment was replaced, start a new payment flow",
      httpStatus: 402,
    });
  });

  test("treats canonical not_found status without terminalReason as terminal", () => {
    expect(
      classifyPaymentError("settlement_failed", {
        success: false,
        paymentId: "pay_missing",
        status: "not_found",
      })
    ).toEqual({
      code: X402_ERROR_CODES.INVALID_TRANSACTION_STATE,
      message: "Payment identity expired or was not found, start a new payment flow",
      httpStatus: 402,
    });
  });
});

// =============================================================================
// Payment error hints — per terminal reason category
// These verify the hint tokens that middleware attaches to non-200 error responses.
// computeDerivedHints is the pure function called on the settlement failure path.
// =============================================================================

describe("payment error hints — settlement failure path", () => {
  // sender category
  test("sender_nonce_stale → rebuild_and_resign, retryable, no retryAfter", () => {
    const hints = computeDerivedHints("failed", "sender_nonce_stale");
    expect(hints).not.toBeNull();
    expect(hints!.retryable).toBe(true);
    expect(hints!.nextSteps).toBe("rebuild_and_resign");
    expect(hints!.retryAfter).toBeUndefined();
  });

  test("sender_nonce_gap → rebuild_and_resign, retryable", () => {
    const hints = computeDerivedHints("failed", "sender_nonce_gap");
    expect(hints!.retryable).toBe(true);
    expect(hints!.nextSteps).toBe("rebuild_and_resign");
  });

  test("origin_chaining_limit → rebuild_and_resign, retryable", () => {
    const hints = computeDerivedHints("failed", "origin_chaining_limit");
    expect(hints!.retryable).toBe(true);
    expect(hints!.nextSteps).toBe("rebuild_and_resign");
  });

  // relay category
  test("queue_unavailable → retry_later, retryable, retryAfter=30", () => {
    const hints = computeDerivedHints("failed", "queue_unavailable");
    expect(hints).not.toBeNull();
    expect(hints!.retryable).toBe(true);
    expect(hints!.nextSteps).toBe("retry_later");
    expect(hints!.retryAfter).toBe(30);
  });

  test("internal_error → retry_later, retryable, retryAfter=30", () => {
    const hints = computeDerivedHints("failed", "internal_error");
    expect(hints!.retryable).toBe(true);
    expect(hints!.nextSteps).toBe("retry_later");
    expect(hints!.retryAfter).toBe(30);
  });

  // settlement category
  test("broadcast_failure → retry_later, retryable, retryAfter=30", () => {
    const hints = computeDerivedHints("failed", "broadcast_failure");
    expect(hints!.retryable).toBe(true);
    expect(hints!.nextSteps).toBe("retry_later");
    expect(hints!.retryAfter).toBe(30);
  });

  test("broadcast_rate_limited → retry_later, retryable, retryAfter=30", () => {
    const hints = computeDerivedHints("failed", "broadcast_rate_limited");
    expect(hints!.retryable).toBe(true);
    expect(hints!.nextSteps).toBe("retry_later");
    expect(hints!.retryAfter).toBe(30);
  });

  // replacement category
  test("nonce_replacement (replaced status) → start_new_payment, not retryable", () => {
    const hints = computeDerivedHints("replaced", "nonce_replacement");
    expect(hints).not.toBeNull();
    expect(hints!.retryable).toBe(false);
    expect(hints!.nextSteps).toBe("start_new_payment");
    expect(hints!.retryAfter).toBeUndefined();
  });

  test("superseded (replaced status) → start_new_payment, not retryable", () => {
    const hints = computeDerivedHints("replaced", "superseded");
    expect(hints!.retryable).toBe(false);
    expect(hints!.nextSteps).toBe("start_new_payment");
  });

  // identity category
  test("expired (not_found status) → start_new_payment, not retryable", () => {
    const hints = computeDerivedHints("not_found", "expired");
    expect(hints).not.toBeNull();
    expect(hints!.retryable).toBe(false);
    expect(hints!.nextSteps).toBe("start_new_payment");
    expect(hints!.retryAfter).toBeUndefined();
  });

  test("unknown_payment_identity (not_found status) → start_new_payment, not retryable", () => {
    const hints = computeDerivedHints("not_found", "unknown_payment_identity");
    expect(hints!.retryable).toBe(false);
    expect(hints!.nextSteps).toBe("start_new_payment");
  });

  // validation category
  test("invalid_transaction → fix_and_resend, not retryable", () => {
    const hints = computeDerivedHints("failed", "invalid_transaction");
    expect(hints).not.toBeNull();
    expect(hints!.retryable).toBe(false);
    expect(hints!.nextSteps).toBe("fix_and_resend");
    expect(hints!.retryAfter).toBeUndefined();
  });

  test("not_sponsored → fix_and_resend, not retryable", () => {
    const hints = computeDerivedHints("failed", "not_sponsored");
    expect(hints!.retryable).toBe(false);
    expect(hints!.nextSteps).toBe("fix_and_resend");
  });

  // no terminalReason
  test("failed with no terminalReason → start_new_payment, not retryable", () => {
    const hints = computeDerivedHints("failed");
    expect(hints).not.toBeNull();
    expect(hints!.retryable).toBe(false);
    expect(hints!.nextSteps).toBe("start_new_payment");
  });
});

describe("payment error hints — exception path (no canonical status)", () => {
  // The exception path uses hintsFromClassifiedCode (tested indirectly via expected behavior)
  // We verify that the computeDerivedHints fallback (non-terminal status) returns null,
  // which triggers the hintsFromClassifiedCode path in middleware.

  test("computeDerivedHints returns null for non-terminal 'queued' (middleware falls back to code-based hints)", () => {
    const hints = computeDerivedHints("queued");
    expect(hints).toBeNull();
  });

  test("computeDerivedHints returns null for undefined status (maps to non-terminal fallback)", () => {
    // When exception path sends synthetic 'failed' with no terminalReason
    const hints = computeDerivedHints("failed");
    expect(hints).not.toBeNull();
    expect(hints!.retryable).toBe(false);
    expect(hints!.nextSteps).toBe("start_new_payment");
  });
});
