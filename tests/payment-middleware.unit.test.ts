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
  NOT_FOUND_ENQUEUE_GRACE_MS,
  x402Middleware,
} from "../src/middleware/x402";
import { computeDerivedHints } from "../src/utils/payment-hints";
import type { AppVariables, Env, Logger, RelayRPC } from "../src/types";
import type {
  BindTxPaymentInput,
  ClaimTxInput,
  ClaimTxResult,
  MarkTxConsumedInput,
  TxGuardRecord,
} from "../src/durable-objects/PaymentPollingDO";

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

  test("skips body hashing on unpaid 402 probes and fails closed (400) if body hashing throws on a paid POST request", async () => {
    const txHex = await buildSignedTxHex({ sponsored: true, nonce: 704n });
    let submitCalls = 0;

    const relay: RelayRPC = {
      async submitPayment() {
        submitCalls++;
        return {
          accepted: true,
          paymentId: "pay_unreachable",
          status: "queued",
        };
      },
      async checkPayment() {
        return { paymentId: "pay_unreachable", status: "queued" };
      },
    };

    const { app, env, events } = createTestHarness(relay);

    const brokenBodyReq = (withPayment: boolean) => {
      const headers: Record<string, string> = {
        "Content-Type": "application/json",
      };
      if (withPayment) {
        headers[X402_HEADERS.PAYMENT_SIGNATURE] = encodePaymentSignature({
          x402Version: 2,
          payload: { transaction: txHex },
        });
      }
      const req = new Request("http://localhost/paid", {
        method: "POST",
        headers,
        body: JSON.stringify({ hello: "world" }),
      });
      Object.defineProperty(req, "clone", {
        value: () => ({
          arrayBuffer: async () => {
            throw new Error("simulated stream read failure");
          },
        }),
      });
      return req;
    };

    // Unpaid probe returns 402 before attempting to clone/hash the body
    const unpaidRes = await app.request(brokenBodyReq(false), undefined, env);
    expect(unpaidRes.status).toBe(402);
    expect(submitCalls).toBe(0);

    // Paid request with unreadable body fails closed with 400 and logs a warning
    const paidBrokenRes = await app.request(brokenBodyReq(true), undefined, env);
    expect(paidBrokenRes.status).toBe(400);
    const body = (await paidBrokenRes.json()) as Record<string, unknown>;
    expect(body.code).toBe(X402_ERROR_CODES.INVALID_PAYLOAD);
    expect(submitCalls).toBe(0);
    expect(
      events.some(
        (entry) =>
          entry.level === "warn" &&
          entry.message.includes("Failed to read request body for x402 request binding; failing closed")
      )
    ).toBe(true);
  });

  test("enforces price and request body across cold isolates via PaymentPollingDO tx_guard", async () => {
    const txHex = await buildSignedTxHex({ sponsored: true, nonce: 71n });
    const relayId = "pay_relay_cross_isolate_71";
    const confirmedTxid = "0x7171717171717171717171717171717171717171717171717171717171717171";

    const txGuardStore = new Map<string, TxGuardRecord>();
    const makeSharedDO = (): Env["PAYMENT_POLLING_DO"] =>
      ({
        idFromName(name: string) {
          return name as unknown as DurableObjectId;
        },
        get(id: DurableObjectId) {
          const key = String(id);
          return {
            async track() {},
            async getTxGuard() {
              return txGuardStore.get(key) ?? null;
            },
            async claimTx(input: ClaimTxInput): Promise<ClaimTxResult> {
              const existing = txGuardStore.get(key);
              const now = Date.now();
              if (existing?.consumed) return { status: "consumed", record: existing };
              if (existing?.relayPaymentId) return { status: "bound", record: existing };
              if (existing?.claimId && existing.claimExpiresAt && existing.claimExpiresAt > now && existing.claimId !== input.claimId) {
                return { status: "in_progress", record: existing };
              }
              const rec: TxGuardRecord = {
                txHash: input.txHash,
                expectedRecipient: input.expectedRecipient,
                minAmount: input.minAmount,
                asset: input.asset,
                network: input.network,
                verifiedPayer: input.verifiedPayer,
                requestBindingHash: input.requestBindingHash,
                claimId: input.claimId,
                claimExpiresAt: now + 30_000,
                consumed: false,
                updatedAt: now,
              };
              txGuardStore.set(key, rec);
              return { status: "claimed", record: rec };
            },
            async releaseTxClaim(claimId: string) {
              const existing = txGuardStore.get(key);
              if (existing && !existing.consumed && !existing.relayPaymentId && existing.claimId === claimId) {
                txGuardStore.delete(key);
              }
            },
            async bindTxPayment(input: BindTxPaymentInput) {
              const existing = txGuardStore.get(key);
              if (existing?.consumed || existing?.relayPaymentId) {
                return existing;
              }
              const rec: TxGuardRecord = {
                txHash: input.txHash,
                relayPaymentId: input.relayPaymentId,
                expectedRecipient: input.expectedRecipient,
                minAmount: input.minAmount,
                asset: input.asset,
                network: input.network,
                verifiedPayer: input.verifiedPayer || existing?.verifiedPayer,
                requestBindingHash: input.requestBindingHash,
                boundAt: input.boundAt ?? Date.now(),
                consumed: false,
                updatedAt: Date.now(),
              };
              txGuardStore.set(key, rec);
              return rec;
            },
            async clearBoundTx(expectedRelayPaymentId: string) {
              const existing = txGuardStore.get(key);
              if (!existing || existing.consumed) return;
              if (existing.relayPaymentId === expectedRelayPaymentId) {
                txGuardStore.delete(key);
              }
            },
            async markTxConsumed(input: MarkTxConsumedInput) {
              const existing = txGuardStore.get(key);
              if (existing?.consumed) {
                return { alreadyConsumed: true, record: existing };
              }
              const now = Date.now();
              const rec: TxGuardRecord = {
                ...existing,
                txHash: input.txHash,
                relayPaymentId: input.relayPaymentId ?? existing?.relayPaymentId,
                txid: undefined,
                expectedRecipient: input.expectedRecipient ?? existing?.expectedRecipient,
                minAmount: input.minAmount ?? existing?.minAmount,
                asset: input.asset ?? existing?.asset,
                network: input.network ?? existing?.network,
                verifiedPayer: input.verifiedPayer ?? existing?.verifiedPayer,
                consumed: true,
                consumedAt: now,
                consumedTxid: input.txid,
                updatedAt: now,
              } as TxGuardRecord;
              txGuardStore.set(key, rec);
              return { alreadyConsumed: false, record: rec };
            },
          };
        },
      }) as unknown as Env["PAYMENT_POLLING_DO"];

    let submitCount = 0;
    let checkCount = 0;
    const relayIsolateA: RelayRPC = {
      async submitPayment() {
        submitCount += 1;
        return {
          accepted: true,
          status: "queued",
          paymentId: relayId,
          checkStatusUrl: `https://relay.example/payment/${relayId}`,
        };
      },
      async checkPayment() {
        checkCount += 1;
        if (checkCount === 1) {
          return { paymentId: relayId, status: "queued" };
        }
        return { paymentId: relayId, status: "confirmed", txid: confirmedTxid };
      },
    };

    const noopLog: Logger = { debug() {}, info() {}, warn() {}, error() {} };
    const sharedDO = makeSharedDO();

    const makeIsolateApp = (relay: RelayRPC, opts: { dynamic?: boolean; amount?: bigint }) => {
      let handlers = 0;
      const app = new Hono<{ Bindings: Env; Variables: AppVariables }>();
      app.use("*", async (c, next) => {
        c.set("logger", noopLog);
        await next();
      });
      app.use(
        "*",
        x402Middleware({
          tier: "standard",
          dynamic: opts.dynamic ?? false,
          estimator: opts.dynamic
            ? () => ({
                estimatedCostUsd: 0.01,
                costWithMarginUsd: 0.01,
                amountInToken: opts.amount ?? 5000n,
                tokenType: "STX",
              })
            : undefined,
          rpcPollMaxAttempts: 1,
          rpcPollIntervalMs: 0,
        })
      );
      app.post("/paid", (c) => {
        handlers += 1;
        return c.json({ ok: true });
      });
      app.post("/paid-expensive", (c) => {
        handlers += 1;
        return c.json({ ok: true });
      });
      const env: Env = {
        ENVIRONMENT: "development",
        X402_FACILITATOR_URL: "https://facilitator.example",
        X402_NETWORK: "testnet",
        X402_SERVER_ADDRESS: TEST_SELLER_ADDRESS,
        X402_RELAY: relay,
        PAYMENT_POLLING_DO: sharedDO,
      } as unknown as Env;
      return { app, env, getHandlers: () => handlers };
    };

    const sigHeader = encodePaymentSignature({
      x402Version: 2,
      payload: { transaction: txHex },
    });

    // Step 1: Isolate A enqueues 1000-uSTX payment and persists tx_guard into shared DO
    const isoA = makeIsolateApp(relayIsolateA, { dynamic: false });
    const enqueueRes = await isoA.app.request(
      "http://localhost/paid",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          [X402_HEADERS.PAYMENT_SIGNATURE]: sigHeader,
        },
        body: JSON.stringify({ prompt: "cheap" }),
      },
      isoA.env
    );
    expect(enqueueRes.status).toBe(402);
    expect(txGuardStore.size).toBe(1);

    // Step 2: Cold Isolate B (new middleware + fresh RelayRPC) refuses higher-priced route (5000 > 1000) via DO tx_guard
    const relayIsolateB: RelayRPC = {
      async submitPayment() {
        submitCount += 1;
        throw new Error("Should not call submitPayment when DO holds bound tx_guard");
      },
      async checkPayment() {
        checkCount += 1;
        return { paymentId: relayId, status: "confirmed", txid: confirmedTxid };
      },
    };
    const isoBPriceUp = makeIsolateApp(relayIsolateB, { dynamic: true, amount: 5000n });
    const upgradeRes = await isoBPriceUp.app.request(
      "http://localhost/paid-expensive",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          [X402_HEADERS.PAYMENT_SIGNATURE]: sigHeader,
        },
        body: JSON.stringify({ prompt: "cheap" }),
      },
      isoBPriceUp.env
    );
    expect(upgradeRes.status).toBe(402);
    const upgradeBody = (await upgradeRes.json()) as Record<string, unknown>;
    expect(upgradeBody.code).toBe(X402_ERROR_CODES.AMOUNT_INSUFFICIENT);
    expect(submitCount).toBe(1);
    expect(isoBPriceUp.getHandlers()).toBe(0);

    // Step 3: Cold Isolate B refuses changed request body on the same tier via DO requestBindingHash
    const isoBBodyDiff = makeIsolateApp(relayIsolateB, { dynamic: false });
    const diffBodyRes = await isoBBodyDiff.app.request(
      "http://localhost/paid",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          [X402_HEADERS.PAYMENT_SIGNATURE]: sigHeader,
        },
        body: JSON.stringify({ prompt: "expensive-changed" }),
      },
      isoBBodyDiff.env
    );
    expect(diffBodyRes.status).toBe(400);
    const diffBody = (await diffBodyRes.json()) as Record<string, unknown>;
    expect(diffBody.code).toBe(X402_ERROR_CODES.INVALID_PAYLOAD);
    expect(isoBBodyDiff.getHandlers()).toBe(0);

    // Step 4: Cold Isolate B recovers original request safely without calling submitPayment again
    const isoBValid = makeIsolateApp(relayIsolateB, { dynamic: false });
    const okRes = await isoBValid.app.request(
      "http://localhost/paid",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          [X402_HEADERS.PAYMENT_SIGNATURE]: sigHeader,
        },
        body: JSON.stringify({ prompt: "cheap" }),
      },
      isoBValid.env
    );
    expect(okRes.status).toBe(200);
    expect(submitCount).toBe(1);
    expect(isoBValid.getHandlers()).toBe(1);
  });

  test("refuses cross-isolate replay when PaymentPollingDO tx_guard already recorded consumed=true", async () => {
    const txHex = await buildSignedTxHex({ sponsored: true, nonce: 72n });
    const cleanHex = extractVerifiedTransactionOrigin(txHex, "testnet")!.cleanHex;
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(cleanHex.toLowerCase()));
    const txHash = Array.from(new Uint8Array(digest))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");

    // Seed DO directly so this Worker process's in-isolate CONSUMED_PAYMENTS has NEVER seen txHash
    const txGuardStore = new Map<string, TxGuardRecord>([
      [
        `tx:${txHash}`,
        {
          txHash,
          relayPaymentId: "pay_relay_already_consumed_72",
          consumed: true,
          consumedAt: Date.now() - 5000,
          consumedTxid: "0x7272727272727272727272727272727272727272727272727272727272727272",
          updatedAt: Date.now() - 5000,
        },
      ],
    ]);

    let submitCalls = 0;
    let handlerCalls = 0;
    const noopLog: Logger = { debug() {}, info() {}, warn() {}, error() {} };
    const app = new Hono<{ Bindings: Env; Variables: AppVariables }>();
    app.use("*", async (c, next) => {
      c.set("logger", noopLog);
      await next();
    });
    app.use("/paid", x402Middleware({ tier: "standard", rpcPollMaxAttempts: 1, rpcPollIntervalMs: 0 }));
    app.post("/paid", (c) => {
      handlerCalls += 1;
      return c.json({ ok: true });
    });

    const env: Env = {
      ENVIRONMENT: "development",
      X402_FACILITATOR_URL: "https://facilitator.example",
      X402_NETWORK: "testnet",
      X402_SERVER_ADDRESS: TEST_SELLER_ADDRESS,
      X402_RELAY: {
        async submitPayment() {
          submitCalls += 1;
          return { accepted: true, status: "queued", paymentId: "pay_should_not_resubmit" };
        },
        async checkPayment() {
          return { paymentId: "pay_should_not_resubmit", status: "failed" };
        },
      },
      PAYMENT_POLLING_DO: {
        idFromName(name: string) {
          return name as unknown as DurableObjectId;
        },
        get(id: DurableObjectId) {
          const key = String(id);
          return {
            async track() {},
            async getTxGuard() {
              return txGuardStore.get(key) ?? null;
            },
          };
        },
      },
    } as unknown as Env;

    const res = await app.request(
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
      env
    );

    expect(res.status).toBe(402);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.code).toBe(X402_ERROR_CODES.INVALID_TRANSACTION_STATE);
    expect(submitCalls).toBe(0);
    expect(handlerCalls).toBe(0);
  });

  test("treats transient not_found right after enqueue as pending within KV grace window and preserves bound state", async () => {
    const txHex = await buildSignedTxHex({ sponsored: true, nonce: 73n });
    const relayId = "pay_relay_kv_grace_73";
    const confirmedTxid = "0x7373737373737373737373737373737373737373737373737373737373737373";

    let submitCount = 0;
    let checkCount = 0;
    let clearBoundCount = 0;
    const txGuardStore = new Map<string, TxGuardRecord>();

    const relay: RelayRPC = {
      async submitPayment() {
        submitCount += 1;
        return {
          accepted: true,
          status: "queued",
          paymentId: relayId,
          checkStatusUrl: `https://relay.example/payment/${relayId}`,
        };
      },
      async checkPayment() {
        checkCount += 1;
        if (checkCount === 1) {
          return { paymentId: relayId, status: "not_found" };
        }
        return { paymentId: relayId, status: "confirmed", txid: confirmedTxid };
      },
    };

    const noopLog: Logger = { debug() {}, info() {}, warn() {}, error() {} };
    let handlerCount = 0;
    const app = new Hono<{ Bindings: Env; Variables: AppVariables }>();
    app.use("*", async (c, next) => {
      c.set("logger", noopLog);
      await next();
    });
    app.use("/paid", x402Middleware({ tier: "standard", rpcPollMaxAttempts: 1, rpcPollIntervalMs: 0 }));
    app.post("/paid", (c) => {
      handlerCount += 1;
      return c.json({ ok: true });
    });

    const env: Env = {
      ENVIRONMENT: "development",
      X402_FACILITATOR_URL: "https://facilitator.example",
      X402_NETWORK: "testnet",
      X402_SERVER_ADDRESS: TEST_SELLER_ADDRESS,
      X402_RELAY: relay,
      PAYMENT_POLLING_DO: {
        idFromName(name: string) {
          return name as unknown as DurableObjectId;
        },
        get(id: DurableObjectId) {
          const key = String(id);
          return {
            async track() {},
            async getTxGuard() {
              return txGuardStore.get(key) ?? null;
            },
            async bindTxPayment(input: BindTxPaymentInput) {
              const rec: TxGuardRecord = {
                txHash: input.txHash,
                relayPaymentId: input.relayPaymentId,
                expectedRecipient: input.expectedRecipient,
                minAmount: input.minAmount,
                asset: input.asset,
                network: input.network,
                verifiedPayer: input.verifiedPayer,
                requestBindingHash: input.requestBindingHash,
                boundAt: input.boundAt ?? Date.now(),
                consumed: false,
                updatedAt: Date.now(),
              };
              txGuardStore.set(key, rec);
              return rec;
            },
            async clearBoundTx() {
              clearBoundCount += 1;
              txGuardStore.delete(key);
            },
            async markTxConsumed(input: MarkTxConsumedInput) {
              const existing = txGuardStore.get(key);
              const rec: TxGuardRecord = {
                ...existing,
                txHash: input.txHash,
                consumed: true,
                consumedAt: Date.now(),
                consumedTxid: input.txid,
                updatedAt: Date.now(),
              };
              txGuardStore.set(key, rec);
              return { alreadyConsumed: false, record: rec };
            },
          };
        },
      },
    } as unknown as Env;

    const sigHeader = encodePaymentSignature({
      x402Version: 2,
      payload: { transaction: txHex },
    });

    // Request 1: immediate checkPayment returns KV-inconsistent "not_found" within grace window → kept pending (402 TRANSACTION_PENDING)
    const pendingRes = await app.request(
      "http://localhost/paid",
      { method: "POST", headers: { [X402_HEADERS.PAYMENT_SIGNATURE]: sigHeader } },
      env
    );
    expect(pendingRes.status).toBe(402);
    const pendingBody = (await pendingRes.json()) as Record<string, unknown>;
    expect(pendingBody.code).toBe(X402_ERROR_CODES.TRANSACTION_PENDING);
    expect(pendingBody.status).toBe("queued");
    expect(pendingBody.paymentId).toBe(relayId);
    expect(clearBoundCount).toBe(0);
    expect(txGuardStore.size).toBe(1);
    expect(handlerCount).toBe(0);

    // Request 2: KV propagates and checkPayment confirms without calling submitPayment again
    const okRes = await app.request(
      "http://localhost/paid",
      { method: "POST", headers: { [X402_HEADERS.PAYMENT_SIGNATURE]: sigHeader } },
      env
    );
    expect(okRes.status).toBe(200);
    expect(submitCount).toBe(1);
    expect(handlerCount).toBe(1);
  });

  test("returns 503 with Retry-After for retryable relay rejections (QUEUE_UNAVAILABLE and BROADCAST_RATE_LIMITED)", async () => {
    for (const [idx, code] of ["QUEUE_UNAVAILABLE", "BROADCAST_RATE_LIMITED"].entries()) {
      const txHex = await buildSignedTxHex({ sponsored: true, nonce: BigInt(74 + idx) });
      const harness = createTestHarness({
        async submitPayment() {
          return {
            accepted: false,
            code,
            error: `Relay rejected with ${code}`,
            retryable: true,
          };
        },
        async checkPayment(paymentId) {
          return { paymentId, status: "failed" };
        },
      });

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

      expect(res.status).toBe(503);
      expect(res.headers.get("Retry-After")).toBe("30");
      expect(harness.getHandlerCount()).toBe(0);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body.retryable).toBe(true);
      expect(body.nextSteps).toBe("retry_later");
      expect(body.retryAfter).toBe(30);
      expect(body.status).toBeUndefined();
    }
  });

  test("fails closed with 503 Retry-After: 5 when bindTxPaymentInDO throws after accepted submitPayment", async () => {
    const txHex = await buildSignedTxHex({ sponsored: true, nonce: 80n });
    let trackCount = 0;
    let handlerCount = 0;

    const app = new Hono<{ Bindings: Env; Variables: AppVariables }>();
    app.use("*", async (c, next) => {
      c.set("logger", { debug() {}, info() {}, warn() {}, error() {} });
      await next();
    });
    app.use(
      "/paid",
      x402Middleware({
        tier: "standard",
        rpcPollMaxAttempts: 1,
        rpcPollIntervalMs: 0,
      })
    );
    app.post("/paid", (c) => {
      handlerCount += 1;
      return c.json({ ok: true });
    });

    const failingBindDO = {
      idFromName(name: string) {
        return name as unknown as DurableObjectId;
      },
      get() {
        return {
          async track() {
            trackCount += 1;
          },
          async getTxGuard() {
            return null;
          },
          async claimTx(input: ClaimTxInput): Promise<ClaimTxResult> {
            return {
              status: "claimed",
              record: {
                txHash: input.txHash,
                claimId: input.claimId,
                consumed: false,
                updatedAt: Date.now(),
              },
            };
          },
          async releaseTxClaim() {},
          async bindTxPayment() {
            throw new Error("DO storage write failed");
          },
        };
      },
    } as unknown as Env["PAYMENT_POLLING_DO"];

    const env: Env = {
      ENVIRONMENT: "development",
      X402_FACILITATOR_URL: "https://facilitator.example",
      X402_NETWORK: "testnet",
      X402_SERVER_ADDRESS: TEST_SELLER_ADDRESS,
      X402_RELAY: {
        async submitPayment() {
          return {
            accepted: true,
            status: "queued",
            paymentId: "pay_bind_fail_1",
          };
        },
        async checkPayment(paymentId: string) {
          return { paymentId, status: "queued" };
        },
      },
      PAYMENT_POLLING_DO: failingBindDO,
    } as unknown as Env;

    const res = await app.request(
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
      env
    );

    expect(res.status).toBe(503);
    expect(res.headers.get("Retry-After")).toBe("5");
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.retryable).toBe(true);
    expect(body.retryAfter).toBe(5);
    expect(body.nextSteps).toBe("retry_later");
    expect(body.code).not.toBe(X402_ERROR_CODES.TRANSACTION_PENDING);
    expect(trackCount).toBe(0);
    expect(handlerCount).toBe(0);
  });

  test("serializes concurrent cold-isolate requests via DO claimTx and releases claim on rejected submitPayment", async () => {
    const txHex = await buildSignedTxHex({ sponsored: true, nonce: 81n });
    const txGuardStore = new Map<string, TxGuardRecord>();
    const relayId = "pay_claim_race_1";

    const makeConcurrentDO = (): Env["PAYMENT_POLLING_DO"] =>
      ({
        idFromName(name: string) {
          return name as unknown as DurableObjectId;
        },
        get(id: DurableObjectId) {
          const key = String(id);
          return {
            async track() {},
            async getTxGuard() {
              return txGuardStore.get(key) ?? null;
            },
            async claimTx(input: ClaimTxInput): Promise<ClaimTxResult> {
              const existing = txGuardStore.get(key);
              const now = Date.now();
              if (existing?.consumed) return { status: "consumed", record: existing };
              if (existing?.relayPaymentId) return { status: "bound", record: existing };
              if (existing?.claimId && existing.claimExpiresAt && existing.claimExpiresAt > now && existing.claimId !== input.claimId) {
                return { status: "in_progress", record: existing };
              }
              const rec: TxGuardRecord = {
                txHash: input.txHash,
                expectedRecipient: input.expectedRecipient,
                minAmount: input.minAmount,
                asset: input.asset,
                network: input.network,
                verifiedPayer: input.verifiedPayer,
                requestBindingHash: input.requestBindingHash,
                claimId: input.claimId,
                claimExpiresAt: now + 30_000,
                consumed: false,
                updatedAt: now,
              };
              txGuardStore.set(key, rec);
              return { status: "claimed", record: rec };
            },
            async releaseTxClaim(claimId: string) {
              const existing = txGuardStore.get(key);
              if (existing && !existing.consumed && !existing.relayPaymentId && existing.claimId === claimId) {
                txGuardStore.delete(key);
              }
            },
            async bindTxPayment(input: BindTxPaymentInput) {
              const existing = txGuardStore.get(key);
              if (existing?.consumed || existing?.relayPaymentId) return existing;
              const rec: TxGuardRecord = {
                txHash: input.txHash,
                relayPaymentId: input.relayPaymentId,
                expectedRecipient: input.expectedRecipient,
                minAmount: input.minAmount,
                asset: input.asset,
                network: input.network,
                verifiedPayer: input.verifiedPayer,
                requestBindingHash: input.requestBindingHash,
                boundAt: input.boundAt ?? Date.now(),
                consumed: false,
                updatedAt: Date.now(),
              };
              txGuardStore.set(key, rec);
              return rec;
            },
          };
        },
      }) as unknown as Env["PAYMENT_POLLING_DO"];

    const sharedDO = makeConcurrentDO();
    let releaseSubmit!: () => void;
    const submitGate = new Promise<void>((resolve) => {
      releaseSubmit = resolve;
    });
    let submitCalls = 0;

    const makeApp = (relay: RelayRPC) => {
      const app = new Hono<{ Bindings: Env; Variables: AppVariables }>();
      app.use("*", async (c, next) => {
        c.set("logger", { debug() {}, info() {}, warn() {}, error() {} });
        await next();
      });
      app.use(
        "/paid",
        x402Middleware({
          tier: "standard",
          rpcPollMaxAttempts: 1,
          rpcPollIntervalMs: 0,
        })
      );
      app.post("/paid", (c) => c.json({ ok: true }));
      const env = {
        ENVIRONMENT: "development",
        X402_FACILITATOR_URL: "https://facilitator.example",
        X402_NETWORK: "testnet",
        X402_SERVER_ADDRESS: TEST_SELLER_ADDRESS,
        X402_RELAY: relay,
        PAYMENT_POLLING_DO: sharedDO,
      } as unknown as Env;
      return { app, env };
    };

    const sig = encodePaymentSignature({ x402Version: 2, payload: { transaction: txHex } });
    const iso1 = makeApp({
      async submitPayment() {
        submitCalls += 1;
        await submitGate;
        return { accepted: false, code: "QUEUE_UNAVAILABLE", error: "busy", retryable: true };
      },
      async checkPayment(paymentId) {
        return { paymentId, status: "queued" };
      },
    });
    const iso2 = makeApp({
      async submitPayment() {
        submitCalls += 1;
        return { accepted: true, status: "queued", paymentId: relayId };
      },
      async checkPayment(paymentId) {
        return { paymentId, status: "queued" };
      },
    });

    const req1Promise = iso1.app.request(
      "http://localhost/paid",
      {
        method: "POST",
        headers: { "Content-Type": "application/json", [X402_HEADERS.PAYMENT_SIGNATURE]: sig },
        body: JSON.stringify({ step: "race" }),
      },
      iso1.env
    );

    // Wait one microtask tick so iso1 acquires the DO claim and blocks on submitPayment
    await new Promise((r) => setTimeout(r, 15));

    const res2 = await iso2.app.request(
      "http://localhost/paid",
      {
        method: "POST",
        headers: { "Content-Type": "application/json", [X402_HEADERS.PAYMENT_SIGNATURE]: sig },
        body: JSON.stringify({ step: "race" }),
      },
      iso2.env
    );
    expect(res2.status).toBe(503);
    expect(res2.headers.get("Retry-After")).toBe("2");
    expect(submitCalls).toBe(1);

    // Conflicting body while claim is held fails closed with 400 INVALID_PAYLOAD
    const resConflict = await iso2.app.request(
      "http://localhost/paid",
      {
        method: "POST",
        headers: { "Content-Type": "application/json", [X402_HEADERS.PAYMENT_SIGNATURE]: sig },
        body: JSON.stringify({ step: "different" }),
      },
      iso2.env
    );
    expect(resConflict.status).toBe(400);
    const conflictBody = (await resConflict.json()) as Record<string, unknown>;
    expect(conflictBody.code).toBe(X402_ERROR_CODES.INVALID_PAYLOAD);

    // Unblock iso1's rejected submitPayment; middleware must release the DO claim so iso2 can now submit
    releaseSubmit();
    const res1 = await req1Promise;
    expect(res1.status).toBe(503);
    expect(txGuardStore.size).toBe(0);

    const resAfterRelease = await iso2.app.request(
      "http://localhost/paid",
      {
        method: "POST",
        headers: { "Content-Type": "application/json", [X402_HEADERS.PAYMENT_SIGNATURE]: sig },
        body: JSON.stringify({ step: "race" }),
      },
      iso2.env
    );
    expect(resAfterRelease.status).toBe(402);
    const bodyAfter = (await resAfterRelease.json()) as Record<string, unknown>;
    expect(bodyAfter.code).toBe(X402_ERROR_CODES.TRANSACTION_PENDING);
    expect(bodyAfter.paymentId).toBe(relayId);
    expect(submitCalls).toBe(2);
  });

  test("normalizes non-public 'submitted' and 'queued_with_warning' relay statuses to 'queued' across submit fallback and polling", async () => {
    for (const [idx, rawStatus] of ["submitted", "queued_with_warning"].entries()) {
      const txHex = await buildSignedTxHex({ sponsored: true, nonce: BigInt(82 + idx) });
      const harnessSubmitFallback = createTestHarness({
        async submitPayment() {
          return {
            accepted: true,
            status: rawStatus as unknown as "queued",
            paymentId: `pay_norm_fallback_${idx}`,
          };
        },
        async checkPayment() {
          throw new Error("poll unavailable");
        },
      });

      const resFallback = await harnessSubmitFallback.app.request(
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
        harnessSubmitFallback.env
      );
      expect(resFallback.status).toBe(402);
      const bodyFallback = (await resFallback.json()) as Record<string, unknown>;
      expect(bodyFallback.code).toBe(X402_ERROR_CODES.TRANSACTION_PENDING);
      expect(bodyFallback.status).toBe("queued");
      expect(bodyFallback.retryable).toBe(true);

      const txHexPoll = await buildSignedTxHex({ sponsored: true, nonce: BigInt(84 + idx) });
      const harnessPoll = createTestHarness({
        async submitPayment() {
          return {
            accepted: true,
            status: rawStatus as unknown as "queued",
            paymentId: `pay_norm_poll_${idx}`,
          };
        },
        async checkPayment(paymentId) {
          return {
            paymentId,
            status: rawStatus as unknown as "queued",
          };
        },
      });

      const resPoll = await harnessPoll.app.request(
        "http://localhost/paid",
        {
          method: "POST",
          headers: {
            [X402_HEADERS.PAYMENT_SIGNATURE]: encodePaymentSignature({
              x402Version: 2,
              payload: { transaction: txHexPoll },
            }),
          },
        },
        harnessPoll.env
      );
      expect(resPoll.status).toBe(402);
      const bodyPoll = (await resPoll.json()) as Record<string, unknown>;
      expect(bodyPoll.code).toBe(X402_ERROR_CODES.TRANSACTION_PENDING);
      expect(bodyPoll.status).toBe("queued");
      expect(bodyPoll.retryable).toBe(true);
    }
  });

  test("warm isolate byTxHash fallback rejects mismatched X-PAYMENT-ID with 400 SENDER_MISMATCH", async () => {
    const txHex = await buildSignedTxHex({ sponsored: true, nonce: 86n });
    const relayId = "pay_warm_bound_1";
    let checkCalls = 0;
    const harness = createTestHarness({
      async submitPayment() {
        return { accepted: true, status: "queued", paymentId: relayId };
      },
      async checkPayment(paymentId) {
        checkCalls += 1;
        return { paymentId, status: "queued" };
      },
    });

    const sigHeader = encodePaymentSignature({
      x402Version: 2,
      payload: { transaction: txHex },
    });

    const first = await harness.app.request(
      "http://localhost/paid",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          [X402_HEADERS.PAYMENT_SIGNATURE]: sigHeader,
        },
        body: JSON.stringify({ prompt: "warm" }),
      },
      harness.env
    );
    expect(first.status).toBe(402);

    const correlationId = await deriveRequestCorrelationId(
      txHex.replace(/^0x/, ""),
      TEST_SELLER_ADDRESS,
      "1000",
      "STX"
    );

    // Passing either an arbitrary wrong ID or the correlation ID instead of relayId must reject cleanly
    for (const badId of ["pay_completely_wrong", correlationId]) {
      const mismatchRes = await harness.app.request(
        "http://localhost/paid",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            [X402_HEADERS.PAYMENT_SIGNATURE]: sigHeader,
            "X-PAYMENT-ID": badId,
          },
          body: JSON.stringify({ prompt: "warm" }),
        },
        harness.env
      );
      expect(mismatchRes.status).toBe(400);
      const mismatchBody = (await mismatchRes.json()) as Record<string, unknown>;
      expect(mismatchBody.code).toBe(X402_ERROR_CODES.SENDER_MISMATCH);
    }
    expect(checkCalls).toBe(1);
  });

  test("dynamic OpenRouter route honors bound amount on identical retry even if pricing drifts upward", async () => {
    const txHex = await buildSignedTxHex({ sponsored: true, nonce: 87n });
    const relayId = "pay_dyn_drift_1";
    const confirmedTxid = "0x8787878787878787878787878787878787878787878787878787878787878787";
    let estimateAmount = 1000n;
    let submitCount = 0;
    let checkCount = 0;
    let handlerCount = 0;

    const app = new Hono<{ Bindings: Env; Variables: AppVariables }>();
    app.use("*", async (c, next) => {
      c.set("logger", { debug() {}, info() {}, warn() {}, error() {} });
      await next();
    });
    app.use(
      "/chat",
      x402Middleware({
        tier: "standard",
        dynamic: true,
        estimator: () => ({
          estimatedCostUsd: 0.001,
          costWithMarginUsd: 0.001,
          amountInToken: estimateAmount,
          tokenType: "STX",
        }),
        rpcPollMaxAttempts: 1,
        rpcPollIntervalMs: 0,
      })
    );
    app.post("/chat", (c) => {
      handlerCount += 1;
      const x402 = c.get("x402");
      return c.json({ ok: true, amountUsed: x402?.paymentRequirements?.amount });
    });

    const env = {
      ENVIRONMENT: "development",
      X402_FACILITATOR_URL: "https://facilitator.example",
      X402_NETWORK: "testnet",
      X402_SERVER_ADDRESS: TEST_SELLER_ADDRESS,
      X402_RELAY: {
        async submitPayment() {
          submitCount += 1;
          return { accepted: true, status: "queued", paymentId: relayId };
        },
        async checkPayment(paymentId: string) {
          checkCount += 1;
          if (checkCount === 1) return { paymentId, status: "queued" };
          return { paymentId, status: "confirmed", txid: confirmedTxid };
        },
      },
    } as unknown as Env;

    const sig = encodePaymentSignature({ x402Version: 2, payload: { transaction: txHex } });
    const pendingRes = await app.request(
      "http://localhost/chat",
      {
        method: "POST",
        headers: { "Content-Type": "application/json", [X402_HEADERS.PAYMENT_SIGNATURE]: sig },
        body: JSON.stringify({ model: "test", messages: [{ role: "user", content: "hi" }] }),
      },
      env
    );
    expect(pendingRes.status).toBe(402);
    expect(submitCount).toBe(1);

    // Pricing drifts up on identical retry -> recovers using bound 1000n amount instead of abandoning payment
    estimateAmount = 2500n;
    const retryRes = await app.request(
      "http://localhost/chat",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          [X402_HEADERS.PAYMENT_SIGNATURE]: sig,
          "X-PAYMENT-ID": relayId,
        },
        body: JSON.stringify({ model: "test", messages: [{ role: "user", content: "hi" }] }),
      },
      env
    );
    expect(retryRes.status).toBe(200);
    const okBody = (await retryRes.json()) as Record<string, unknown>;
    expect(okBody.amountUsed).toBe("1000");
    expect(submitCount).toBe(1);
    expect(handlerCount).toBe(1);
  });

  test("passes deterministic requestCorrelationId / X-PAYMENT-ID to submitPayment and HTTP /settle across timeout retries", async () => {
    const txHex = await buildSignedTxHex({ sponsored: true, nonce: 88n });
    const sig = encodePaymentSignature({ x402Version: 2, payload: { transaction: txHex } });

    const seenRpcIds: string[] = [];
    const harnessRpc = createTestHarness({
      async submitPayment(_tx, _opts, paymentIdentifier) {
        if (paymentIdentifier) seenRpcIds.push(paymentIdentifier);
        throw new Error("Transient RPC timeout");
      },
      async checkPayment(paymentId) {
        return { paymentId, status: "queued" };
      },
    });

    await harnessRpc.app.request(
      "http://localhost/paid",
      { method: "POST", headers: { [X402_HEADERS.PAYMENT_SIGNATURE]: sig } },
      harnessRpc.env
    );
    await harnessRpc.app.request(
      "http://localhost/paid",
      { method: "POST", headers: { [X402_HEADERS.PAYMENT_SIGNATURE]: sig } },
      harnessRpc.env
    );
    expect(seenRpcIds.length).toBe(2);
    expect(seenRpcIds[0]).toBe(seenRpcIds[1]);

    // Caller-supplied X-PAYMENT-ID overrides correlation ID on both RPC and HTTP /settle fallback
    const callerId = "pay_caller_idem_88";
    await harnessRpc.app.request(
      "http://localhost/paid",
      {
        method: "POST",
        headers: {
          [X402_HEADERS.PAYMENT_SIGNATURE]: sig,
          "X-PAYMENT-ID": callerId,
        },
      },
      harnessRpc.env
    );
    expect(seenRpcIds[2]).toBe(callerId);

    // HTTP /settle path (X402_RELAY absent): verify payment-identifier extension matches deterministic correlation ID
    const originalSettle = X402PaymentVerifier.prototype.settle;
    const seenHttpIds: Array<string | undefined> = [];
    X402PaymentVerifier.prototype.settle = async function (payload) {
      const ext = payload.extensions?.["payment-identifier"] as { info?: { id?: string } } | undefined;
      seenHttpIds.push(ext?.info?.id);
      return {
        success: true,
        transaction: "0x8888888888888888888888888888888888888888888888888888888888888888",
        network: "stacks:2147483648",
        payer: TEST_BUYER_ADDRESS,
      };
    };
    try {
      const httpHarness = createTestHarness({
        async submitPayment() {
          throw new Error("unused");
        },
        async checkPayment(paymentId) {
          return { paymentId, status: "queued" };
        },
      });
      // Strip X402_RELAY to exercise HTTP /settle fallback
      (httpHarness.env as unknown as Record<string, unknown>).X402_RELAY = undefined;

      const txHttp = await buildSignedTxHex({ sponsored: true, nonce: 89n });
      const resHttp = await httpHarness.app.request(
        "http://localhost/paid",
        {
          method: "POST",
          headers: {
            [X402_HEADERS.PAYMENT_SIGNATURE]: encodePaymentSignature({
              x402Version: 2,
              payload: { transaction: txHttp },
            }),
          },
        },
        httpHarness.env
      );
      expect(resHttp.status).toBe(200);
      const expectedCorr = await deriveRequestCorrelationId(
        txHttp.replace(/^0x/, ""),
        TEST_SELLER_ADDRESS,
        "1000",
        "STX"
      );
      expect(seenHttpIds[0]).toBe(expectedCorr);
    } finally {
      X402PaymentVerifier.prototype.settle = originalSettle;
    }
  });

  test("preserves DO tx_guard for 65s not_found within 90s KV grace and clears post-grace (>= 90s)", async () => {
    expect(NOT_FOUND_ENQUEUE_GRACE_MS).toBeGreaterThanOrEqual(60_000);
    expect(NOT_FOUND_ENQUEUE_GRACE_MS).toBeLessThanOrEqual(90_000);
    const txHex = await buildSignedTxHex({ sponsored: true, nonce: 90n });
    const relayId = "pay_expired_not_found_90";
    const clearedIds: string[] = [];
    const txGuardStore = new Map<string, TxGuardRecord>();

    const sharedDO = {
      idFromName(name: string) {
        return name as unknown as DurableObjectId;
      },
      get(id: DurableObjectId) {
        const key = String(id);
        return {
          async track() {},
          async getTxGuard() {
            return txGuardStore.get(key) ?? null;
          },
          async claimTx(input: ClaimTxInput): Promise<ClaimTxResult> {
            const existing = txGuardStore.get(key);
            if (existing?.relayPaymentId) return { status: "bound", record: existing };
            return {
              status: "claimed",
              record: {
                txHash: input.txHash,
                claimId: input.claimId,
                callerSuppliedPaymentId: input.callerSuppliedPaymentId,
                consumed: false,
                updatedAt: Date.now(),
              },
            };
          },
          async releaseTxClaim() {},
          async bindTxPayment(input: BindTxPaymentInput) {
            const rec: TxGuardRecord = {
              txHash: input.txHash,
              relayPaymentId: input.relayPaymentId,
              callerSuppliedPaymentId: input.callerSuppliedPaymentId,
              expectedRecipient: input.expectedRecipient,
              minAmount: input.minAmount,
              asset: input.asset,
              network: input.network,
              verifiedPayer: input.verifiedPayer,
              requestBindingHash: input.requestBindingHash,
              boundAt: input.boundAt ?? Date.now(),
              consumed: false,
              updatedAt: Date.now(),
            };
            txGuardStore.set(key, rec);
            return rec;
          },
          async clearBoundTx(expectedRelayPaymentId: string) {
            clearedIds.push(expectedRelayPaymentId);
            const existing = txGuardStore.get(key);
            if (existing && !existing.consumed && existing.relayPaymentId === expectedRelayPaymentId) {
              txGuardStore.delete(key);
            }
          },
          async markTxConsumed(input: MarkTxConsumedInput) {
            const rec: TxGuardRecord = { txHash: input.txHash, consumed: true, updatedAt: Date.now() };
            txGuardStore.set(key, rec);
            return { alreadyConsumed: false, record: rec };
          },
        };
      },
    } as unknown as Env["PAYMENT_POLLING_DO"];

    let submitCount = 0;
    const makeApp = () => {
      const app = new Hono<{ Bindings: Env; Variables: AppVariables }>();
      app.use("*", async (c, next) => {
        c.set("logger", { debug() {}, info() {}, warn() {}, error() {} });
        await next();
      });
      app.use(
        "/paid",
        x402Middleware({
          tier: "standard",
          rpcPollMaxAttempts: 1,
          rpcPollIntervalMs: 0,
        })
      );
      app.post("/paid", (c) => c.json({ ok: true }));
      const env = {
        ENVIRONMENT: "development",
        X402_FACILITATOR_URL: "https://facilitator.example",
        X402_NETWORK: "testnet",
        X402_SERVER_ADDRESS: TEST_SELLER_ADDRESS,
        X402_RELAY: {
          async submitPayment() {
            submitCount += 1;
            return { accepted: true, status: "queued", paymentId: relayId };
          },
          async checkPayment(paymentId: string) {
            return { paymentId, status: "not_found" };
          },
        },
        PAYMENT_POLLING_DO: sharedDO,
      } as unknown as Env;
      return { app, env };
    };

    const sig = encodePaymentSignature({ x402Version: 2, payload: { transaction: txHex } });
    // Compute key identically via initial enqueue
    const iso1 = makeApp();
    await iso1.app.request(
      "http://localhost/paid",
      { method: "POST", headers: { [X402_HEADERS.PAYMENT_SIGNATURE]: sig } },
      iso1.env
    );
    expect(txGuardStore.size).toBe(1);

    // Age boundAt to 65s: beyond old 30s limit, still within extended 90s KV propagation grace window
    for (const [k, v] of txGuardStore.entries()) {
      txGuardStore.set(k, { ...v, boundAt: Date.now() - 65_000 });
    }
    const isoGrace = makeApp();
    const stillGraceRes = await isoGrace.app.request(
      "http://localhost/paid",
      { method: "POST", headers: { [X402_HEADERS.PAYMENT_SIGNATURE]: sig } },
      isoGrace.env
    );
    expect(stillGraceRes.status).toBe(402);
    const stillGraceBody = (await stillGraceRes.json()) as Record<string, unknown>;
    expect(stillGraceBody.code).toBe(X402_ERROR_CODES.TRANSACTION_PENDING);
    expect(stillGraceBody.status).toBe("queued");
    expect(clearedIds.length).toBe(0);
    expect(txGuardStore.size).toBe(1);

    // Age boundAt past the 90s KV grace window
    for (const [k, v] of txGuardStore.entries()) {
      txGuardStore.set(k, { ...v, boundAt: Date.now() - (NOT_FOUND_ENQUEUE_GRACE_MS + 5_000) });
    }

    const iso2 = makeApp();
    const expiredRes = await iso2.app.request(
      "http://localhost/paid",
      { method: "POST", headers: { [X402_HEADERS.PAYMENT_SIGNATURE]: sig } },
      iso2.env
    );
    expect(expiredRes.status).toBe(402);
    const expiredBody = (await expiredRes.json()) as Record<string, unknown>;
    expect(expiredBody.code).toBe(X402_ERROR_CODES.INVALID_TRANSACTION_STATE);
    expect(expiredBody.status).toBe("not_found");
    expect(clearedIds).toEqual([relayId]);
    expect(txGuardStore.size).toBe(0);
    expect(submitCount).toBe(1);
  });

  test("releases DO claim when bindTxPaymentInDO throws and fails closed with 503 when DO refuses bind due to competing claim", async () => {
    const txHex = await buildSignedTxHex({ sponsored: true, nonce: 91n });
    const releasedClaims: string[] = [];
    let throwOnBind = true;
    let competingClaimRecord: TxGuardRecord | null = null;
    let handlerCalls = 0;

    const app = new Hono<{ Bindings: Env; Variables: AppVariables }>();
    app.use("*", async (c, next) => {
      c.set("logger", { debug() {}, info() {}, warn() {}, error() {} });
      await next();
    });
    app.use("/paid", x402Middleware({ tier: "standard", rpcPollMaxAttempts: 1, rpcPollIntervalMs: 0 }));
    app.post("/paid", (c) => {
      handlerCalls += 1;
      return c.json({ ok: true });
    });

    const doStub = {
      idFromName(name: string) {
        return name as unknown as DurableObjectId;
      },
      get() {
        return {
          async track() {},
          async getTxGuard() {
            return null;
          },
          async claimTx(input: ClaimTxInput): Promise<ClaimTxResult> {
            return {
              status: "claimed",
              record: { txHash: input.txHash, claimId: input.claimId, consumed: false, updatedAt: Date.now() },
            };
          },
          async releaseTxClaim(claimId: string) {
            releasedClaims.push(claimId);
          },
          async bindTxPayment() {
            if (throwOnBind) throw new Error("transient DO write error");
            return competingClaimRecord!;
          },
        };
      },
    } as unknown as Env["PAYMENT_POLLING_DO"];

    const env: Env = {
      ENVIRONMENT: "development",
      X402_FACILITATOR_URL: "https://facilitator.example",
      X402_NETWORK: "testnet",
      X402_SERVER_ADDRESS: TEST_SELLER_ADDRESS,
      X402_RELAY: {
        async submitPayment() {
          return { accepted: true, status: "queued", paymentId: "pay_claim_superseded_91" };
        },
        async checkPayment(paymentId: string) {
          return { paymentId, status: "confirmed", txid: "0x9191919191919191919191919191919191919191919191919191919191919191" };
        },
      },
      PAYMENT_POLLING_DO: doStub,
    } as unknown as Env;

    const sig = encodePaymentSignature({ x402Version: 2, payload: { transaction: txHex } });
    const resBindErr = await app.request(
      "http://localhost/paid",
      { method: "POST", headers: { [X402_HEADERS.PAYMENT_SIGNATURE]: sig } },
      env
    );
    expect(resBindErr.status).toBe(503);
    expect(resBindErr.headers.get("Retry-After")).toBe("5");
    expect(releasedClaims.length).toBe(1);
    expect(handlerCalls).toBe(0);

    // When bindTxPayment returns a competing active claim (no relayPaymentId), fail closed with 503 Retry-After: 2
    throwOnBind = false;
    competingClaimRecord = {
      txHash: "tx_competing",
      claimId: "claim_other_isolate",
      claimExpiresAt: Date.now() + 20_000,
      consumed: false,
      updatedAt: Date.now(),
    };
    const resCompeting = await app.request(
      "http://localhost/paid",
      { method: "POST", headers: { [X402_HEADERS.PAYMENT_SIGNATURE]: sig } },
      env
    );
    expect(resCompeting.status).toBe(503);
    expect(resCompeting.headers.get("Retry-After")).toBe("2");
    expect(handlerCalls).toBe(0);
  });

  test("HTTP /settle normalizes non-public 'submitted' and 'queued_with_warning' statuses to 'queued'", async () => {
    const originalSettle = X402PaymentVerifier.prototype.settle;
    let currentRawStatus = "submitted";
    X402PaymentVerifier.prototype.settle = async function () {
      return {
        success: false,
        transaction: "",
        network: "stacks:2147483648",
        status: currentRawStatus,
        paymentId: "pay_http_norm_92",
      } as never;
    };
    try {
      for (const [idx, rawStatus] of ["submitted", "queued_with_warning"].entries()) {
        currentRawStatus = rawStatus;
        const harness = createTestHarness({
          async submitPayment() {
            throw new Error("unused");
          },
          async checkPayment(paymentId) {
            return { paymentId, status: "queued" };
          },
        });
        (harness.env as unknown as Record<string, unknown>).X402_RELAY = undefined;

        const txHex = await buildSignedTxHex({ sponsored: true, nonce: BigInt(92 + idx) });
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
        const body = (await res.json()) as Record<string, unknown>;
        expect(body.code).toBe(X402_ERROR_CODES.TRANSACTION_PENDING);
        expect(body.status).toBe("queued");
        expect(body.retryable).toBe(true);
        expect(harness.getHandlerCount()).toBe(0);
      }
    } finally {
      X402PaymentVerifier.prototype.settle = originalSettle;
    }
  });

  test("client with payment-identifier extension or X-PAYMENT-ID completes pending payment in warm and cold DO isolates", async () => {
    // 1. Warm isolate: client supplies payment-identifier extension pay_client_warm_93, relay mints pay_relay_warm_93
    const warmTxHex = await buildSignedTxHex({ sponsored: true, nonce: 93n });
    const clientWarmId = "pay_client_warm_93";
    const relayWarmId = "pay_relay_warm_93";
    const confirmedWarmTxid = "0x9393939393939393939393939393939393939393939393939393939393939393";
    let warmSubmitCount = 0;
    let warmCheckCount = 0;
    const warmHarness = createTestHarness({
      async submitPayment(_tx, _opts, paymentIdentifier) {
        warmSubmitCount += 1;
        expect(paymentIdentifier).toBe(clientWarmId);
        return { accepted: true, status: "queued", paymentId: relayWarmId };
      },
      async checkPayment(paymentId) {
        warmCheckCount += 1;
        expect(paymentId).toBe(relayWarmId);
        if (warmCheckCount === 1) {
          return { paymentId, status: "queued" };
        }
        return { paymentId, status: "confirmed", txid: confirmedWarmTxid };
      },
    });

    const warmSig = encodePaymentSignature({
      x402Version: 2,
      extensions: { "payment-identifier": { info: { id: clientWarmId } } },
      payload: { transaction: warmTxHex },
    });

    const warmPending = await warmHarness.app.request(
      "http://localhost/paid",
      { method: "POST", headers: { [X402_HEADERS.PAYMENT_SIGNATURE]: warmSig } },
      warmHarness.env
    );
    expect(warmPending.status).toBe(402);
    expect(warmPending.headers.get("X-PAYMENT-ID")).toBe(relayWarmId);

    // Mismatched third X-PAYMENT-ID on warm byTxHash still fails closed with 400 SENDER_MISMATCH
    const warmMismatch = await warmHarness.app.request(
      "http://localhost/paid",
      {
        method: "POST",
        headers: {
          [X402_HEADERS.PAYMENT_SIGNATURE]: warmSig,
          "X-PAYMENT-ID": "pay_wrong_warm_93",
        },
      },
      warmHarness.env
    );
    expect(warmMismatch.status).toBe(400);
    const warmMismatchBody = (await warmMismatch.json()) as Record<string, unknown>;
    expect(warmMismatchBody.code).toBe(X402_ERROR_CODES.SENDER_MISMATCH);

    // Retry with identical signed payload (still carrying clientWarmId in extension) confirms and serves 200
    const warmOk = await warmHarness.app.request(
      "http://localhost/paid",
      { method: "POST", headers: { [X402_HEADERS.PAYMENT_SIGNATURE]: warmSig } },
      warmHarness.env
    );
    expect(warmOk.status).toBe(200);
    expect(warmOk.headers.get("X-PAYMENT-ID")).toBe(relayWarmId);
    expect(warmSubmitCount).toBe(1);
    expect(warmHarness.getHandlerCount()).toBe(1);

    // 2. Cold isolate via DO: first isolate binds with callerSuppliedPaymentId, second cold isolate recovers cleanly
    const coldTxHex = await buildSignedTxHex({ sponsored: true, nonce: 94n });
    const clientColdId = "pay_client_cold_94";
    const relayColdId = "pay_relay_cold_94";
    const confirmedColdTxid = "0x9494949494949494949494949494949494949494949494949494949494949494";
    const txGuardStore = new Map<string, TxGuardRecord>();
    const sharedDO = {
      idFromName(name: string) {
        return name as unknown as DurableObjectId;
      },
      get(id: DurableObjectId) {
        const key = String(id);
        return {
          async track() {},
          async getTxGuard() {
            return txGuardStore.get(key) ?? null;
          },
          async claimTx(input: ClaimTxInput): Promise<ClaimTxResult> {
            const existing = txGuardStore.get(key);
            if (existing?.consumed) return { status: "consumed", record: existing };
            if (existing?.relayPaymentId) return { status: "bound", record: existing };
            return {
              status: "claimed",
              record: {
                txHash: input.txHash,
                claimId: input.claimId,
                callerSuppliedPaymentId: input.callerSuppliedPaymentId,
                consumed: false,
                updatedAt: Date.now(),
              },
            };
          },
          async releaseTxClaim() {},
          async bindTxPayment(input: BindTxPaymentInput) {
            const rec: TxGuardRecord = {
              txHash: input.txHash,
              relayPaymentId: input.relayPaymentId,
              callerSuppliedPaymentId: input.callerSuppliedPaymentId,
              expectedRecipient: input.expectedRecipient,
              minAmount: input.minAmount,
              asset: input.asset,
              network: input.network,
              verifiedPayer: input.verifiedPayer,
              requestBindingHash: input.requestBindingHash,
              boundAt: input.boundAt ?? Date.now(),
              consumed: false,
              updatedAt: Date.now(),
            };
            txGuardStore.set(key, rec);
            return rec;
          },
          async clearBoundTx() {
            txGuardStore.delete(key);
          },
          async markTxConsumed(input: MarkTxConsumedInput) {
            const existing = txGuardStore.get(key);
            const rec: TxGuardRecord = {
              ...existing,
              txHash: input.txHash,
              relayPaymentId: input.relayPaymentId ?? existing?.relayPaymentId,
              callerSuppliedPaymentId:
                input.callerSuppliedPaymentId ?? existing?.callerSuppliedPaymentId,
              consumed: true,
              consumedAt: Date.now(),
              consumedTxid: input.txid,
              updatedAt: Date.now(),
            };
            txGuardStore.set(key, rec);
            return { alreadyConsumed: false, record: rec };
          },
        };
      },
    } as unknown as Env["PAYMENT_POLLING_DO"];

    let coldSubmitCount = 0;
    let coldCheckCount = 0;
    const makeColdIsolateApp = () => {
      let handlers = 0;
      const app = new Hono<{ Bindings: Env; Variables: AppVariables }>();
      app.use("*", async (c, next) => {
        c.set("logger", { debug() {}, info() {}, warn() {}, error() {} });
        await next();
      });
      app.use("/paid", x402Middleware({ tier: "standard", rpcPollMaxAttempts: 1, rpcPollIntervalMs: 0 }));
      app.post("/paid", (c) => {
        handlers += 1;
        return c.json({ ok: true });
      });
      const env = {
        ENVIRONMENT: "development",
        X402_FACILITATOR_URL: "https://facilitator.example",
        X402_NETWORK: "testnet",
        X402_SERVER_ADDRESS: TEST_SELLER_ADDRESS,
        X402_RELAY: {
          async submitPayment() {
            coldSubmitCount += 1;
            return { accepted: true, status: "queued", paymentId: relayColdId };
          },
          async checkPayment(paymentId: string) {
            coldCheckCount += 1;
            expect(paymentId).toBe(relayColdId);
            if (coldCheckCount === 1) {
              return { paymentId, status: "queued" };
            }
            return { paymentId, status: "confirmed", txid: confirmedColdTxid };
          },
        },
        PAYMENT_POLLING_DO: sharedDO,
      } as unknown as Env;
      return { app, env, getHandlers: () => handlers };
    };

    const coldSig = encodePaymentSignature({
      x402Version: 2,
      extensions: { "payment-identifier": { info: { id: clientColdId } } },
      payload: { transaction: coldTxHex },
    });

    const isoA = makeColdIsolateApp();
    const resColdPending = await isoA.app.request(
      "http://localhost/paid",
      { method: "POST", headers: { [X402_HEADERS.PAYMENT_SIGNATURE]: coldSig } },
      isoA.env
    );
    expect(resColdPending.status).toBe(402);
    expect(resColdPending.headers.get("X-PAYMENT-ID")).toBe(relayColdId);

    // Separate cold isolate rejects bogus caller id via hydrateFromDORecord
    const isoBad = makeColdIsolateApp();
    const resColdMismatch = await isoBad.app.request(
      "http://localhost/paid",
      {
        method: "POST",
        headers: {
          [X402_HEADERS.PAYMENT_SIGNATURE]: coldSig,
          "X-PAYMENT-ID": "pay_wrong_cold_94",
        },
      },
      isoBad.env
    );
    expect(resColdMismatch.status).toBe(400);
    expect(((await resColdMismatch.json()) as Record<string, unknown>).code).toBe(
      X402_ERROR_CODES.SENDER_MISMATCH
    );
    expect(isoBad.getHandlers()).toBe(0);

    // Separate cold isolate retries with identical payload (clientColdId) → hydrates from DO & confirms
    const isoB = makeColdIsolateApp();
    const resColdOk = await isoB.app.request(
      "http://localhost/paid",
      { method: "POST", headers: { [X402_HEADERS.PAYMENT_SIGNATURE]: coldSig } },
      isoB.env
    );
    expect(resColdOk.status).toBe(200);
    expect(resColdOk.headers.get("X-PAYMENT-ID")).toBe(relayColdId);
    expect(coldSubmitCount).toBe(1);
    expect(isoB.getHandlers()).toBe(1);
  });

  test("fails closed with 503 Retry-After when DO markTxConsumed fails after HTTP or NOT_SPONSORED settlement and recovers on retry without double-serve", async () => {
    const originalSettle = X402PaymentVerifier.prototype.settle;
    let settleReturnTxid = "0x9010901090109010901090109010901090109010901090109010901090109010";
    X402PaymentVerifier.prototype.settle = async function () {
      return {
        success: true,
        transaction: settleReturnTxid,
        network: "stacks:2147483648",
        payer: TEST_BUYER_ADDRESS,
      } as never;
    };

    try {
      // Case A: Pure HTTP facilitator path with bound DO failing markTxConsumed across isolates
      let shouldFailConsumeA = true;
      const storeA = new Map<string, TxGuardRecord>();
      const makeDoNamespaceA = (): Env["PAYMENT_POLLING_DO"] =>
        ({
          idFromName(name: string) {
            return name as unknown as DurableObjectId;
          },
          get(id: DurableObjectId) {
            const key = String(id);
            return {
              async track() {},
              async getTxGuard() {
                return storeA.get(key) ?? null;
              },
              async markTxConsumed(input: MarkTxConsumedInput) {
                if (shouldFailConsumeA) {
                  throw new Error("DO write failed after HTTP settle");
                }
                const existing = storeA.get(key);
                if (existing?.consumed) {
                  return { alreadyConsumed: true, record: existing };
                }
                const rec: TxGuardRecord = {
                  txHash: input.txHash,
                  relayPaymentId: input.relayPaymentId,
                  callerSuppliedPaymentId: input.callerSuppliedPaymentId,
                  consumed: true,
                  consumedTxid: input.txid,
                  expectedRecipient: input.expectedRecipient,
                  minAmount: input.minAmount,
                  asset: input.asset,
                  network: input.network,
                  verifiedPayer: input.verifiedPayer,
                  updatedAt: Date.now(),
                };
                storeA.set(key, rec);
                return { alreadyConsumed: false, record: rec };
              },
            };
          },
        }) as unknown as Env["PAYMENT_POLLING_DO"];

      const isoA1 = createTestHarness();
      (isoA1.env as unknown as Record<string, unknown>).X402_RELAY = undefined;
      (isoA1.env as unknown as Record<string, unknown>).PAYMENT_POLLING_DO = makeDoNamespaceA();

      const isoA2 = createTestHarness();
      (isoA2.env as unknown as Record<string, unknown>).X402_RELAY = undefined;
      (isoA2.env as unknown as Record<string, unknown>).PAYMENT_POLLING_DO = makeDoNamespaceA();

      const txHexA = await buildSignedTxHex({ sponsored: true, nonce: 901n });
      const sigA = encodePaymentSignature({ x402Version: 2, payload: { transaction: txHexA } });

      // Isolate 1 fails closed with 503 + Retry-After: 5 when markTxConsumed throws
      const resA1 = await isoA1.app.request(
        "http://localhost/paid",
        { method: "POST", headers: { [X402_HEADERS.PAYMENT_SIGNATURE]: sigA } },
        isoA1.env
      );
      expect(resA1.status).toBe(503);
      expect(resA1.headers.get("Retry-After")).toBe("5");
      expect(isoA1.getHandlerCount()).toBe(0);
      const bodyA1 = (await resA1.json()) as Record<string, unknown>;
      expect(bodyA1.retryable).toBe(true);
      expect(bodyA1.retryAfter).toBe(5);

      // Isolate 2 must also fail closed while DO is down (cannot double-serve)
      const resA2Down = await isoA2.app.request(
        "http://localhost/paid",
        { method: "POST", headers: { [X402_HEADERS.PAYMENT_SIGNATURE]: sigA } },
        isoA2.env
      );
      expect(resA2Down.status).toBe(503);
      expect(isoA2.getHandlerCount()).toBe(0);

      // DO recovers: retry succeeds once (200), and subsequent replay returns 402
      shouldFailConsumeA = false;
      const resA2Recovered = await isoA2.app.request(
        "http://localhost/paid",
        { method: "POST", headers: { [X402_HEADERS.PAYMENT_SIGNATURE]: sigA } },
        isoA2.env
      );
      expect(resA2Recovered.status).toBe(200);
      expect(isoA2.getHandlerCount()).toBe(1);

      const resAReplay = await isoA1.app.request(
        "http://localhost/paid",
        { method: "POST", headers: { [X402_HEADERS.PAYMENT_SIGNATURE]: sigA } },
        isoA1.env
      );
      expect(resAReplay.status).toBe(402);
      expect(isoA1.getHandlerCount()).toBe(0);

      // Case B: NOT_SPONSORED -> HTTP compatibility fallback releases held claim and fails closed 503 on markTxConsumed error
      settleReturnTxid = "0x9020902090209020902090209020902090209020902090209020902090209020";
      let shouldFailConsumeB = true;
      let releaseClaimCalls = 0;
      const storeB = new Map<string, TxGuardRecord>();
      const makeDoNamespaceB = (): Env["PAYMENT_POLLING_DO"] =>
        ({
          idFromName(name: string) {
            return name as unknown as DurableObjectId;
          },
          get(id: DurableObjectId) {
            const key = String(id);
            return {
              async track() {},
              async getTxGuard() {
                return storeB.get(key) ?? null;
              },
              async claimTx(input: ClaimTxInput): Promise<ClaimTxResult> {
                const existing = storeB.get(key);
                if (existing?.consumed) return { status: "consumed", record: existing };
                if (existing?.relayPaymentId) return { status: "bound", record: existing };
                if (existing?.claimId && existing.claimId !== input.claimId) {
                  return { status: "in_progress", record: existing };
                }
                const rec: TxGuardRecord = {
                  txHash: input.txHash,
                  claimId: input.claimId,
                  claimedAt: Date.now(),
                  callerSuppliedPaymentId: input.callerSuppliedPaymentId,
                  consumed: false,
                  expectedRecipient: input.expectedRecipient,
                  minAmount: input.minAmount,
                  asset: input.asset,
                  network: input.network,
                  verifiedPayer: input.verifiedPayer,
                  requestBindingHash: input.requestBindingHash,
                  updatedAt: Date.now(),
                };
                storeB.set(key, rec);
                return { status: "claimed", record: rec };
              },
              async releaseTxClaim(claimId: string) {
                releaseClaimCalls += 1;
                const existing = storeB.get(key);
                if (existing && !existing.consumed && !existing.relayPaymentId && existing.claimId === claimId) {
                  storeB.delete(key);
                }
              },
              async markTxConsumed(input: MarkTxConsumedInput) {
                if (shouldFailConsumeB) {
                  throw new Error("DO write failed after NOT_SPONSORED HTTP settle");
                }
                const existing = storeB.get(key);
                if (existing?.consumed) {
                  return { alreadyConsumed: true, record: existing };
                }
                const rec: TxGuardRecord = {
                  txHash: input.txHash,
                  relayPaymentId: input.relayPaymentId,
                  consumed: true,
                  consumedTxid: input.txid,
                  updatedAt: Date.now(),
                };
                storeB.set(key, rec);
                return { alreadyConsumed: false, record: rec };
              },
            };
          },
        }) as unknown as Env["PAYMENT_POLLING_DO"];

      const nonSponsoredRelay: RelayRPC = {
        async submitPayment() {
          return {
            accepted: false,
            code: "NOT_SPONSORED",
            retryable: false,
            error: "Standard transaction not eligible for sponsor",
          } as never;
        },
        async checkPayment(paymentId: string) {
          return { paymentId, status: "not_found" };
        },
      };

      const isoB1 = createTestHarness(nonSponsoredRelay);
      (isoB1.env as unknown as Record<string, unknown>).PAYMENT_POLLING_DO = makeDoNamespaceB();
      const isoB2 = createTestHarness(nonSponsoredRelay);
      (isoB2.env as unknown as Record<string, unknown>).PAYMENT_POLLING_DO = makeDoNamespaceB();

      const txHexB = await buildSignedTxHex({ sponsored: false, nonce: 902n });
      const sigB = encodePaymentSignature({ x402Version: 2, payload: { transaction: txHexB } });

      const resB1 = await isoB1.app.request(
        "http://localhost/paid",
        { method: "POST", headers: { [X402_HEADERS.PAYMENT_SIGNATURE]: sigB } },
        isoB1.env
      );
      expect(resB1.status).toBe(503);
      expect(resB1.headers.get("Retry-After")).toBe("5");
      expect(releaseClaimCalls).toBe(1);
      expect(isoB1.getHandlerCount()).toBe(0);

      // Because claim was released cleanly, recovery on isoB2 is NOT stalled by in_progress lock once DO heals
      shouldFailConsumeB = false;
      const resB2 = await isoB2.app.request(
        "http://localhost/paid",
        { method: "POST", headers: { [X402_HEADERS.PAYMENT_SIGNATURE]: sigB } },
        isoB2.env
      );
      expect(resB2.status).toBe(200);
      expect(isoB2.getHandlerCount()).toBe(1);

      const resBReplay = await isoB1.app.request(
        "http://localhost/paid",
        { method: "POST", headers: { [X402_HEADERS.PAYMENT_SIGNATURE]: sigB } },
        isoB1.env
      );
      expect(resBReplay.status).toBe(402);
      expect(isoB1.getHandlerCount()).toBe(0);
    } finally {
      X402PaymentVerifier.prototype.settle = originalSettle;
    }
  });

  test("reused X-PAYMENT-ID header does not block a brand-new signed transaction after HTTP or RPC settlement", async () => {
    const originalSettle = X402PaymentVerifier.prototype.settle;
    let settleCounter = 0;
    X402PaymentVerifier.prototype.settle = async function () {
      settleCounter += 1;
      return {
        success: true,
        transaction: `0x903${settleCounter}`.padEnd(66, "a"),
        network: "stacks:2147483648",
        payer: TEST_BUYER_ADDRESS,
      } as never;
    };

    try {
      const httpHarness = createTestHarness();
      (httpHarness.env as unknown as Record<string, unknown>).X402_RELAY = undefined;

      const reusedClientId = "pay_client_reused_903";
      const tx1Hex = await buildSignedTxHex({ sponsored: true, nonce: 903n });
      const sig1 = encodePaymentSignature({ x402Version: 2, payload: { transaction: tx1Hex } });

      const res1 = await httpHarness.app.request(
        "http://localhost/paid",
        {
          method: "POST",
          headers: {
            [X402_HEADERS.PAYMENT_SIGNATURE]: sig1,
            "X-PAYMENT-ID": reusedClientId,
          },
        },
        httpHarness.env
      );
      expect(res1.status).toBe(200);
      expect(res1.headers.get("X-PAYMENT-ID")).toBe(reusedClientId);
      expect(httpHarness.getHandlerCount()).toBe(1);

      // Brand-new tx2 reusing the exact same X-PAYMENT-ID header must succeed (200)
      const tx2Hex = await buildSignedTxHex({ sponsored: true, nonce: 904n });
      const sig2 = encodePaymentSignature({ x402Version: 2, payload: { transaction: tx2Hex } });

      const res2 = await httpHarness.app.request(
        "http://localhost/paid",
        {
          method: "POST",
          headers: {
            [X402_HEADERS.PAYMENT_SIGNATURE]: sig2,
            "X-PAYMENT-ID": reusedClientId,
          },
        },
        httpHarness.env
      );
      expect(res2.status).toBe(200);
      expect(httpHarness.getHandlerCount()).toBe(2);

      // Even if caller echoes an old relay-minted pay_ ID from a consumed RPC payment onto a new HTTP tx4
      // or a new RPC tx5, neither entry check nor post-settle check rejects the new transaction
      const rpcPaymentId = "pay_rpc_reused_905";
      let rpcCounter = 0;
      const rpcHarness = createTestHarness({
        async submitPayment() {
          rpcCounter += 1;
          return {
            accepted: true,
            status: "queued",
            paymentId: rpcCounter === 1 ? rpcPaymentId : `pay_rpc_fresh_${rpcCounter}`,
          };
        },
        async checkPayment(paymentId: string) {
          return {
            paymentId,
            status: "confirmed",
            txid: `0x905${rpcCounter}`.padEnd(66, "b"),
            payer: TEST_BUYER_ADDRESS,
          };
        },
      });
      const tx3Hex = await buildSignedTxHex({ sponsored: true, nonce: 905n });
      const sig3 = encodePaymentSignature({ x402Version: 2, payload: { transaction: tx3Hex } });

      const res3 = await rpcHarness.app.request(
        "http://localhost/paid",
        { method: "POST", headers: { [X402_HEADERS.PAYMENT_SIGNATURE]: sig3 } },
        rpcHarness.env
      );
      expect(res3.status).toBe(200);
      expect(res3.headers.get("X-PAYMENT-ID")).toBe(rpcPaymentId);

      const tx4Hex = await buildSignedTxHex({ sponsored: true, nonce: 906n });
      const sig4 = encodePaymentSignature({ x402Version: 2, payload: { transaction: tx4Hex } });
      const res4 = await httpHarness.app.request(
        "http://localhost/paid",
        {
          method: "POST",
          headers: {
            [X402_HEADERS.PAYMENT_SIGNATURE]: sig4,
            "X-PAYMENT-ID": rpcPaymentId,
          },
        },
        httpHarness.env
      );
      expect(res4.status).toBe(200);
      expect(httpHarness.getHandlerCount()).toBe(3);

      const tx5Hex = await buildSignedTxHex({ sponsored: true, nonce: 910n });
      const sig5 = encodePaymentSignature({ x402Version: 2, payload: { transaction: tx5Hex } });
      const res5 = await rpcHarness.app.request(
        "http://localhost/paid",
        {
          method: "POST",
          headers: {
            [X402_HEADERS.PAYMENT_SIGNATURE]: sig5,
            "X-PAYMENT-ID": rpcPaymentId,
          },
        },
        rpcHarness.env
      );
      expect(res5.status).toBe(200);
      expect(res5.headers.get("X-PAYMENT-ID")).toBe("pay_rpc_fresh_2");
      expect(rpcHarness.getHandlerCount()).toBe(2);
    } finally {
      X402PaymentVerifier.prototype.settle = originalSettle;
    }
  });

  test("NOT_SPONSORED -> HTTP fallback skips PaymentPollingDO tracking when /settle omits paymentId/checkStatusUrl, and tracks explicit pay_ IDs when present", async () => {
    const originalSettle = X402PaymentVerifier.prototype.settle;
    let settlePayload: Record<string, unknown> = {
      success: true,
      transaction: "0x9070907090709070907090709070907090709070907090709070907090709070",
      network: "stacks:2147483648",
      payer: TEST_BUYER_ADDRESS,
    };
    X402PaymentVerifier.prototype.settle = async function () {
      return settlePayload as never;
    };

    try {
      const relay: RelayRPC = {
        async submitPayment() {
          return {
            accepted: false,
            code: "NOT_SPONSORED",
            retryable: false,
            error: "Standard transaction not sponsored",
          } as never;
        },
        async checkPayment(paymentId: string) {
          return { paymentId, status: "not_found" };
        },
      };

      const harnessA = createTestHarness(relay);
      const txHexA = await buildSignedTxHex({ sponsored: false, nonce: 907n });
      const sigA = encodePaymentSignature({ x402Version: 2, payload: { transaction: txHexA } });

      const resA = await harnessA.app.request(
        "http://localhost/paid",
        {
          method: "POST",
          headers: {
            [X402_HEADERS.PAYMENT_SIGNATURE]: sigA,
            "X-PAYMENT-ID": "pay_attempt_http_907",
          },
        },
        harnessA.env
      );
      expect(resA.status).toBe(200);
      expect(resA.headers.get("X-PAYMENT-ID")).toBe("pay_attempt_http_907");
      expect(harnessA.trackedPayments.length).toBe(0);

      // When /settle explicitly returns a relay-minted pay_ paymentId, track that pay_ ID in PaymentPollingDO
      settlePayload = {
        success: true,
        transaction: "0x9080908090809080908090809080908090809080908090809080908090809080",
        network: "stacks:2147483648",
        payer: TEST_BUYER_ADDRESS,
        paymentId: "pay_http_explicit_908",
      };
      const harnessB = createTestHarness(relay);
      const txHexB = await buildSignedTxHex({ sponsored: false, nonce: 908n });
      const sigB = encodePaymentSignature({ x402Version: 2, payload: { transaction: txHexB } });

      const resB = await harnessB.app.request(
        "http://localhost/paid",
        {
          method: "POST",
          headers: {
            [X402_HEADERS.PAYMENT_SIGNATURE]: sigB,
            "X-PAYMENT-ID": "pay_attempt_http_908",
          },
        },
        harnessB.env
      );
      expect(resB.status).toBe(200);
      expect(resB.headers.get("X-PAYMENT-ID")).toBe("pay_http_explicit_908");
      expect(harnessB.trackedPayments.length).toBe(1);
      expect(harnessB.trackedPayments[0].paymentId).toBe("pay_http_explicit_908");
    } finally {
      X402PaymentVerifier.prototype.settle = originalSettle;
    }
  });

  test("HTTP path checks DO getTxGuard before calling verifier.settle and fails closed 503 on DO outage without settling", async () => {
    const originalSettle = X402PaymentVerifier.prototype.settle;
    let settleCalls = 0;
    X402PaymentVerifier.prototype.settle = async function () {
      settleCalls += 1;
      return {
        success: true,
        transaction: "0x9110911091109110911091109110911091109110911091109110911091109110",
        network: "stacks:2147483648",
        payer: TEST_BUYER_ADDRESS,
      } as never;
    };

    try {
      const harness = createTestHarness();
      (harness.env as unknown as Record<string, unknown>).X402_RELAY = undefined;
      (harness.env as unknown as Record<string, unknown>).PAYMENT_POLLING_DO = {
        idFromName(name: string) {
          return name as unknown as DurableObjectId;
        },
        get() {
          return {
            async getTxGuard() {
              throw new Error("DO unavailable before settle");
            },
          };
        },
      } as unknown as Env["PAYMENT_POLLING_DO"];

      const txHex = await buildSignedTxHex({ sponsored: true, nonce: 911n });
      const sig = encodePaymentSignature({ x402Version: 2, payload: { transaction: txHex } });
      const res = await harness.app.request(
        "http://localhost/paid",
        { method: "POST", headers: { [X402_HEADERS.PAYMENT_SIGNATURE]: sig } },
        harness.env
      );
      expect(res.status).toBe(503);
      expect(res.headers.get("Retry-After")).toBe("5");
      expect(settleCalls).toBe(0);
      expect(harness.getHandlerCount()).toBe(0);
    } finally {
      X402PaymentVerifier.prototype.settle = originalSettle;
    }
  });

  test("cold-isolate RPC path calls claimTx directly without redundant pre-submit getTxGuard DO round trip", async () => {
    let getTxGuardCalls = 0;
    let claimTxCalls = 0;
    let bindTxPaymentCalls = 0;
    let markTxConsumedCalls = 0;
    const store = new Map<string, TxGuardRecord>();

    const relayId = "pay_single_rt_909";
    const confirmedTxid = "0x9090909090909090909090909090909090909090909090909090909090909090";
    const harness = createTestHarness({
      async submitPayment() {
        return {
          accepted: true,
          status: "queued",
          paymentId: relayId,
          checkStatusUrl: `https://relay.example/payment/${relayId}`,
        };
      },
      async checkPayment(paymentId: string) {
        return {
          paymentId,
          status: "confirmed",
          txid: confirmedTxid,
          payer: TEST_BUYER_ADDRESS,
        };
      },
    });

    (harness.env as unknown as Record<string, unknown>).PAYMENT_POLLING_DO = {
      idFromName(name: string) {
        return name as unknown as DurableObjectId;
      },
      get(id: DurableObjectId) {
        const key = String(id);
        return {
          async track() {},
          async getTxGuard() {
            getTxGuardCalls += 1;
            return store.get(key) ?? null;
          },
          async claimTx(input: ClaimTxInput): Promise<ClaimTxResult> {
            claimTxCalls += 1;
            const rec: TxGuardRecord = {
              txHash: input.txHash,
              claimId: input.claimId,
              claimedAt: Date.now(),
              consumed: false,
              expectedRecipient: input.expectedRecipient,
              minAmount: input.minAmount,
              asset: input.asset,
              network: input.network,
              verifiedPayer: input.verifiedPayer,
              requestBindingHash: input.requestBindingHash,
              updatedAt: Date.now(),
            };
            store.set(key, rec);
            return { status: "claimed", record: rec };
          },
          async bindTxPayment(input: BindTxPaymentInput) {
            bindTxPaymentCalls += 1;
            const rec: TxGuardRecord = {
              txHash: input.txHash,
              relayPaymentId: input.relayPaymentId,
              consumed: false,
              expectedRecipient: input.expectedRecipient,
              minAmount: input.minAmount,
              asset: input.asset,
              network: input.network,
              verifiedPayer: input.verifiedPayer,
              requestBindingHash: input.requestBindingHash,
              boundAt: input.boundAt ?? Date.now(),
              updatedAt: Date.now(),
            };
            store.set(key, rec);
            return rec;
          },
          async markTxConsumed(input: MarkTxConsumedInput) {
            markTxConsumedCalls += 1;
            const existing = store.get(key);
            const rec: TxGuardRecord = {
              ...(existing ?? {}),
              txHash: input.txHash,
              relayPaymentId: input.relayPaymentId,
              consumed: true,
              consumedTxid: input.txid,
              updatedAt: Date.now(),
            };
            store.set(key, rec);
            return { alreadyConsumed: false, record: rec };
          },
        };
      },
    } as unknown as Env["PAYMENT_POLLING_DO"];

    const txHex = await buildSignedTxHex({ sponsored: true, nonce: 909n });
    const sig = encodePaymentSignature({ x402Version: 2, payload: { transaction: txHex } });

    const res = await harness.app.request(
      "http://localhost/paid",
      { method: "POST", headers: { [X402_HEADERS.PAYMENT_SIGNATURE]: sig } },
      harness.env
    );
    expect(res.status).toBe(200);
    expect(getTxGuardCalls).toBe(0);
    expect(claimTxCalls).toBe(1);
    expect(bindTxPaymentCalls).toBe(1);
    expect(markTxConsumedCalls).toBe(1);
  });

  test("retry after terminal RPC failure uses a fresh settlementAttemptId and bypasses relay PaymentIdService 300s cache", async () => {
    const txHex = await buildSignedTxHex({ sponsored: true, nonce: 912n });
    const clientStickyId = "pay_client_sticky_912";
    const seenPaymentIds: string[] = [];
    const relayCache = new Map<string, string>();
    let nextRelaySeq = 0;

    const harness = createTestHarness({
      async submitPayment(_tx, _opts, paymentIdentifier) {
        expect(paymentIdentifier).toBeDefined();
        seenPaymentIds.push(paymentIdentifier!);
        const existing = relayCache.get(paymentIdentifier!);
        if (existing) {
          return { accepted: true, status: "queued", paymentId: existing };
        }
        nextRelaySeq += 1;
        const relayId = nextRelaySeq === 1 ? "pay_dead_912" : `pay_fresh_${nextRelaySeq}`;
        relayCache.set(paymentIdentifier!, relayId);
        return { accepted: true, status: "queued", paymentId: relayId };
      },
      async checkPayment(paymentId: string) {
        if (paymentId === "pay_dead_912") {
          return {
            paymentId,
            status: "failed",
            terminalReason: "internal_error",
          };
        }
        return {
          paymentId,
          status: "confirmed",
          txid: "0x9120912091209120912091209120912091209120912091209120912091209120",
          payer: TEST_BUYER_ADDRESS,
        };
      },
    });

    const sig = encodePaymentSignature({
      x402Version: 2,
      extensions: { "payment-identifier": { info: { id: clientStickyId } } },
      payload: { transaction: txHex },
    });

    // Attempt 1 fails terminally after enqueue (internal_error hints retry_later)
    const failRes = await harness.app.request(
      "http://localhost/paid",
      {
        method: "POST",
        headers: {
          [X402_HEADERS.PAYMENT_SIGNATURE]: sig,
          "X-PAYMENT-ID": clientStickyId,
        },
      },
      harness.env
    );
    expect(failRes.status).toBe(402);
    expect(seenPaymentIds[0]).toBe(clientStickyId);

    // Retry with exact same signed tx + caller X-PAYMENT-ID must mint a fresh settlementAttemptId (not cached pay_dead_912)
    const retryRes = await harness.app.request(
      "http://localhost/paid",
      {
        method: "POST",
        headers: {
          [X402_HEADERS.PAYMENT_SIGNATURE]: sig,
          "X-PAYMENT-ID": clientStickyId,
        },
      },
      harness.env
    );
    expect(retryRes.status).toBe(200);
    expect(seenPaymentIds.length).toBe(2);
    expect(seenPaymentIds[1]).toMatch(/^pay_[0-9a-f]{28}$/);
    expect(seenPaymentIds[1]).not.toBe(seenPaymentIds[0]);
    expect(retryRes.headers.get("X-PAYMENT-ID")).toBe("pay_fresh_2");
    expect(harness.getHandlerCount()).toBe(1);

    // Cold-isolate sync via DO claimTx.failedAttempts: when DO reports failedAttempts > isolate count, middleware refreshes attempt ID
    const freshTxHex = await buildSignedTxHex({ sponsored: true, nonce: 913n });
    const coldSeenIds: string[] = [];
    const coldHarness = createTestHarness({
      async submitPayment(_tx, _opts, paymentIdentifier) {
        if (paymentIdentifier) coldSeenIds.push(paymentIdentifier);
        return { accepted: true, status: "queued", paymentId: "pay_cold_fresh_913" };
      },
      async checkPayment(paymentId: string) {
        return {
          paymentId,
          status: "confirmed",
          txid: "0x9130913091309130913091309130913091309130913091309130913091309130",
          payer: TEST_BUYER_ADDRESS,
        };
      },
    });
    (coldHarness.env as unknown as Record<string, unknown>).PAYMENT_POLLING_DO = {
      idFromName(name: string) {
        return name as unknown as DurableObjectId;
      },
      get() {
        return {
          async track() {},
          async claimTx(input: ClaimTxInput): Promise<ClaimTxResult> {
            return {
              status: "claimed",
              record: {
                txHash: input.txHash,
                claimId: input.claimId,
                failedAttempts: 1,
                consumed: false,
                updatedAt: Date.now(),
              },
            };
          },
          async bindTxPayment(input: BindTxPaymentInput) {
            return {
              ...input,
              boundAt: Date.now(),
              consumed: false,
              updatedAt: Date.now(),
            };
          },
          async markTxConsumed(input: MarkTxConsumedInput) {
            return {
              alreadyConsumed: false,
              record: { txHash: input.txHash, relayPaymentId: input.relayPaymentId, consumed: true, updatedAt: Date.now() },
            };
          },
        };
      },
    } as unknown as Env["PAYMENT_POLLING_DO"];

    const baseCorrId = await deriveRequestCorrelationId(
      freshTxHex.replace(/^0x/, ""),
      TEST_SELLER_ADDRESS,
      "1000",
      "STX"
    );
    const coldSig = encodePaymentSignature({ x402Version: 2, payload: { transaction: freshTxHex } });
    const coldRes = await coldHarness.app.request(
      "http://localhost/paid",
      { method: "POST", headers: { [X402_HEADERS.PAYMENT_SIGNATURE]: coldSig } },
      coldHarness.env
    );
    expect(coldRes.status).toBe(200);
    expect(coldSeenIds.length).toBe(1);
    expect(coldSeenIds[0]).toMatch(/^pay_[0-9a-f]{28}$/);
    expect(coldSeenIds[0]).not.toBe(baseCorrId);
  });

  test("HTTP markTxConsumed with undefined boundAt does not poison CONSUMED_PAYMENTS.byRelayId during cross-isolate hydration", async () => {
    const originalSettle = X402PaymentVerifier.prototype.settle;
    let settleSeq = 0;
    X402PaymentVerifier.prototype.settle = async function () {
      settleSeq += 1;
      return {
        success: true,
        transaction: `0x914${settleSeq}`.padEnd(66, "c"),
        network: "stacks:2147483648",
        payer: TEST_BUYER_ADDRESS,
      } as never;
    };

    try {
      const store = new Map<string, TxGuardRecord>();
      const doNamespace = {
        idFromName(name: string) {
          return name as unknown as DurableObjectId;
        },
        get(id: DurableObjectId) {
          const key = String(id);
          return {
            async track() {},
            async getTxGuard() {
              return store.get(key) ?? null;
            },
            async claimTx(input: ClaimTxInput): Promise<ClaimTxResult> {
              const existing = store.get(key);
              if (existing?.consumed) return { status: "consumed", record: existing };
              return {
                status: "claimed",
                record: { txHash: input.txHash, claimId: input.claimId, consumed: false, updatedAt: Date.now() },
              };
            },
            async bindTxPayment() {
              throw new Error("unused");
            },
            async markTxConsumed(input: MarkTxConsumedInput) {
              const existing = store.get(key);
              const rec: TxGuardRecord = {
                ...existing,
                txHash: input.txHash,
                relayPaymentId: input.relayPaymentId,
                callerSuppliedPaymentId: input.callerSuppliedPaymentId,
                boundAt: existing?.boundAt,
                consumed: true,
                consumedTxid: input.txid,
                consumedAt: Date.now(),
                updatedAt: Date.now(),
              };
              store.set(key, rec);
              return { alreadyConsumed: false, record: rec };
            },
          };
        },
      } as unknown as Env["PAYMENT_POLLING_DO"];

      const callerChosenId = "pay_caller_http_hydrate_914";
      const tx1Hex = await buildSignedTxHex({ sponsored: true, nonce: 914n });
      const sig1 = encodePaymentSignature({ x402Version: 2, payload: { transaction: tx1Hex } });

      // Isolate 1 settles tx1 on HTTP path -> markTxConsumed records boundAt=undefined
      const iso1 = createTestHarness();
      (iso1.env as unknown as Record<string, unknown>).X402_RELAY = undefined;
      (iso1.env as unknown as Record<string, unknown>).PAYMENT_POLLING_DO = doNamespace;

      const res1 = await iso1.app.request(
        "http://localhost/paid",
        {
          method: "POST",
          headers: {
            [X402_HEADERS.PAYMENT_SIGNATURE]: sig1,
            "X-PAYMENT-ID": callerChosenId,
          },
        },
        iso1.env
      );
      expect(res1.status).toBe(200);

      // Replay tx1 with a different tx hash check bypassed only via new nonce? Wait: replay tx1 via another route/RPC
      // Force cross-isolate DO hydration of consumed tx1 on iso2
      const iso2 = createTestHarness({
        async submitPayment() {
          throw new Error("should stop at DO consumed check");
        },
        async checkPayment(paymentId: string) {
          return { paymentId, status: "queued" };
        },
      });
      (iso2.env as unknown as Record<string, unknown>).PAYMENT_POLLING_DO = doNamespace;

      const replayRes = await iso2.app.request(
        "http://localhost/paid",
        {
          method: "POST",
          headers: {
            [X402_HEADERS.PAYMENT_SIGNATURE]: sig1,
            "X-PAYMENT-ID": callerChosenId,
          },
        },
        iso2.env
      );
      expect(replayRes.status).toBe(402);

      // Brand-new tx2 reusing the same callerChosenId must NOT be rejected by entry CONSUMED_PAYMENTS.byRelayId check
      const tx2Hex = await buildSignedTxHex({ sponsored: true, nonce: 915n });
      const sig2 = encodePaymentSignature({ x402Version: 2, payload: { transaction: tx2Hex } });
      const res2 = await iso1.app.request(
        "http://localhost/paid",
        {
          method: "POST",
          headers: {
            [X402_HEADERS.PAYMENT_SIGNATURE]: sig2,
            "X-PAYMENT-ID": callerChosenId,
          },
        },
        iso1.env
      );
      expect(res2.status).toBe(200);
      expect(iso1.getHandlerCount()).toBe(2);
    } finally {
      X402PaymentVerifier.prototype.settle = originalSettle;
    }
  });

  test("explicit retryable=false from relay overrides retryable computeDerivedHints defaults and omits Retry-After", async () => {
    // 1. Pre-enqueue rejection with INTERNAL_ERROR and retryable: false
    const tx1Hex = await buildSignedTxHex({ sponsored: true, nonce: 916n });
    const submitRejectHarness = createTestHarness({
      async submitPayment() {
        return {
          accepted: false,
          code: "INTERNAL_ERROR",
          retryable: false,
          error: "Permanent internal error",
        } as never;
      },
      async checkPayment(paymentId: string) {
        return { paymentId, status: "not_found" };
      },
    });
    const resPre = await submitRejectHarness.app.request(
      "http://localhost/paid",
      {
        method: "POST",
        headers: {
          [X402_HEADERS.PAYMENT_SIGNATURE]: encodePaymentSignature({
            x402Version: 2,
            payload: { transaction: tx1Hex },
          }),
        },
      },
      submitRejectHarness.env
    );
    expect(resPre.status).toBe(402);
    expect(resPre.headers.get("Retry-After")).toBeNull();
    const bodyPre = (await resPre.json()) as Record<string, unknown>;
    expect(bodyPre.code).toBe(X402_ERROR_CODES.TRANSACTION_FAILED);
    expect(bodyPre.terminalReason).toBe("internal_error");
    expect(bodyPre.retryable).toBe(false);
    expect(bodyPre.nextSteps).toBe("start_new_payment");
    expect(bodyPre.retryAfter).toBeUndefined();

    // 2. Post-enqueue terminal failure from checkPayment with terminalReason: internal_error and retryable: false
    const tx2Hex = await buildSignedTxHex({ sponsored: true, nonce: 917n });
    const pollRejectHarness = createTestHarness({
      async submitPayment() {
        return {
          accepted: true,
          status: "queued",
          paymentId: "pay_nonretry_poll_917",
        };
      },
      async checkPayment(paymentId: string) {
        return {
          paymentId,
          status: "failed",
          terminalReason: "internal_error",
          retryable: false,
        } as never;
      },
    });
    const resPoll = await pollRejectHarness.app.request(
      "http://localhost/paid",
      {
        method: "POST",
        headers: {
          [X402_HEADERS.PAYMENT_SIGNATURE]: encodePaymentSignature({
            x402Version: 2,
            payload: { transaction: tx2Hex },
          }),
        },
      },
      pollRejectHarness.env
    );
    expect(resPoll.status).toBe(402);
    expect(resPoll.headers.get("Retry-After")).toBeNull();
    const bodyPoll = (await resPoll.json()) as Record<string, unknown>;
    expect(bodyPoll.code).toBe(X402_ERROR_CODES.TRANSACTION_FAILED);
    expect(bodyPoll.terminalReason).toBe("internal_error");
    expect(bodyPoll.retryable).toBe(false);
    expect(bodyPoll.nextSteps).toBe("start_new_payment");
    expect(bodyPoll.retryAfter).toBeUndefined();

    // 3. Preserves non-retryable specific nextSteps (fix_and_resend) when derivedHints already has retryable=false
    const tx3Hex = await buildSignedTxHex({ sponsored: true, nonce: 918n });
    const invalidHarness = createTestHarness({
      async submitPayment() {
        return {
          accepted: false,
          code: "INVALID_TRANSACTION",
          retryable: false,
          error: "Bad signature",
        } as never;
      },
      async checkPayment(paymentId: string) {
        return { paymentId, status: "not_found" };
      },
    });
    const resInvalid = await invalidHarness.app.request(
      "http://localhost/paid",
      {
        method: "POST",
        headers: {
          [X402_HEADERS.PAYMENT_SIGNATURE]: encodePaymentSignature({
            x402Version: 2,
            payload: { transaction: tx3Hex },
          }),
        },
      },
      invalidHarness.env
    );
    expect(resInvalid.status).toBe(402);
    expect(resInvalid.headers.get("Retry-After")).toBeNull();
    const bodyInvalid = (await resInvalid.json()) as Record<string, unknown>;
    expect(bodyInvalid.retryable).toBe(false);
    expect(bodyInvalid.nextSteps).toBe("fix_and_resend");
  });
});
