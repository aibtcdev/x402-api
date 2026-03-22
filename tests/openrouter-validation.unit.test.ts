#!/usr/bin/env bun
/**
 * Unit tests for OpenRouter response validator functions
 *
 * Covers:
 * 1. validateModelsResponse — valid data, missing .data, non-array .data, missing .pricing fields
 * 2. validateChatResponse   — valid data, missing .choices, non-array .choices, non-numeric .usage
 * 3. validateStreamChunk    — valid usage, missing usage (should pass), non-numeric .usage, non-object
 *
 * Approach: direct imports of exported helpers. No live API calls, no x402 payment flow.
 */

import { describe, expect, test } from "bun:test";
import {
  validateModelsResponse,
  validateChatResponse,
  validateStreamChunk,
  OpenRouterError,
} from "../src/services/openrouter";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Calls `fn` and asserts it throws an OpenRouterError with the expected
 * status and (optionally) a message substring. Returns the caught error
 * for additional assertions if needed.
 */
function expectOpenRouterError(
  fn: () => void,
  status: number,
  messageSubstring?: string
): OpenRouterError {
  expect(fn).toThrow(OpenRouterError);
  try {
    fn();
    throw new Error("Expected OpenRouterError but fn did not throw");
  } catch (err) {
    expect(err).toBeInstanceOf(OpenRouterError);
    const orErr = err as OpenRouterError;
    expect(orErr.status).toBe(status);
    if (messageSubstring) {
      expect(orErr.message).toContain(messageSubstring);
    }
    return orErr;
  }
}

/** Minimal valid model entry satisfying the ModelsResponse shape */
function makeValidModel(id = "openai/gpt-4o") {
  return {
    id,
    name: "GPT-4o",
    description: "A great model",
    context_length: 128000,
    pricing: {
      prompt: "0.000005",
      completion: "0.000015",
    },
  };
}

/** Minimal valid models response */
function makeValidModelsResponse() {
  return {
    data: [makeValidModel("openai/gpt-4o"), makeValidModel("anthropic/claude-3-5-sonnet")],
  };
}

/** Minimal valid chat completion response */
function makeValidChatResponse() {
  return {
    id: "chatcmpl-abc123",
    object: "chat.completion",
    created: 1700000000,
    model: "openai/gpt-4o",
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: "Hello!" },
        finish_reason: "stop",
      },
    ],
    usage: {
      prompt_tokens: 10,
      completion_tokens: 5,
      total_tokens: 15,
    },
  };
}

/** Minimal valid streaming chunk */
function makeValidStreamChunk(withUsage = true) {
  const base = {
    id: "chatcmpl-xyz",
    object: "chat.completion.chunk",
    created: 1700000000,
    model: "openai/gpt-4o",
    choices: [
      {
        index: 0,
        delta: { content: "Hello" },
        finish_reason: null,
      },
    ],
  };
  if (!withUsage) return base;
  return {
    ...base,
    usage: {
      prompt_tokens: 10,
      completion_tokens: 5,
      total_tokens: 15,
    },
  };
}

// ---------------------------------------------------------------------------
// validateModelsResponse tests
// ---------------------------------------------------------------------------

describe("validateModelsResponse", () => {
  test("valid response with multiple models passes without throwing", () => {
    expect(() => validateModelsResponse(makeValidModelsResponse())).not.toThrow();
  });

  test("valid response with empty .data array passes", () => {
    expect(() => validateModelsResponse({ data: [] })).not.toThrow();
  });

  test("non-object input throws OpenRouterError with status 502", () => {
    expectOpenRouterError(() => validateModelsResponse("not an object"), 502);
  });

  test("null input throws OpenRouterError with status 502", () => {
    expectOpenRouterError(() => validateModelsResponse(null), 502);
  });

  test("missing .data field throws OpenRouterError", () => {
    expectOpenRouterError(() => validateModelsResponse({ models: [] }), 502, ".data must be an array");
  });

  test("non-array .data throws OpenRouterError", () => {
    expectOpenRouterError(() => validateModelsResponse({ data: "not-an-array" }), 502, ".data must be an array");
  });

  test("model with missing .pricing throws OpenRouterError", () => {
    expectOpenRouterError(() => validateModelsResponse({ data: [{ id: "openai/gpt-4o" }] }), 502, ".pricing must be an object");
  });

  test("model with missing pricing.prompt throws OpenRouterError", () => {
    const data = { data: [{ id: "openai/gpt-4o", pricing: { completion: "0.000015" } }] };
    expectOpenRouterError(() => validateModelsResponse(data), 502, "pricing.prompt must be a string");
  });

  test("model with missing pricing.completion throws OpenRouterError", () => {
    const data = { data: [{ id: "openai/gpt-4o", pricing: { prompt: "0.000005" } }] };
    expectOpenRouterError(() => validateModelsResponse(data), 502, "pricing.completion must be a string");
  });

  test("model with missing .id throws OpenRouterError", () => {
    const data = { data: [{ name: "No ID Model", pricing: { prompt: "0.0001", completion: "0.0002" } }] };
    expectOpenRouterError(() => validateModelsResponse(data), 502, ".id must be a string");
  });
});

// ---------------------------------------------------------------------------
// validateChatResponse tests
// ---------------------------------------------------------------------------

describe("validateChatResponse", () => {
  test("valid response with usage passes without throwing", () => {
    expect(() => validateChatResponse(makeValidChatResponse())).not.toThrow();
  });

  test("valid response without usage field passes without throwing", () => {
    const data = makeValidChatResponse();
    // @ts-expect-error — intentionally removing usage for test
    delete data.usage;
    expect(() => validateChatResponse(data)).not.toThrow();
  });

  test("valid response with null usage passes without throwing", () => {
    const data = { ...makeValidChatResponse(), usage: null };
    expect(() => validateChatResponse(data)).not.toThrow();
  });

  test("non-object input throws OpenRouterError with status 502", () => {
    expectOpenRouterError(() => validateChatResponse(42), 502);
  });

  test("null input throws OpenRouterError with status 502", () => {
    expectOpenRouterError(() => validateChatResponse(null), 502);
  });

  test("missing .choices field throws OpenRouterError", () => {
    const data = { id: "chatcmpl-abc", usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } };
    expectOpenRouterError(() => validateChatResponse(data), 502, ".choices must be an array");
  });

  test("non-array .choices throws OpenRouterError", () => {
    expectOpenRouterError(() => validateChatResponse({ id: "chatcmpl-abc", choices: "not-an-array" }), 502, ".choices must be an array");
  });

  test("non-numeric .usage.prompt_tokens throws OpenRouterError", () => {
    const data = { choices: [], usage: { prompt_tokens: "ten", completion_tokens: 5, total_tokens: 15 } };
    expectOpenRouterError(() => validateChatResponse(data), 502, ".usage fields must be numbers");
  });

  test("non-numeric .usage.completion_tokens throws OpenRouterError", () => {
    const data = { choices: [], usage: { prompt_tokens: 10, completion_tokens: null, total_tokens: 15 } };
    expectOpenRouterError(() => validateChatResponse(data), 502, ".usage fields must be numbers");
  });

  test("non-numeric .usage.total_tokens throws OpenRouterError", () => {
    const data = { choices: [], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: "fifteen" } };
    expectOpenRouterError(() => validateChatResponse(data), 502, ".usage fields must be numbers");
  });
});

// ---------------------------------------------------------------------------
// validateStreamChunk tests
// ---------------------------------------------------------------------------

describe("validateStreamChunk", () => {
  test("valid chunk with usage passes without throwing", () => {
    expect(() => validateStreamChunk(makeValidStreamChunk(true))).not.toThrow();
  });

  test("valid chunk without usage field passes without throwing", () => {
    expect(() => validateStreamChunk(makeValidStreamChunk(false))).not.toThrow();
  });

  test("valid chunk with null usage passes without throwing", () => {
    const chunk = { ...makeValidStreamChunk(false), usage: null };
    expect(() => validateStreamChunk(chunk)).not.toThrow();
  });

  test("non-object input throws OpenRouterError with status 502", () => {
    expectOpenRouterError(() => validateStreamChunk("not-an-object"), 502);
  });

  test("null input throws OpenRouterError", () => {
    expectOpenRouterError(() => validateStreamChunk(null), 502);
  });

  test("non-numeric .usage.prompt_tokens throws OpenRouterError", () => {
    const chunk = { ...makeValidStreamChunk(false), usage: { prompt_tokens: "ten", completion_tokens: 5, total_tokens: 15 } };
    expectOpenRouterError(() => validateStreamChunk(chunk), 502, ".usage fields must be numbers");
  });

  test("non-numeric .usage.completion_tokens throws OpenRouterError", () => {
    const chunk = { ...makeValidStreamChunk(false), usage: { prompt_tokens: 10, completion_tokens: false, total_tokens: 15 } };
    expectOpenRouterError(() => validateStreamChunk(chunk), 502, ".usage fields must be numbers");
  });

  test("non-numeric .usage.total_tokens throws OpenRouterError", () => {
    const chunk = { ...makeValidStreamChunk(false), usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: undefined } };
    expectOpenRouterError(() => validateStreamChunk(chunk), 502, ".usage fields must be numbers");
  });

  test("chunk with all numeric usage fields passes", () => {
    const chunk = {
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    };
    expect(() => validateStreamChunk(chunk)).not.toThrow();
  });
});
