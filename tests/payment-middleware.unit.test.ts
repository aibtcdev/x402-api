import { describe, expect, test } from "bun:test";
import { X402_ERROR_CODES } from "x402-stacks";
import { classifyPaymentError } from "../src/middleware/x402";

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
