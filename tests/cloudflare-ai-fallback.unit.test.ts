#!/usr/bin/env bun
/**
 * Unit tests for Cloudflare AI timeout fallback behavior
 *
 * Covers:
 * 1. Non-streaming timeout fallback: primary throws "3046" error -> fallback_model in response
 * 2. Streaming timeout fallback: primary throws "3046" error -> X-Fallback-Model header
 * 3. Normal path (no fallback): primary succeeds -> no fallback metadata
 * 4. Non-retryable error: primary throws non-timeout error -> error returned immediately, no retry
 *
 * Approach: direct handler unit tests using a minimal Hono app with mocked c.env.AI.
 * No x402 payment flow is needed — the x402 middleware is not mounted in these tests.
 */

import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { CloudflareChat } from "../src/endpoints/inference/cloudflare/chat";
import type { Env, AppVariables, Logger } from "../src/types";

// ---------------------------------------------------------------------------
// Constants mirrored from the source (not re-exported, but stable)
// ---------------------------------------------------------------------------

const DEFAULT_CF_MODEL = "@cf/meta/llama-3.1-8b-instruct";
const FALLBACK_CF_MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/** Minimal no-op logger that satisfies the Logger interface */
function makeLogger(): Logger {
  return {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
    child: function () {
      return this;
    },
  };
}

/**
 * Build a minimal Hono test app that:
 *  - Injects a mock AI binding via c.env
 *  - Sets up c.var.logger and c.var.requestId
 *  - Skips x402 payment (sets a stub c.var.x402)
 *  - Mounts the CloudflareChat handler at POST /inference/cloudflare/chat
 */
function buildTestApp(mockAI: Partial<Ai>) {
  const app = new Hono<{ Bindings: Env; Variables: AppVariables }>();

  // Middleware: inject env + vars before route handler
  app.use("/inference/cloudflare/chat", async (c, next) => {
    // Inject the AI binding into env
    // @ts-expect-error — we are intentionally overriding readonly env in tests
    c.env = {
      ...c.env,
      AI: mockAI as Ai,
    };

    // Set required context variables
    c.set("requestId", "test-req-id");
    c.set("logger", makeLogger());
    // Set a stub x402 context so the handler can call recordUsage safely
    c.set("x402", {
      payerAddress: "SP1TESTPAYERADDRESS",
      settleResult: { success: true, transaction: "", network: "mainnet:1", payer: "SP1TESTPAYERADDRESS" },
      priceEstimate: {
        estimatedCostUsd: 0,
        costWithMarginUsd: 0,
        amountInToken: BigInt(0),
        tokenType: "STX" as const,
        tier: "standard" as const,
      },
    });

    return next();
  });

  // Mount the handler — CloudflareChat extends OpenAPIRoute so we call handle() directly
  const handler = new CloudflareChat();
  app.post("/inference/cloudflare/chat", (c) => handler.handle(c));

  return app;
}

/** Standard chat request body */
const CHAT_BODY = {
  model: DEFAULT_CF_MODEL,
  messages: [{ role: "user", content: "Hello" }],
};

/** Helper to post to the chat endpoint */
async function postChat(
  app: ReturnType<typeof buildTestApp>,
  body: Record<string, unknown> = CHAT_BODY
) {
  return app.request("/inference/cloudflare/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("CloudflareChat timeout fallback behavior", () => {
  test("non-streaming: timeout on primary model triggers fallback, response includes fallback_model", async () => {
    let callCount = 0;

    const mockAI = {
      run: async (model: string, _opts: unknown) => {
        callCount++;
        if (model === DEFAULT_CF_MODEL) {
          // Simulate Cloudflare error code 3046
          throw new Error("Inference request failed: error code 3046");
        }
        // Fallback model succeeds
        return { response: "Hello from fallback" };
      },
    };

    const app = buildTestApp(mockAI);
    const res = await postChat(app);

    expect(res.status).toBe(200);
    const data = (await res.json()) as Record<string, unknown>;

    expect(data.ok).toBe(true);
    expect(data.fallback_model).toBe(FALLBACK_CF_MODEL);
    expect(data.response).toBe("Hello from fallback");
    // The original requested model is preserved in the `model` field
    expect(data.model).toBe(DEFAULT_CF_MODEL);
    // Two AI calls: primary (timeout) + fallback (success)
    expect(callCount).toBe(2);
  });

  test("streaming: timeout on primary model triggers fallback, response includes X-Fallback-Model header", async () => {
    let callCount = 0;

    // Minimal ReadableStream stub for streaming responses
    const fakeStream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('data: {"response":"hi"}\n\n'));
        controller.close();
      },
    });

    const mockAI = {
      run: async (model: string, _opts: unknown) => {
        callCount++;
        if (model === DEFAULT_CF_MODEL) {
          throw new Error("Request timed out");
        }
        // Fallback succeeds and returns a stream
        return fakeStream;
      },
    };

    const app = buildTestApp(mockAI);
    const res = await postChat(app, {
      model: DEFAULT_CF_MODEL,
      messages: [{ role: "user", content: "Hello" }],
      stream: true,
    });

    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("text/event-stream");
    expect(res.headers.get("X-Fallback-Model")).toBe(FALLBACK_CF_MODEL);
    expect(callCount).toBe(2);
  });

  test("normal path: primary model succeeds, no fallback metadata in response", async () => {
    let callCount = 0;

    const mockAI = {
      run: async (_model: string, _opts: unknown) => {
        callCount++;
        return { response: "Hello from primary" };
      },
    };

    const app = buildTestApp(mockAI);
    const res = await postChat(app);

    expect(res.status).toBe(200);
    const data = (await res.json()) as Record<string, unknown>;

    expect(data.ok).toBe(true);
    expect(data.fallback_model).toBeUndefined();
    // Response headers should not include X-Fallback-Model
    expect(res.headers.get("X-Fallback-Model")).toBeNull();
    expect(data.response).toBe("Hello from primary");
    // Only one AI call (no retry)
    expect(callCount).toBe(1);
  });

  test("non-streaming normal path: no X-Fallback-Model header", async () => {
    const mockAI = {
      run: async (_model: string, _opts: unknown) => {
        return { response: "Success" };
      },
    };

    const app = buildTestApp(mockAI);
    const res = await postChat(app);

    expect(res.status).toBe(200);
    expect(res.headers.get("X-Fallback-Model")).toBeNull();
  });

  test("non-retryable error: primary throws non-timeout error, handler returns error immediately without retry", async () => {
    let callCount = 0;

    const mockAI = {
      run: async (_model: string, _opts: unknown) => {
        callCount++;
        // Non-timeout error (Model not found, which maps to 404 / non-retryable)
        throw new Error("Model not found");
      },
    };

    const app = buildTestApp(mockAI);
    const res = await postChat(app);

    // Should return 404 (MODEL_NOT_FOUND is non-retryable)
    expect(res.status).toBe(404);
    const data = (await res.json()) as Record<string, unknown>;
    expect(data.ok).toBe(false);
    expect(data.error_code).toBe("MODEL_NOT_FOUND");
    expect(data.retryable).toBe(false);
    // Only one call — no fallback retry for non-timeout errors
    expect(callCount).toBe(1);
  });

  test("non-retryable error (internal): primary throws generic error, returns 502 without retry", async () => {
    let callCount = 0;

    const mockAI = {
      run: async (_model: string, _opts: unknown) => {
        callCount++;
        throw new Error("Unexpected internal error from Cloudflare AI");
      },
    };

    const app = buildTestApp(mockAI);
    const res = await postChat(app);

    expect(res.status).toBe(502);
    const data = (await res.json()) as Record<string, unknown>;
    expect(data.ok).toBe(false);
    expect(data.error_code).toBe("INTERNAL_ERROR");
    expect(data.retryable).toBe(false);
    // Only one call — no retry for internal errors
    expect(callCount).toBe(1);
  });

  test("AbortError name triggers timeout fallback", async () => {
    let callCount = 0;

    const mockAI = {
      run: async (model: string, _opts: unknown) => {
        callCount++;
        if (model === DEFAULT_CF_MODEL) {
          const err = new Error("Aborted");
          err.name = "AbortError";
          throw err;
        }
        return { response: "Fallback response" };
      },
    };

    const app = buildTestApp(mockAI);
    const res = await postChat(app);

    expect(res.status).toBe(200);
    const data = (await res.json()) as Record<string, unknown>;
    expect(data.fallback_model).toBe(FALLBACK_CF_MODEL);
    expect(callCount).toBe(2);
  });

  test("error response does not include fallback_model field", async () => {
    const mockAI = {
      run: async (_model: string, _opts: unknown) => {
        throw new Error("Rate limit exceeded");
      },
    };

    const app = buildTestApp(mockAI);
    const res = await postChat(app);

    expect(res.status).toBe(429);
    const data = (await res.json()) as Record<string, unknown>;
    expect(data.ok).toBe(false);
    expect(data.fallback_model).toBeUndefined();
  });
});
