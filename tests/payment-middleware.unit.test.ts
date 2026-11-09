import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { X402_ERROR_CODES, X402_HEADERS, X402PaymentVerifier } from "x402-stacks";
import {
  makeSTXTokenTransfer,
  privateKeyToAddress,
} from "@stacks/transactions";
import {
  classifyPaymentError,
  deriveRequestCorrelationId,
  extractCheckStatusUrl,
  extractVerifiedTransactionOrigin,
  x402Middleware,
} from "../src/middleware/x402";
import { computeDerivedHints } from "../src/utils/payment-hints";
import type { AppVariables, Env, Logger, RelayRPC } from "../src/types";

// =============================================================================
// Test Helpers
// =============================================================================

const TEST_SELLER_ADDRESS = "ST37NMC4HGFQ1H2JSFP4H3TMNQBF4PY0MVSD1GV7Z";
const TEST_BUYER_PRIVKEY =
  "753b7cc01a1a2e86221266a154af739463fce51219d97e4f856cd7200c3bd2a601";
const TEST_ATTACKER_PRIVKEY =
  "f9d7206a47f14d2870c163eb66b6b33a90e24472c5e641e2715a4b4f3a818f4001";
const TEST_BUYER_ADDRESS = privateKeyToAddress(TEST_BUYER_PRIVKEY, "testnet");

async function buildSignedTxHex(options: {
  sponsored: boolean;
  senderKey?: string;
  nonce?: bigint;
}): Promise<string> {
  const tx = await makeSTXTokenTransfer({
    recipient: TEST_SELLER_ADDRESS,
    amount: 1000n,
    senderKey: options.senderKey ?? TEST_BUYER_PRIVKEY,
    network: "testnet",
    memo: "x402-test",
    nonce: options.nonce ?? 1n,
    fee: 200n,
    sponsored: options.sponsored,
  });
  return tx.serialize();
}

function encodePaymentSignature(payload: Record<string, unknown>): string {
  return btoa(JSON.stringify(payload));
}

function createTestHarness(relay?: RelayRPC) {
  const events: Array<{ level: string; message: string; data?: Record<string, unknown> }> = [];
  const trackedPayments: Array<Record<string, unknown>> = [];
  let handlerCount = 0;
  let lastContextPayer: string | undefined;
  let lastContextTxid: string | undefined;
  let lastContextPaymentId: string | undefined;
  let lastContextCorrelationId: string | undefined;

  const logger: Logger = {
    debug(message, data) {
      events.push({ level: "debug", message, data });
    },
    info(message, data) {
      events.push({ level: "info", message, data });
    },
    warn(message, data) {
      events.push({ level: "warn", message, data });
    },
    error(message, data) {
      events.push({ level: "error", message, data });
    },
    child() {
      return logger;
    },
  };

  const env = {
    ENVIRONMENT: "staging",
    X402_FACILITATOR_URL: "https://facilitator.example",
    X402_NETWORK: "testnet",
    X402_SERVER_ADDRESS: TEST_SELLER_ADDRESS,
    X402_RELAY: relay,
    PAYMENT_POLLING_DO: {
      idFromName(name: string) {
        return name as unknown as DurableObjectId;
      },
      get(id: DurableObjectId) {
        return {
          async track(input: Record<string, unknown>) {
            trackedPayments.push({ doId: String(id), ...input });
          },
        };
      },
    },
  } as unknown as Env;

  const app = new Hono<{ Bindings: Env; Variables: AppVariables }>();
  app.use("*", async (c, next) => {
    c.set("requestId", "req-test");
    c.set("logger", logger);
    await next();
  });
  app.post(
    "/paid",
    x402Middleware({ tier: "standard", rpcPollMaxAttempts: 1, rpcPollIntervalMs: 0 }),
    (c) => {
      handlerCount += 1;
      const ctx = c.get("x402");
      lastContextPayer = ctx?.payerAddress;
      lastContextTxid = ctx?.settleResult.transaction;
      lastContextPaymentId = ctx?.paymentId;
      lastContextCorrelationId = ctx?.requestCorrelationId;
      return c.json({
        ok: true,
        payer: ctx?.payerAddress,
        txid: ctx?.settleResult.transaction,
        paymentId: ctx?.paymentId,
        requestCorrelationId: ctx?.requestCorrelationId,
      });
    }
  );

  return {
    app,
    env,
    events,
    trackedPayments,
    getHandlerCount: () => handlerCount,
    getLastContext: () => ({
      payer: lastContextPayer,
      txid: lastContextTxid,
      paymentId: lastContextPaymentId,
      requestCorrelationId: lastContextCorrelationId,
    }),
  };
}

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
// =============================================================================

describe("payment error hints — settlement failure path", () => {
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

  test("failed with no terminalReason → start_new_payment, not retryable", () => {
    const hints = computeDerivedHints("failed");
    expect(hints).not.toBeNull();
    expect(hints!.retryable).toBe(false);
    expect(hints!.nextSteps).toBe("start_new_payment");
  });
});

describe("payment error hints — exception path (no canonical status)", () => {
  test("computeDerivedHints returns null for non-terminal 'queued' (middleware falls back to code-based hints)", () => {
    const hints = computeDerivedHints("queued");
    expect(hints).toBeNull();
  });

  test("computeDerivedHints returns null for undefined status (maps to non-terminal fallback)", () => {
    const hints = computeDerivedHints("failed");
    expect(hints).not.toBeNull();
    expect(hints!.retryable).toBe(false);
    expect(hints!.nextSteps).toBe("start_new_payment");
  });
});

// =============================================================================
// RPC Service Binding Settlement & Regression Suite (#87 / #150)
// =============================================================================

describe("x402Middleware — RPC enqueue vs confirmed settlement, relay ID recovery, payer origin & non-sponsored compatibility", () => {
  test("treats RPC enqueue (queued and queued_with_warning) as pending: uses canonical relay ID/URL, emits no payment.confirmed, and does not invoke paid handler", async () => {
    for (const enqueueStatus of ["queued", "queued_with_warning"] as const) {
      const txHex = await buildSignedTxHex({ sponsored: true, nonce: enqueueStatus === "queued" ? 10n : 11n });
      const relayId = `pay_relay_${enqueueStatus}`;
      const relayUrl = `https://relay.example/payment/${relayId}`;
      const checkedIds: string[] = [];

      const relay: RelayRPC = {
        async submitPayment(_tx, _settle, correlationId) {
          expect(correlationId).not.toBe(relayId);
          return {
            accepted: true,
            status: enqueueStatus,
            paymentId: relayId,
            checkStatusUrl: relayUrl,
          };
        },
        async checkPayment(paymentId) {
          checkedIds.push(paymentId);
          return {
            paymentId,
            status: enqueueStatus,
            checkStatusUrl: relayUrl,
          };
        },
      };

      const harness = createTestHarness(relay);
      const res = await harness.app.request(
        "http://localhost/paid",
        {
          method: "POST",
          headers: {
            [X402_HEADERS.PAYMENT_SIGNATURE]: encodePaymentSignature({
              x402Version: 2,
              payload: { transaction: txHex },
            }),
          },
        },
        harness.env
      );

      expect(res.status).toBe(402);
      expect(harness.getHandlerCount()).toBe(0);
      expect(res.headers.get("X-PAYMENT-ID")).toBe(relayId);
      expect(checkedIds).toEqual([relayId]);

      const body = (await res.json()) as Record<string, unknown>;
      expect(body.code).toBe(X402_ERROR_CODES.TRANSACTION_PENDING);
      expect(body.paymentId).toBe(relayId);
      expect(body.checkStatusUrl).toBe(relayUrl);
      expect(body.requestCorrelationId).not.toBe(relayId);

      // DO tracking must record canonical relay ID and relay checkStatusUrl
      expect(harness.trackedPayments.length).toBe(1);
      expect(harness.trackedPayments[0].paymentId).toBe(relayId);
      expect(harness.trackedPayments[0].checkStatusUrl).toBe(relayUrl);

      // Must emit payment.pending and NEVER payment.confirmed
      const confirmedEvents = harness.events.filter((e) => e.message === "payment.confirmed");
      const pendingEvents = harness.events.filter((e) => e.message === "payment.pending");
      expect(confirmedEvents.length).toBe(0);
      expect(pendingEvents.length).toBe(1);
      expect(pendingEvents[0].data?.paymentId).toBe(relayId);
    }
  });

  test("recovers queued → confirmed using canonical relay paymentId and keeps correlation key, relay paymentId, and confirmed txid separate", async () => {
    const txHex = await buildSignedTxHex({ sponsored: true, nonce: 21n });
    const relayId = "pay_relay_canonical_21";
    const relayUrl = "https://relay.example/payment/pay_relay_canonical_21";
    const confirmedTxid = "0x9f8e7d6c5b4a392817263544556677889900aabbccddeeff0011223344556677";

    let submitCount = 0;
    const checkCalls: string[] = [];

    const relay: RelayRPC = {
      async submitPayment() {
        submitCount += 1;
        return {
          accepted: true,
          status: "queued",
          paymentId: relayId,
          checkStatusUrl: relayUrl,
        };
      },
      async checkPayment(paymentId) {
        checkCalls.push(paymentId);
        if (checkCalls.length === 1) {
          return {
            paymentId: relayId,
            status: "queued",
            checkStatusUrl: relayUrl,
          };
        }
        return {
          paymentId: relayId,
          status: "confirmed",
          txid: confirmedTxid,
          confirmedAt: "2026-11-09T11:00:00.000Z",
          checkStatusUrl: relayUrl,
        };
      },
    };

    const harness = createTestHarness(relay);
    const sigHeader = encodePaymentSignature({
      x402Version: 2,
      payload: { transaction: txHex },
    });

    // Request 1: Enqueued and still queued on first check → 402 pending
    const res1 = await harness.app.request(
      "http://localhost/paid",
      {
        method: "POST",
        headers: { [X402_HEADERS.PAYMENT_SIGNATURE]: sigHeader },
      },
      harness.env
    );
    expect(res1.status).toBe(402);
    expect(harness.getHandlerCount()).toBe(0);
    expect(res1.headers.get("X-PAYMENT-ID")).toBe(relayId);

    // Request 2: Recovery checks canonical relayId (without re-submitting) and settles as confirmed
    const res2 = await harness.app.request(
      "http://localhost/paid",
      {
        method: "POST",
        headers: { [X402_HEADERS.PAYMENT_SIGNATURE]: sigHeader },
      },
      harness.env
    );
    expect(res2.status).toBe(200);
    expect(harness.getHandlerCount()).toBe(1);
    expect(submitCount).toBe(1);
    expect(checkCalls).toEqual([relayId, relayId]);

    const body2 = (await res2.json()) as Record<string, unknown>;
    expect(body2.ok).toBe(true);
    expect(body2.payer).toBe(TEST_BUYER_ADDRESS);
    expect(body2.txid).toBe(confirmedTxid);
    expect(body2.paymentId).toBe(relayId);
    expect(body2.requestCorrelationId).not.toBe(relayId);
    expect(body2.requestCorrelationId).not.toBe(confirmedTxid);
    expect(res2.headers.get("X-PAYMENT-ID")).toBe(relayId);
    expect(res2.headers.get("X-PAYER-ADDRESS")).toBe(TEST_BUYER_ADDRESS);
  });

  test("enforces verified transaction origin payer control (omitting or spoofing outer payer never overrides signer; recovery rejects caller payer changes)", async () => {
    const buyerTxHex = await buildSignedTxHex({ sponsored: true, nonce: 31n });
    const attackerTxHex = await buildSignedTxHex({
      sponsored: true,
      senderKey: TEST_ATTACKER_PRIVKEY,
      nonce: 31n,
    });
    const relayId = "pay_relay_payer_control";
    const confirmedTxid = "0x1111222233334444555566667777888899990000aaaabbbbccccddddeeeeffff";

    let checkAttempt = 0;
    const relay: RelayRPC = {
      async submitPayment() {
        return {
          accepted: true,
          status: "queued",
          paymentId: relayId,
          checkStatusUrl: `https://relay.example/payment/${relayId}`,
        };
      },
      async checkPayment() {
        checkAttempt += 1;
        if (checkAttempt === 1) {
          return { paymentId: relayId, status: "queued" };
        }
        return {
          paymentId: relayId,
          status: "confirmed",
          txid: confirmedTxid,
        };
      },
    };

    const harness = createTestHarness(relay);

    // Step 1: Enqueue with outer payer omitted
    const enqueueRes = await harness.app.request(
      "http://localhost/paid",
      {
        method: "POST",
        headers: {
          [X402_HEADERS.PAYMENT_SIGNATURE]: encodePaymentSignature({
            x402Version: 2,
            payload: { transaction: buyerTxHex },
          }),
        },
      },
      harness.env
    );
    expect(enqueueRes.status).toBe(402);

    // Step 2: Different caller/signer tries to hijack recovery of relayId → rejected with 400 SENDER_MISMATCH
    const hijackRes = await harness.app.request(
      "http://localhost/paid",
      {
        method: "POST",
        headers: {
          "X-PAYMENT-ID": relayId,
          [X402_HEADERS.PAYMENT_SIGNATURE]: encodePaymentSignature({
            x402Version: 2,
            payer: "SP000000000000000000002Q6VF78",
            payload: { transaction: attackerTxHex },
          }),
        },
      },
      harness.env
    );
    expect(hijackRes.status).toBe(400);
    const hijackBody = (await hijackRes.json()) as Record<string, unknown>;
    expect(hijackBody.code).toBe(X402_ERROR_CODES.SENDER_MISMATCH);
    expect(harness.getHandlerCount()).toBe(0);

    // Step 3: Original transaction recovers with spoofed unsigned outer `payer` field → handler still receives verified buyer address
    const confirmRes = await harness.app.request(
      "http://localhost/paid",
      {
        method: "POST",
        headers: {
          [X402_HEADERS.PAYMENT_SIGNATURE]: encodePaymentSignature({
            x402Version: 2,
            payer: "SP_SPOOFED_UNSIGNED_PAYER",
            payload: { transaction: buyerTxHex },
          }),
        },
      },
      harness.env
    );
    expect(confirmRes.status).toBe(200);
    expect(harness.getHandlerCount()).toBe(1);
    expect(harness.getLastContext().payer).toBe(TEST_BUYER_ADDRESS);
    expect(harness.getLastContext().payer).not.toBe(TEST_SELLER_ADDRESS);
    expect(harness.getLastContext().payer).not.toBe("SP_SPOOFED_UNSIGNED_PAYER");
    expect(harness.getLastContext().txid).toBe(confirmedTxid);
  });

  test("timeout after enqueue returns pending with relay paymentId and performs zero HTTP /settle resubmit", async () => {
    const txHex = await buildSignedTxHex({ sponsored: true, nonce: 41n });
    const relayId = "pay_relay_timeout_41";
    const relayUrl = `https://relay.example/payment/${relayId}`;

    let httpSettleCalls = 0;
    const origSettle = X402PaymentVerifier.prototype.settle;
    X402PaymentVerifier.prototype.settle = async function () {
      httpSettleCalls += 1;
      throw new Error("HTTP settle should not be called after RPC enqueue");
    };

    try {
      const relay: RelayRPC = {
        async submitPayment() {
          return {
            accepted: true,
            status: "queued",
            paymentId: relayId,
            checkStatusUrl: relayUrl,
          };
        },
        async checkPayment() {
          const timeoutErr = new Error("checkPayment timed out after enqueue");
          timeoutErr.name = "TimeoutError";
          throw timeoutErr;
        },
      };

      const harness = createTestHarness(relay);
      const res = await harness.app.request(
        "http://localhost/paid",
        {
          method: "POST",
          headers: {
            [X402_HEADERS.PAYMENT_SIGNATURE]: encodePaymentSignature({
              x402Version: 2,
              payload: { transaction: txHex },
            }),
          },
        },
        harness.env
      );

      expect(res.status).toBe(402);
      expect(httpSettleCalls).toBe(0);
      expect(harness.getHandlerCount()).toBe(0);
      expect(res.headers.get("X-PAYMENT-ID")).toBe(relayId);

      const body = (await res.json()) as Record<string, unknown>;
      expect(body.code).toBe(X402_ERROR_CODES.TRANSACTION_PENDING);
      expect(body.paymentId).toBe(relayId);
      expect(body.checkStatusUrl).toBe(relayUrl);
    } finally {
      X402PaymentVerifier.prototype.settle = origSettle;
    }
  });

  test("supports explicit non-sponsored quote compatibility when RPC returns NOT_SPONSORED, while refusing other RPC rejections without fallback", async () => {
    const standardTxHex = await buildSignedTxHex({ sponsored: false, nonce: 51n });
    const sponsoredTxHex = await buildSignedTxHex({ sponsored: true, nonce: 52n });
    const verifiedTxid = "0xabcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789";

    let httpSettleCalls = 0;
    const origSettle = X402PaymentVerifier.prototype.settle;
    X402PaymentVerifier.prototype.settle = async function () {
      httpSettleCalls += 1;
      return {
        success: true,
        transaction: verifiedTxid,
        payer: TEST_BUYER_ADDRESS,
        network: "stacks:2147483648",
      } as never;
    };

    try {
      const relay: RelayRPC = {
        async submitPayment(txHex) {
          const origin = extractVerifiedTransactionOrigin(txHex, "testnet");
          if (origin && origin.authType !== 5) {
            return {
              accepted: false,
              code: "NOT_SPONSORED",
              error: "Transaction must be sponsored (build with sponsored: true)",
              retryable: false,
            };
          }
          return {
            accepted: false,
            code: "INVALID_TRANSACTION",
            error: "Post-condition check failed",
            retryable: false,
          };
        },
        async checkPayment(paymentId) {
          return { paymentId, status: "failed" };
        },
      };

      const harness = createTestHarness(relay);

      // 1. Non-sponsored transaction built from existing non-sponsored quote → falls back to HTTP verifier.settle and executes handler
      const compatRes = await harness.app.request(
        "http://localhost/paid",
        {
          method: "POST",
          headers: {
            [X402_HEADERS.PAYMENT_SIGNATURE]: encodePaymentSignature({
              x402Version: 2,
              payload: { transaction: standardTxHex },
            }),
          },
        },
        harness.env
      );
      expect(compatRes.status).toBe(200);
      expect(httpSettleCalls).toBe(1);
      expect(harness.getHandlerCount()).toBe(1);
      expect(harness.getLastContext().payer).toBe(TEST_BUYER_ADDRESS);
      expect(harness.getLastContext().txid).toBe(verifiedTxid);

      // 2. Explicit RPC refusal (INVALID_TRANSACTION) → does NOT fall through to HTTP settle and does NOT execute handler
      const refusedRes = await harness.app.request(
        "http://localhost/paid",
        {
          method: "POST",
          headers: {
            [X402_HEADERS.PAYMENT_SIGNATURE]: encodePaymentSignature({
              x402Version: 2,
              payload: { transaction: sponsoredTxHex },
            }),
          },
        },
        harness.env
      );
      expect(refusedRes.status).toBe(402);
      expect(httpSettleCalls).toBe(1);
      expect(harness.getHandlerCount()).toBe(1);
    } finally {
      X402PaymentVerifier.prototype.settle = origSettle;
    }
  });

  test("extractCheckStatusUrl prefers top-level checkStatusUrl before extensions and fallback", async () => {
    const corr = await deriveRequestCorrelationId("deadbeef", TEST_SELLER_ADDRESS, "1000", "STX");
    expect(corr.startsWith("pay_")).toBe(true);
    expect(
      extractCheckStatusUrl(
        { checkStatusUrl: "https://relay.example/custom/pay_relay_99" },
        "https://facilitator.example",
        "pay_relay_99"
      )
    ).toBe("https://relay.example/custom/pay_relay_99");
  });

  test("refuses replay of an identical payment-signature header after confirmation on both the same middleware instance and a fresh instance with cached accepted relay response", async () => {
    const txHex = await buildSignedTxHex({ sponsored: true, nonce: 61n });
    const relayId = "pay_relay_no_replay_61";
    const confirmedTxid = "0x6161616161616161616161616161616161616161616161616161616161616161";

    const relay: RelayRPC = {
      async submitPayment() {
        return {
          accepted: true,
          status: "queued",
          paymentId: relayId,
          checkStatusUrl: `https://relay.example/payment/${relayId}`,
        };
      },
      async checkPayment() {
        return {
          paymentId: relayId,
          status: "confirmed",
          txid: confirmedTxid,
        };
      },
    };

    const sigHeader = encodePaymentSignature({
      x402Version: 2,
      payload: { transaction: txHex },
    });

    const harness1 = createTestHarness(relay);

    // First call settles and serves once
    const firstRes = await harness1.app.request(
      "http://localhost/paid",
      {
        method: "POST",
        headers: { [X402_HEADERS.PAYMENT_SIGNATURE]: sigHeader },
      },
      harness1.env
    );
    expect(firstRes.status).toBe(200);
    expect(harness1.getHandlerCount()).toBe(1);

    // Replay on the same middleware instance → refused (402), no second handler call
    const replaySameRes = await harness1.app.request(
      "http://localhost/paid",
      {
        method: "POST",
        headers: { [X402_HEADERS.PAYMENT_SIGNATURE]: sigHeader },
      },
      harness1.env
    );
    expect(replaySameRes.status).toBe(402);
    expect(harness1.getHandlerCount()).toBe(1);

    // Replay on a fresh middleware instance with a relay stub returning cached accepted → refused (402), zero handler calls
    const cachedRelayStub: RelayRPC = {
      async submitPayment() {
        return {
          accepted: true,
          status: "queued",
          paymentId: relayId,
          checkStatusUrl: `https://relay.example/payment/${relayId}`,
        };
      },
      async checkPayment() {
        return {
          paymentId: relayId,
          status: "confirmed",
          txid: confirmedTxid,
        };
      },
    };
    const harness2 = createTestHarness(cachedRelayStub);
    const replayFreshRes = await harness2.app.request(
      "http://localhost/paid",
      {
        method: "POST",
        headers: { [X402_HEADERS.PAYMENT_SIGNATURE]: sigHeader },
      },
      harness2.env
    );
    expect(replayFreshRes.status).toBe(402);
    expect(harness2.getHandlerCount()).toBe(0);
  });

  test("refuses X-PAYMENT-ID recovery when current request paymentRequirements.amount is higher than the enqueued payment", async () => {
    const txHex = await buildSignedTxHex({ sponsored: true, nonce: 62n });
    const relayId = "pay_relay_price_upgrade_62";
    const confirmedTxid = "0x6262626262626262626262626262626262626262626262626262626262626262";

    let checkCalls = 0;
    const relay: RelayRPC = {
      async submitPayment() {
        return {
          accepted: true,
          status: "queued",
          paymentId: relayId,
          checkStatusUrl: `https://relay.example/payment/${relayId}`,
        };
      },
      async checkPayment() {
        checkCalls += 1;
        if (checkCalls === 1) {
          return { paymentId: relayId, status: "queued" };
        }
        return {
          paymentId: relayId,
          status: "confirmed",
          txid: confirmedTxid,
        };
      },
    };

    let handlerCount = 0;
    const logger: Logger = {
      debug() {},
      info() {},
      warn() {},
      error() {},
      child() {
        return logger;
      },
    };
    const env = {
      ENVIRONMENT: "staging",
      X402_FACILITATOR_URL: "https://facilitator.example",
      X402_NETWORK: "testnet",
      X402_SERVER_ADDRESS: TEST_SELLER_ADDRESS,
      X402_RELAY: relay,
      PAYMENT_POLLING_DO: {
        idFromName(name: string) {
          return name as unknown as DurableObjectId;
        },
        get() {
          return { async track() {} };
        },
      },
    } as unknown as Env;

    const app = new Hono<{ Bindings: Env; Variables: AppVariables }>();
    app.use("*", async (c, next) => {
      c.set("requestId", "req-dynamic");
      c.set("logger", logger);
      await next();
    });
    app.post(
      "/dynamic-paid",
      x402Middleware({
        dynamic: true,
        rpcPollMaxAttempts: 1,
        rpcPollIntervalMs: 0,
        estimator(body) {
          const units = Number((body as { units?: number })?.units ?? 1);
          return {
            estimatedCostUsd: 0.001 * units,
            costWithMarginUsd: 0.0012 * units,
            amountInToken: BigInt(1000 * units),
            tokenType: "STX",
            tier: "dynamic",
          };
        },
      }),
      (c) => {
        handlerCount += 1;
        return c.json({ ok: true });
      }
    );

    const sigHeader = encodePaymentSignature({
      x402Version: 2,
      payload: { transaction: txHex },
    });

    // Step 1: Enqueue against cheap prompt (1000 microSTX) → 402 pending
    const enqueueRes = await app.request(
      "http://localhost/dynamic-paid",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          [X402_HEADERS.PAYMENT_SIGNATURE]: sigHeader,
        },
        body: JSON.stringify({ units: 1 }),
      },
      env
    );
    expect(enqueueRes.status).toBe(402);
    expect(handlerCount).toBe(0);

    // Step 2: Attempt to recover with X-PAYMENT-ID on an expensive prompt (5000 microSTX) → rejected with 402 AMOUNT_INSUFFICIENT
    const upgradeRes = await app.request(
      "http://localhost/dynamic-paid",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-PAYMENT-ID": relayId,
          [X402_HEADERS.PAYMENT_SIGNATURE]: sigHeader,
        },
        body: JSON.stringify({ units: 5 }),
      },
      env
    );
    expect(upgradeRes.status).toBe(402);
    const upgradeBody = (await upgradeRes.json()) as Record<string, unknown>;
    expect(upgradeBody.code).toBe(X402_ERROR_CODES.AMOUNT_INSUFFICIENT);
    expect(handlerCount).toBe(0);
  });

  test("preserves rpcResult.retryable on transient unmapped RPC rejection", async () => {
    const txHex = await buildSignedTxHex({ sponsored: true, nonce: 63n });
    const relay: RelayRPC = {
      async submitPayment() {
        return {
          accepted: false,
          code: "TEMPORARY_UPSTREAM_BACKPRESSURE",
          error: "Relay queue temporarily saturated",
          retryable: true,
        };
      },
      async checkPayment(paymentId) {
        return { paymentId, status: "failed" };
      },
    };

    const harness = createTestHarness(relay);
    const res = await harness.app.request(
      "http://localhost/paid",
      {
        method: "POST",
        headers: {
          [X402_HEADERS.PAYMENT_SIGNATURE]: encodePaymentSignature({
            x402Version: 2,
            payload: { transaction: txHex },
          }),
        },
      },
      harness.env
    );

    expect(res.status).toBe(402);
    expect(harness.getHandlerCount()).toBe(0);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.retryable).toBe(true);
    expect(body.nextSteps).toBe("retry_later");
  });

  test("binds same-price POST request body on enqueue, refuses changed-body recovery without polling or evicting, and leaves original job recoverable", async () => {
    const txHex = await buildSignedTxHex({ sponsored: true, nonce: 64n });
    const relayId = "pay_relay_body_bind_64";
    const confirmedTxid = "0x6464646464646464646464646464646464646464646464646464646464646464";

    let submitCalls = 0;
    let checkCalls = 0;
    const relay: RelayRPC = {
      async submitPayment() {
        submitCalls += 1;
        return {
          accepted: true,
          status: "queued",
          paymentId: relayId,
          checkStatusUrl: `https://relay.example/payment/${relayId}`,
        };
      },
      async checkPayment() {
        checkCalls += 1;
        if (checkCalls === 1) {
          return { paymentId: relayId, status: "queued" };
        }
        return {
          paymentId: relayId,
          status: "confirmed",
          txid: confirmedTxid,
        };
      },
    };

    const executedSubjects: string[] = [];
    const logger: Logger = {
      debug() {},
      info() {},
      warn() {},
      error() {},
      child() {
        return logger;
      },
    };
    const env = {
      ENVIRONMENT: "staging",
      X402_FACILITATOR_URL: "https://facilitator.example",
      X402_NETWORK: "testnet",
      X402_SERVER_ADDRESS: TEST_SELLER_ADDRESS,
      X402_RELAY: relay,
      PAYMENT_POLLING_DO: {
        idFromName(name: string) {
          return name as unknown as DurableObjectId;
        },
        get() {
          return { async track() {} };
        },
      },
    } as unknown as Env;

    const app = new Hono<{ Bindings: Env; Variables: AppVariables }>();
    app.use("*", async (c, next) => {
      c.set("requestId", "req-body-bind");
      c.set("logger", logger);
      await next();
    });
    app.post(
      "/paid-job",
      x402Middleware({
        tier: "standard",
        rpcPollMaxAttempts: 1,
        rpcPollIntervalMs: 0,
      }),
      async (c) => {
        const payload = (await c.req.json()) as { subject: string };
        executedSubjects.push(payload.subject);
        return c.json({ ok: true, subject: payload.subject });
      }
    );

    const sigHeader = encodePaymentSignature({
      x402Version: 2,
      payload: { transaction: txHex },
    });

    // 1. Enqueue same-price POST with subject "original" → 402 pending (1 submit, 1 check)
    const enqueueRes = await app.request(
      "http://localhost/paid-job",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          [X402_HEADERS.PAYMENT_SIGNATURE]: sigHeader,
        },
        body: JSON.stringify({ subject: "original" }),
      },
      env
    );
    expect(enqueueRes.status).toBe(402);
    expect(submitCalls).toBe(1);
    expect(checkCalls).toBe(1);
    expect(executedSubjects).toEqual([]);

    // 2. Attempt recovery with X-PAYMENT-ID and modified body ("different") → 400 refused before polling or executing
    const changedBodyWithIdRes = await app.request(
      "http://localhost/paid-job",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-PAYMENT-ID": relayId,
          [X402_HEADERS.PAYMENT_SIGNATURE]: sigHeader,
        },
        body: JSON.stringify({ subject: "different" }),
      },
      env
    );
    expect(changedBodyWithIdRes.status).toBe(400);
    expect(submitCalls).toBe(1);
    expect(checkCalls).toBe(1);
    expect(executedSubjects).toEqual([]);

    // 3. Attempt recovery via byTxHash (no X-PAYMENT-ID) and modified body ("different") → 400 refused before polling or executing
    const changedBodyByTxRes = await app.request(
      "http://localhost/paid-job",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          [X402_HEADERS.PAYMENT_SIGNATURE]: sigHeader,
        },
        body: JSON.stringify({ subject: "different" }),
      },
      env
    );
    expect(changedBodyByTxRes.status).toBe(400);
    expect(submitCalls).toBe(1);
    expect(checkCalls).toBe(1);
    expect(executedSubjects).toEqual([]);

    // 4. Recover with original body ("original") and X-PAYMENT-ID → succeeds (200), polls checkPayment once more, executes "original"
    const validRecoveryRes = await app.request(
      "http://localhost/paid-job",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-PAYMENT-ID": relayId,
          [X402_HEADERS.PAYMENT_SIGNATURE]: sigHeader,
        },
        body: JSON.stringify({ subject: "original" }),
      },
      env
    );
    expect(validRecoveryRes.status).toBe(200);
    expect(submitCalls).toBe(1);
    expect(checkCalls).toBe(2);
    expect(executedSubjects).toEqual(["original"]);
  });
});
