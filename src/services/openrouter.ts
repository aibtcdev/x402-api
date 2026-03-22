/**
 * OpenRouter API Service
 *
 * Handles communication with the OpenRouter API.
 * OpenRouter uses OpenAI-compatible format.
 *
 * API Reference: https://openrouter.ai/docs/api/reference/overview
 */

import type { Logger, ChatCompletionRequest, ChatCompletionResponse, ModelsResponse, UsageInfo } from "../types";
import { estimateActualCost } from "./pricing";

// =============================================================================
// Constants
// =============================================================================

const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";
const APP_REFERER = "https://aibtc.dev";
const APP_TITLE = "x402 API";

// =============================================================================
// Types
// =============================================================================

/** Streaming chunk with optional usage (in final chunk) */
export interface StreamingChunk {
  id?: string;
  object?: string;
  created?: number;
  model?: string;
  choices?: Array<{
    index: number;
    delta: {
      role?: string;
      content?: string;
    };
    finish_reason?: string | null;
  }>;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

/** Result from streaming completion */
export interface StreamingResult {
  stream: ReadableStream;
  model: string;
  /** Promise that resolves with usage info after stream completes */
  usagePromise: Promise<UsageInfo | null>;
}

// =============================================================================
// Error Class
// =============================================================================

export class OpenRouterError extends Error {
  public status: number;
  public details?: string;
  public retryable: boolean;

  constructor(message: string, status: number, details?: string) {
    super(message);
    this.name = "OpenRouterError";
    this.status = status;
    this.details = details;
    this.retryable = status >= 500 || status === 429;
  }
}

// =============================================================================
// Response Validators
// =============================================================================

/**
 * Validates a models response from OpenRouter.
 * Ensures .data is an array where each element has .id (string)
 * and .pricing with .prompt and .completion strings.
 */
export function validateModelsResponse(data: unknown): asserts data is ModelsResponse {
  if (typeof data !== "object" || data === null) {
    throw new OpenRouterError(
      "Invalid models response: expected an object",
      502,
      JSON.stringify(data).slice(0, 200)
    );
  }

  const obj = data as Record<string, unknown>;

  if (!Array.isArray(obj.data)) {
    throw new OpenRouterError(
      "Invalid models response: .data must be an array",
      502,
      JSON.stringify(data).slice(0, 200)
    );
  }

  for (let i = 0; i < obj.data.length; i++) {
    const model = obj.data[i] as Record<string, unknown>;

    if (typeof model.id !== "string") {
      throw new OpenRouterError(
        `Invalid models response: model[${i}].id must be a string`,
        502,
        JSON.stringify(model).slice(0, 200)
      );
    }

    if (typeof model.pricing !== "object" || model.pricing === null) {
      throw new OpenRouterError(
        `Invalid models response: model[${i}].pricing must be an object`,
        502,
        JSON.stringify(model).slice(0, 200)
      );
    }

    const pricing = model.pricing as Record<string, unknown>;

    if (typeof pricing.prompt !== "string") {
      throw new OpenRouterError(
        `Invalid models response: model[${i}].pricing.prompt must be a string`,
        502,
        JSON.stringify(model).slice(0, 200)
      );
    }

    if (typeof pricing.completion !== "string") {
      throw new OpenRouterError(
        `Invalid models response: model[${i}].pricing.completion must be a string`,
        502,
        JSON.stringify(model).slice(0, 200)
      );
    }
  }
}

/**
 * Validates a chat completion response from OpenRouter.
 * Ensures .choices is an array, and .usage (if present) has numeric fields.
 */
export function validateChatResponse(data: unknown): asserts data is ChatCompletionResponse {
  if (typeof data !== "object" || data === null) {
    throw new OpenRouterError(
      "Invalid chat response: expected an object",
      502,
      JSON.stringify(data).slice(0, 200)
    );
  }

  const obj = data as Record<string, unknown>;

  if (!Array.isArray(obj.choices)) {
    throw new OpenRouterError(
      "Invalid chat response: .choices must be an array",
      502,
      JSON.stringify(data).slice(0, 200)
    );
  }

  if (obj.usage !== undefined && obj.usage !== null) {
    const usage = obj.usage as Record<string, unknown>;

    if (
      typeof usage.prompt_tokens !== "number" ||
      typeof usage.completion_tokens !== "number" ||
      typeof usage.total_tokens !== "number"
    ) {
      throw new OpenRouterError(
        "Invalid chat response: .usage fields must be numbers",
        502,
        JSON.stringify(obj.usage).slice(0, 200)
      );
    }
  }
}

/**
 * Validates a streaming chunk from OpenRouter.
 * Ensures .usage (if present) has numeric token fields.
 */
export function validateStreamChunk(chunk: unknown): asserts chunk is StreamingChunk {
  if (typeof chunk !== "object" || chunk === null) {
    throw new OpenRouterError(
      "Invalid stream chunk: expected an object",
      502,
      JSON.stringify(chunk).slice(0, 200)
    );
  }

  const obj = chunk as Record<string, unknown>;

  if (obj.usage !== undefined && obj.usage !== null) {
    const usage = obj.usage as Record<string, unknown>;

    if (
      typeof usage.prompt_tokens !== "number" ||
      typeof usage.completion_tokens !== "number" ||
      typeof usage.total_tokens !== "number"
    ) {
      throw new OpenRouterError(
        "Invalid stream chunk: .usage fields must be numbers",
        502,
        JSON.stringify(obj.usage).slice(0, 200)
      );
    }
  }
}

// =============================================================================
// OpenRouter Client
// =============================================================================

export class OpenRouterClient {
  private apiKey: string;
  private log: Logger;

  constructor(apiKey: string, logger: Logger) {
    this.apiKey = apiKey;
    this.log = logger;
  }

  /**
   * Get common headers for OpenRouter requests
   */
  private getHeaders(): HeadersInit {
    return {
      Authorization: `Bearer ${this.apiKey}`,
      "Content-Type": "application/json",
      "HTTP-Referer": APP_REFERER,
      "X-Title": APP_TITLE,
    };
  }

  /**
   * Fetch available models from OpenRouter
   */
  async getModels(signal?: AbortSignal): Promise<ModelsResponse> {
    this.log.debug("Fetching models from OpenRouter");

    const response = await fetch(`${OPENROUTER_BASE_URL}/models`, {
      method: "GET",
      headers: this.getHeaders(),
      signal,
    });

    if (!response.ok) {
      const errorText = await response.text();
      this.log.error("OpenRouter models request failed", {
        status: response.status,
        error: errorText,
      });
      throw new OpenRouterError(
        `Failed to fetch models: ${response.status}`,
        response.status,
        errorText
      );
    }

    const data = (await response.json()) as ModelsResponse;
    validateModelsResponse(data);
    this.log.debug("Models fetched successfully", { count: data.data.length });

    return data;
  }

  /**
   * Create a chat completion (non-streaming)
   */
  async createChatCompletion(
    request: ChatCompletionRequest
  ): Promise<{ response: ChatCompletionResponse; usage: UsageInfo }> {
    this.log.info("Creating chat completion", {
      model: request.model,
      messageCount: request.messages.length,
    });

    const payload = { ...request, stream: false };

    const response = await fetch(`${OPENROUTER_BASE_URL}/chat/completions`, {
      method: "POST",
      headers: this.getHeaders(),
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      const errorText = await response.text();
      this.log.error("OpenRouter chat completion failed", {
        status: response.status,
        error: errorText,
        model: request.model,
      });
      throw new OpenRouterError(
        `Chat completion failed: ${response.status}`,
        response.status,
        errorText
      );
    }

    const data = (await response.json()) as ChatCompletionResponse;
    validateChatResponse(data);
    const usage = this.extractUsage(data, request.model);

    this.log.info("Chat completion successful", {
      model: data.model,
      promptTokens: usage.promptTokens,
      completionTokens: usage.completionTokens,
      estimatedCostUsd: usage.estimatedCostUsd,
    });

    return { response: data, usage };
  }

  /**
   * Create a streaming chat completion
   */
  async createChatCompletionStream(
    request: ChatCompletionRequest
  ): Promise<StreamingResult> {
    this.log.info("Creating streaming chat completion", {
      model: request.model,
      messageCount: request.messages.length,
    });

    const payload = {
      ...request,
      stream: true,
      stream_options: { include_usage: true },
    };

    const response = await fetch(`${OPENROUTER_BASE_URL}/chat/completions`, {
      method: "POST",
      headers: this.getHeaders(),
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      const errorText = await response.text();
      this.log.error("OpenRouter streaming request failed", {
        status: response.status,
        error: errorText,
        model: request.model,
      });
      throw new OpenRouterError(
        `Streaming request failed: ${response.status}`,
        response.status,
        errorText
      );
    }

    if (!response.body) {
      throw new OpenRouterError("No response body for stream", 500);
    }

    this.log.debug("Streaming response started", { model: request.model });

    let capturedUsage: UsageInfo | null = null;
    let usageResolve: (usage: UsageInfo | null) => void;
    const usagePromise = new Promise<UsageInfo | null>((resolve) => {
      usageResolve = resolve;
    });

    const transformStream = this.createUsageCapturingStream(
      response.body,
      request.model,
      (usage) => {
        capturedUsage = usage;
        this.log.info("Streaming usage captured", {
          model: usage.model,
          promptTokens: usage.promptTokens,
          completionTokens: usage.completionTokens,
          estimatedCostUsd: usage.estimatedCostUsd,
        });
        usageResolve(usage);
      },
      () => {
        if (!capturedUsage) {
          this.log.warn("Stream ended without usage data");
          usageResolve(null);
        }
      }
    );

    return {
      stream: transformStream,
      model: request.model,
      usagePromise,
    };
  }

  /**
   * Create a transform stream that passes through SSE events
   * while capturing usage from the final chunk
   */
  private createUsageCapturingStream(
    sourceStream: ReadableStream,
    requestModel: string,
    onUsage: (usage: UsageInfo) => void,
    onComplete: () => void
  ): ReadableStream {
    const log = this.log;
    let buffer = "";

    return new ReadableStream({
      async start(controller) {
        const reader = sourceStream.getReader();
        const decoder = new TextDecoder();

        try {
          while (true) {
            const { done, value } = await reader.read();

            if (done) {
              if (buffer.trim()) {
                controller.enqueue(new TextEncoder().encode(buffer));
              }
              controller.close();
              onComplete();
              break;
            }

            const text = decoder.decode(value, { stream: true });
            buffer += text;

            const lines = buffer.split("\n");
            buffer = lines.pop() || "";

            for (const line of lines) {
              if (line.startsWith("data: ")) {
                const data = line.slice(6).trim();

                if (data === "[DONE]") {
                  continue;
                }

                try {
                  const chunk = JSON.parse(data) as StreamingChunk;
                  validateStreamChunk(chunk);

                  if (chunk.usage) {
                    const usage: UsageInfo = {
                      model: chunk.model || requestModel,
                      promptTokens: chunk.usage.prompt_tokens,
                      completionTokens: chunk.usage.completion_tokens,
                      totalTokens: chunk.usage.total_tokens,
                      estimatedCostUsd: estimateActualCost(
                        chunk.usage.prompt_tokens,
                        chunk.usage.completion_tokens,
                        chunk.model || requestModel
                      ),
                    };
                    onUsage(usage);
                  }
                } catch (chunkError) {
                  log.debug("Could not parse or validate SSE chunk", {
                    data,
                    error: chunkError instanceof Error ? chunkError.message : String(chunkError),
                  });
                }
              }
            }

            controller.enqueue(value);
          }
        } catch (error) {
          log.error("Error in stream transform", {
            error: error instanceof Error ? error.message : String(error),
          });
          controller.error(error);
          onComplete();
        }
      },
    });
  }

  /**
   * Extract usage information from a completion response
   */
  private extractUsage(
    response: ChatCompletionResponse,
    requestModel: string
  ): UsageInfo {
    const usage = response.usage || {
      prompt_tokens: 0,
      completion_tokens: 0,
      total_tokens: 0,
    };

    const estimatedCostUsd = estimateActualCost(
      usage.prompt_tokens,
      usage.completion_tokens,
      response.model || requestModel
    );

    return {
      model: response.model || requestModel,
      promptTokens: usage.prompt_tokens,
      completionTokens: usage.completion_tokens,
      totalTokens: usage.total_tokens,
      estimatedCostUsd,
    };
  }
}
