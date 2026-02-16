/**
 * OpenRouter Chat Completion Endpoint
 *
 * Dynamic pricing based on model and estimated tokens.
 * Supports both streaming and non-streaming responses.
 */

import { BaseEndpoint } from "../../base";
import { OpenRouterClient, OpenRouterError } from "../../../services/openrouter";
import { logPnL } from "../../../services/pricing";
import { tokenTypeParam } from "../../schema";
import type { AppContext, ChatCompletionRequest, UsageRecord } from "../../../types";

export class OpenRouterChat extends BaseEndpoint {
  schema = {
    tags: ["Inference - OpenRouter"],
    summary: "(paid, dynamic) Create a chat completion via OpenRouter",
    description: "Send messages to an LLM model via OpenRouter. Pricing is dynamic based on model and token usage.",
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
                description: "Model ID (e.g., openai/gpt-4o, anthropic/claude-3-haiku)",
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
              temperature: { type: "number" as const, minimum: 0, maximum: 2 },
              max_tokens: { type: "integer" as const, minimum: 1 },
              stream: { type: "boolean" as const, default: false },
              top_p: { type: "number" as const },
              frequency_penalty: { type: "number" as const },
              presence_penalty: { type: "number" as const },
              stop: {
                oneOf: [
                  { type: "string" as const },
                  { type: "array" as const, items: { type: "string" as const } },
                ],
              },
            },
          },
        },
      },
    },
    parameters: [tokenTypeParam],
    responses: {
      "200": {
        description: "Chat completion response",
        content: {
          "application/json": {
            schema: {
              type: "object" as const,
              properties: {
                id: { type: "string" as const },
                model: { type: "string" as const },
                choices: {
                  type: "array" as const,
                  items: {
                    type: "object" as const,
                    properties: {
                      index: { type: "integer" as const },
                      message: {
                        type: "object" as const,
                        properties: {
                          role: { type: "string" as const },
                          content: { type: "string" as const },
                        },
                      },
                      finish_reason: { type: "string" as const },
                    },
                  },
                },
                usage: {
                  type: "object" as const,
                  properties: {
                    prompt_tokens: { type: "integer" as const },
                    completion_tokens: { type: "integer" as const },
                    total_tokens: { type: "integer" as const },
                  },
                },
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
      "500": { description: "Server error" },
    },
  };

  async handle(c: AppContext) {
    const log = c.var.logger;
    const startTime = Date.now();

    if (!c.env.OPENROUTER_API_KEY) {
      return this.errorResponse(c, "OpenRouter API key not configured", 500);
    }

    // Get payment context (body was parsed by middleware)
    const x402 = c.var.x402;
    if (!x402) {
      return this.errorResponse(c, "Payment context not found", 500);
    }

    const request = x402.parsedBody as ChatCompletionRequest;
    if (!request?.model || !request?.messages) {
      return this.errorResponse(c, "model and messages are required", 400);
    }

    const client = new OpenRouterClient(c.env.OPENROUTER_API_KEY, log);

    try {
      if (request.stream) {
        // Streaming response
        const { stream, usagePromise } = await client.createChatCompletionStream(request);

        // Record usage after stream completes (in background)
        c.executionCtx.waitUntil(
          usagePromise.then(async (usage) => {
            const durationMs = Date.now() - startTime;

            if (usage && x402.priceEstimate) {
              logPnL(
                x402.priceEstimate,
                usage.estimatedCostUsd,
                usage.promptTokens,
                usage.completionTokens,
                log
              );
            }

            // Record usage in DO
            if (x402.payerAddress && c.env.USAGE_DO) {
              try {
                const usageDOId = c.env.USAGE_DO.idFromName(x402.payerAddress);
                const usageDO = c.env.USAGE_DO.get(usageDOId);
                const record: UsageRecord = {
                  requestId: c.var.requestId,
                  endpoint: "/inference/openrouter/chat",
                  category: "inference",
                  payerAddress: x402.payerAddress,
                  pricingType: "dynamic",
                  amountCharged: Number(x402.priceEstimate?.amountInToken || 0),
                  token: x402.priceEstimate?.tokenType || "STX",
                  model: usage?.model || request.model,
                  inputTokens: usage?.promptTokens,
                  outputTokens: usage?.completionTokens,
                  durationMs,
                };
                await usageDO.recordUsage(record);
              } catch (err) {
                log.error("Failed to record usage", { error: String(err) });
              }
            }
          })
        );

        return new Response(stream, {
          headers: {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            Connection: "keep-alive",
            "X-Payer-Address": x402.payerAddress,
          },
        });
      } else {
        // Non-streaming response
        const { response, usage } = await client.createChatCompletion(request);
        const durationMs = Date.now() - startTime;

        // Log PnL
        if (x402.priceEstimate) {
          logPnL(
            x402.priceEstimate,
            usage.estimatedCostUsd,
            usage.promptTokens,
            usage.completionTokens,
            log
          );
        }

        // Record usage in DO
        if (x402.payerAddress && c.env.USAGE_DO) {
          c.executionCtx.waitUntil(
            (async () => {
              try {
                const usageDOId = c.env.USAGE_DO.idFromName(x402.payerAddress);
                const usageDO = c.env.USAGE_DO.get(usageDOId);
                const record: UsageRecord = {
                  requestId: c.var.requestId,
                  endpoint: "/inference/openrouter/chat",
                  category: "inference",
                  payerAddress: x402.payerAddress,
                  pricingType: "dynamic",
                  amountCharged: Number(x402.priceEstimate?.amountInToken || 0),
                  token: x402.priceEstimate?.tokenType || "STX",
                  model: usage.model,
                  inputTokens: usage.promptTokens,
                  outputTokens: usage.completionTokens,
                  durationMs,
                };
                await usageDO.recordUsage(record);
              } catch (err) {
                log.error("Failed to record usage", { error: String(err) });
              }
            })()
          );
        }

        return c.json(response);
      }
    } catch (error) {
      if (error instanceof OpenRouterError) {
        log.error("OpenRouter chat error", {
          status: error.status,
          message: error.message,
          model: request.model,
        });

        if (error.retryable) {
          c.header("Retry-After", "5");
        }

        return this.errorResponse(
          c,
          error.message,
          error.status >= 500 ? 502 : error.status === 429 ? 429 : 500
        );
      }

      log.error("Unexpected chat error", {
        error: error instanceof Error ? error.message : String(error),
        model: request.model,
      });
      return this.errorResponse(c, "Chat completion failed", 500);
    }
  }
}
