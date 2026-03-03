/**
 * Cloudflare AI Chat Completion Endpoint
 *
 * Fixed AI tier pricing for chat completions via Cloudflare AI.
 */

import { AIEndpoint } from "../../base";
import type { AppContext, UsageRecord } from "../../../types";
import type { ContentfulStatusCode } from "hono/utils/http-status";

interface CloudflareAIErrorClassification {
  message: string;
  status: ContentfulStatusCode;
  error_code: string;
  retryable: boolean;
  retry_after_seconds?: number;
}

/**
 * Classify a Cloudflare AI error by inspecting its message and name.
 * Maps error patterns to appropriate HTTP status codes and retry guidance.
 */
function classifyCloudflareAIError(error: unknown): CloudflareAIErrorClassification {
  const errorMessage = error instanceof Error ? error.message : String(error);
  const errorName = error instanceof Error ? error.name : "";

  // Timeout: AbortError name, "Request timed out" message, or Cloudflare error code 3046
  if (
    errorName === "AbortError" ||
    errorMessage.includes("Request timed out") ||
    errorMessage.includes("3046")
  ) {
    return {
      message: "Request timed out",
      status: 504,
      error_code: "TIMEOUT",
      retryable: true,
      retry_after_seconds: 30,
    };
  }

  // Rate limit: explicit message or 429 code in message
  if (errorMessage.includes("Rate limit exceeded") || errorMessage.includes("429")) {
    return {
      message: "Rate limit exceeded",
      status: 429,
      error_code: "RATE_LIMIT",
      retryable: true,
      retry_after_seconds: 60,
    };
  }

  // Model not found: explicit message or 404 code in message
  if (errorMessage.includes("Model not found") || errorMessage.includes("404")) {
    return {
      message: "Model not found",
      status: 404,
      error_code: "MODEL_NOT_FOUND",
      retryable: false,
    };
  }

  // Default: internal error from upstream Cloudflare AI
  return {
    message: "Chat completion failed",
    status: 502,
    error_code: "INTERNAL_ERROR",
    retryable: false,
  };
}

interface CloudflareMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

interface CloudflareChatRequest {
  model: string;
  messages: CloudflareMessage[];
  max_tokens?: number;
  temperature?: number;
  stream?: boolean;
}

export class CloudflareChat extends AIEndpoint {
  schema = {
    tags: ["Inference"],
    summary: "(paid, ai tier) Create a chat completion via Cloudflare AI",
    description: "Send messages to a Cloudflare AI model. Fixed AI tier pricing (0.003 STX).",
    requestBody: {
      required: true,
      content: {
        "application/json": {
          schema: {
            type: "object" as const,
            required: ["model", "messages"],
            properties: {
              model: {
                type: "string" as const,
                description: "Model ID (e.g., @cf/meta/llama-3.1-8b-instruct)",
                default: "@cf/meta/llama-3.1-8b-instruct",
              },
              messages: {
                type: "array" as const,
                items: {
                  type: "object" as const,
                  required: ["role", "content"],
                  properties: {
                    role: { type: "string" as const, enum: ["system", "user", "assistant"] },
                    content: { type: "string" as const },
                  },
                },
              },
              max_tokens: { type: "integer" as const, minimum: 1, maximum: 4096, default: 1024 },
              temperature: { type: "number" as const, minimum: 0, maximum: 2, default: 0.7 },
              stream: { type: "boolean" as const, default: false },
            },
          },
        },
      },
    },
    parameters: [
      {
        name: "tokenType",
        in: "query" as const,
        required: false,
        schema: {
          type: "string" as const,
          enum: ["STX", "sBTC", "USDCx"],
          default: "STX",
        },
        description: "Payment token type",
      },
    ],
    responses: {
      "200": {
        description: "Chat completion response",
        content: {
          "application/json": {
            schema: {
              type: "object" as const,
              properties: {
                ok: { type: "boolean" as const },
                model: { type: "string" as const },
                response: { type: "string" as const },
                tokenType: { type: "string" as const },
              },
            },
          },
          "text/event-stream": {
            schema: {
              type: "string" as const,
              description: "Server-Sent Events stream",
            },
          },
        },
      },
      "400": { description: "Invalid request" },
      "402": { description: "Payment required" },
      "404": { description: "Model not found (error_code: MODEL_NOT_FOUND, retryable: false)" },
      "429": { description: "Rate limit exceeded (error_code: RATE_LIMIT, retryable: true)" },
      "502": { description: "Upstream AI error (error_code: INTERNAL_ERROR, retryable: false)" },
      "504": { description: "Request timed out (error_code: TIMEOUT, retryable: true)" },
    },
  };

  async handle(c: AppContext) {
    const log = c.var.logger;
    const startTime = Date.now();

    if (!c.env.AI) {
      return this.errorResponse(c, "Cloudflare AI not configured", 500);
    }

    // Parse request body
    const request = await this.parseBody<CloudflareChatRequest>(c);
    if (request instanceof Response) return request;

    const { model = "@cf/meta/llama-3.1-8b-instruct", messages, max_tokens = 1024, temperature = 0.7, stream = false } = request;

    if (!messages || !Array.isArray(messages) || messages.length === 0) {
      return this.errorResponse(c, "messages array is required", 400);
    }

    const tokenType = this.getTokenType(c);
    const x402 = c.var.x402;

    try {
      if (stream) {
        // Streaming response
        const response = await c.env.AI.run(model as Parameters<typeof c.env.AI.run>[0], {
          messages,
          max_tokens,
          temperature,
          stream: true,
        });

        // Record usage after stream completes
        c.executionCtx.waitUntil(
          (async () => {
            const durationMs = Date.now() - startTime;
            if (x402?.payerAddress && c.env.USAGE_DO) {
              try {
                const usageDOId = c.env.USAGE_DO.idFromName(x402.payerAddress);
                const usageDO = c.env.USAGE_DO.get(usageDOId);
                const record: UsageRecord = {
                  requestId: c.var.requestId,
                  endpoint: "/inference/cloudflare/chat",
                  category: "inference",
                  payerAddress: x402.payerAddress,
                  pricingType: "fixed",
                  tier: "standard",
                  amountCharged: Number(x402.priceEstimate?.amountInToken || 0),
                  token: tokenType,
                  model,
                  durationMs,
                };
                await usageDO.recordUsage(record);
              } catch (err) {
                log.error("Failed to record usage", { error: String(err) });
              }
            }
          })()
        );

        return new Response(response as unknown as ReadableStream, {
          headers: {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            Connection: "keep-alive",
          },
        });
      } else {
        // Non-streaming response
        const response = await c.env.AI.run(model as Parameters<typeof c.env.AI.run>[0], {
          messages,
          max_tokens,
          temperature,
          stream: false,
        });

        const durationMs = Date.now() - startTime;

        // Record usage
        if (x402?.payerAddress && c.env.USAGE_DO) {
          c.executionCtx.waitUntil(
            (async () => {
              try {
                const usageDOId = c.env.USAGE_DO.idFromName(x402.payerAddress);
                const usageDO = c.env.USAGE_DO.get(usageDOId);
                const record: UsageRecord = {
                  requestId: c.var.requestId,
                  endpoint: "/inference/cloudflare/chat",
                  category: "inference",
                  payerAddress: x402.payerAddress,
                  pricingType: "fixed",
                  tier: "standard",
                  amountCharged: Number(x402.priceEstimate?.amountInToken || 0),
                  token: tokenType,
                  model,
                  durationMs,
                };
                await usageDO.recordUsage(record);
              } catch (err) {
                log.error("Failed to record usage", { error: String(err) });
              }
            })()
          );
        }

        // Extract response text
        let responseText = "";
        if (typeof response === "object" && response !== null) {
          const aiResponse = response as { response?: string };
          responseText = aiResponse.response || "";
        }

        log.info("Cloudflare AI chat completed", {
          model,
          durationMs,
          responseLength: responseText.length,
        });

        return c.json({
          ok: true,
          model,
          response: responseText,
          tokenType,
        });
      }
    } catch (error) {
      const classified = classifyCloudflareAIError(error);

      log.error("Cloudflare AI chat error", {
        model,
        error: error instanceof Error ? error.message : String(error),
        error_code: classified.error_code,
        status: classified.status,
      });

      const extra: Record<string, unknown> = {
        error_code: classified.error_code,
        retryable: classified.retryable,
      };
      if (classified.retry_after_seconds !== undefined) {
        extra.retry_after_seconds = classified.retry_after_seconds;
      }

      return this.errorResponse(c, classified.message, classified.status, extra);
    }
  }
}
