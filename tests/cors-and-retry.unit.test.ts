import { describe, expect, mock, test } from "bun:test";
import { X402_HEADERS } from "x402-stacks";

mock.module("cloudflare:workers", () => ({
  DurableObject: class DurableObject<E = unknown> {
    ctx: unknown;
    env: E;
    constructor(ctx: unknown, env: E) {
      this.ctx = ctx;
      this.env = env;
    }
  },
}));

const { default: app } = await import("../src/index");
const { makeX402RequestWithRetry } = await import("./_shared_utils");

describe("CORS headers in src/index.ts", () => {
  test("allows X-PAYMENT-ID and exposes X-PAYMENT-ID and Retry-After on preflight and responses", async () => {
    const preflightRes = await app.request(
      "http://localhost/health",
      {
        method: "OPTIONS",
        headers: {
          Origin: "https://client.example",
          "Access-Control-Request-Method": "POST",
          "Access-Control-Request-Headers": "X-PAYMENT-ID, payment-signature",
        },
      },
      { ENVIRONMENT: "development" } as never
    );

    expect(preflightRes.status).toBe(204);
    const allowHeaders = (preflightRes.headers.get("Access-Control-Allow-Headers") ?? "")
      .split(",")
      .map((h) => h.trim().toLowerCase());
    expect(allowHeaders).toContain("x-payment-id");

    const exposeHeaders = (preflightRes.headers.get("Access-Control-Expose-Headers") ?? "")
      .split(",")
      .map((h) => h.trim().toLowerCase());
    expect(exposeHeaders).toContain("x-payment-id");
    expect(exposeHeaders).toContain("retry-after");

    const getRes = await app.request(
      "http://localhost/health",
      {
        method: "GET",
        headers: { Origin: "https://client.example" },
      },
      { ENVIRONMENT: "development" } as never
    );
    expect(getRes.status).toBe(200);
    const getExpose = (getRes.headers.get("Access-Control-Expose-Headers") ?? "")
      .split(",")
      .map((h) => h.trim().toLowerCase());
    expect(getExpose).toContain("x-payment-id");
    expect(getExpose).toContain("retry-after");
  });
});

describe("_shared_utils makeX402RequestWithRetry loop termination", () => {
  test("exits cleanly without throwing when maxRetries non-pending retries exhaust after a pending retry", async () => {
    const originalFetch = globalThis.fetch;
    let paidCallCount = 0;

    const paymentRequiredPayload = {
      x402Version: 2,
      resource: { url: "/paid", description: "test", mimeType: "application/json" },
      accepts: [
        {
          scheme: "exact",
          network: "stacks:2147483648",
          amount: "1000",
          asset: "STX",
          payTo: "ST37NMC4HGFQ1H2JSFP4H3TMNQBF4PY0MVSD1GV7Z",
          maxTimeoutSeconds: 300,
        },
      ],
    };

    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url.includes("/extended/v1/address/")) {
        return new Response(JSON.stringify({ possible_next_nonce: 1 }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }

      const headers = new Headers(init?.headers);
      if (!headers.get(X402_HEADERS.PAYMENT_SIGNATURE)) {
        return new Response(JSON.stringify(paymentRequiredPayload), {
          status: 402,
          headers: {
            "Content-Type": "application/json",
            [X402_HEADERS.PAYMENT_REQUIRED]: Buffer.from(
              JSON.stringify(paymentRequiredPayload)
            ).toString("base64"),
          },
        });
      }

      paidCallCount += 1;
      if (paidCallCount === 1) {
        // First paid attempt: in-flight pending (counts toward pendingRetryCount, NOT nonPendingRetryCount)
        return new Response(
          JSON.stringify({
            error: "Transaction pending",
            code: "TRANSACTION_PENDING",
            status: "queued",
            paymentId: "pay_loop_1",
            retryable: true,
          }),
          { status: 402, headers: { "Content-Type": "application/json" } }
        );
      }

      // Subsequent attempts: retryable 503 exhausting maxRetries=1 while pendingRetryCount < maxPendingRetries
      return new Response(
        JSON.stringify({
          error: "Service temporarily unavailable",
          code: "QUEUE_UNAVAILABLE",
          retryable: true,
          retryAfter: 0,
        }),
        { status: 503, headers: { "Content-Type": "application/json" } }
      );
    }) as unknown as typeof fetch;

    try {
      const mockClient = {
        privateKey:
          "753b7cc01a1a2e86221266a154af739463fce51219d97e4f856cd7200c3bd2a601",
        async signSTXTransfer() {
          return { success: true, signedTransaction: "0xdeadbeef" };
        },
      };

      const result = await makeX402RequestWithRetry("/paid", "POST", mockClient, "STX", {
        baseUrl: "http://localhost",
        body: { test: true },
        retry: {
          maxRetries: 1,
          baseDelayMs: 1,
          maxDelayMs: 2,
          nonceConflictDelayMs: 1,
        },
      });

      expect(result.status).toBe(503);
      expect(paidCallCount).toBe(3); // 1 pending -> 1 non-pending retry -> final 503
      expect(result.retryCount).toBe(2);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
