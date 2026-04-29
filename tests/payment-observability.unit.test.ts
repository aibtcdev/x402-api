import { describe, expect, test } from "bun:test";
import {
  buildPaymentLogFields,
  derivePaymentInstability,
  PAYMENT_LOG_MIDDLEWARE,
  PAYMENT_LOG_SERVICE,
  PAYMENT_REPO_VERSION,
} from "../src/utils/payment-observability";

describe("payment observability helpers", () => {
  test("builds shared structured payment log fields", () => {
    expect(
      buildPaymentLogFields(
        {
          route: "/hashing/sha256",
          paymentId: "pay_123",
          status: "queued",
          terminalReason: "queue_unavailable",
          action: "reuse_same_payment",
          checkStatusUrl: "https://relay.example/status/pay_123",
        },
        { classification_code: "transaction_pending" }
      )
    ).toEqual({
      service: PAYMENT_LOG_SERVICE,
      route: "/hashing/sha256",
      middleware: PAYMENT_LOG_MIDDLEWARE,
      paymentId: "pay_123",
      status: "queued",
      terminalReason: "queue_unavailable",
      action: "reuse_same_payment",
      checkStatusUrl_present: true,
      repo_version: PAYMENT_REPO_VERSION,
      classification_code: "transaction_pending",
    });
  });

  test("uses canonical pre-payment status names in structured logs", () => {
    expect(
      buildPaymentLogFields({
        route: "/hashing/sha256",
        status: "requires_payment",
        action: "return_402",
      })
    ).toMatchObject({
      status: "requires_payment",
      action: "return_402",
    });
  });

  test("classifies nonce and fee estimation instability explicitly", () => {
    expect(
      derivePaymentInstability({
        errorReason: "conflicting_nonce",
      })
    ).toBe("nonce_conflict");

    expect(
      derivePaymentInstability({
        error: "fallback pricing table used after fee refresh timeout",
      })
    ).toBe("fee_estimation_issue");
  });

  test("classifies relay and settlement instability correctly", () => {
    expect(
      derivePaymentInstability({
        terminalReason: "queue_unavailable",
      })
    ).toBe("relay_failure");

    expect(
      derivePaymentInstability({
        terminalReason: "broadcast_failure",
      })
    ).toBe("relay_failure");

    expect(
      derivePaymentInstability({
        terminalReason: "invalid_transaction",
      })
    ).toBe("invalid_transaction_state");
  });
});
