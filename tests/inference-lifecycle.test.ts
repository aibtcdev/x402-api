#!/usr/bin/env bun
/**
 * Inference (LLM Chat) Lifecycle Test
 *
 * Tests LLM chat completions across multiple providers and models:
 * - OpenRouter: 2 models (cheap options)
 * - Cloudflare AI: 1 model
 *
 * Uses random questions to verify response structure (not content).
 */

import type { TokenType } from "x402-stacks";
import { X402PaymentClient } from "x402-stacks";
import { deriveChildAccount } from "../src/utils/wallet";
import {
  X402_CLIENT_PK,
  X402_NETWORK,
  createTestLogger,
  STEP_DELAY_MS,
  makeX402RequestWithRetry,
  sleep,
  NONCE_CONFLICT_DELAY_MS,
  type JsonBody,
} from "./_shared_utils";

// =============================================================================
// Test Configuration
// =============================================================================

/** Models to test - using cheap/fast options, picked randomly */
const TEST_MODELS = {
  openrouter: [
    "meta-llama/llama-3.1-8b-instruct",
    "moonshotai/kimi-k2.5",
    "minimax/minimax-m2.5",
    "google/gemini-2.5-flash-preview",
    "x-ai/grok-4.1-mini",
  ],
  cloudflare: "@cf/meta/llama-3.1-8b-instruct",
};

/** Random questions pool - simple questions for fast responses */
const QUESTION_POOL = [
  "What is 2 + 2?",
  "Name a primary color.",
  "What planet is closest to the Sun?",
  "How many legs does a spider have?",
  "What is the chemical symbol for water?",
  "Is the sky blue? Answer yes or no.",
  "What comes after Monday?",
  "How many sides does a triangle have?",
];

/** Get N random items from an array */
function pickRandom<T>(items: T[], count: number): T[] {
  const shuffled = [...items].sort(() => Math.random() - 0.5);
  return shuffled.slice(0, count);
}

// =============================================================================
// Response Validators
// =============================================================================

interface OpenRouterResponse {
  id?: string;
  model?: string;
  choices?: Array<{
    index?: number;
    message?: {
      role?: string;
      content?: string;
    };
    finish_reason?: string;
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
}

interface CloudflareResponse {
  ok?: boolean;
  model?: string;
  response?: string;
  tokenType?: string;
}

function validateOpenRouterResponse(data: unknown): { valid: boolean; reason?: string } {
  const response = data as OpenRouterResponse;

  if (!response.choices || !Array.isArray(response.choices)) {
    return { valid: false, reason: "missing choices array" };
  }

  if (response.choices.length === 0) {
    return { valid: false, reason: "empty choices array" };
  }

  const firstChoice = response.choices[0];
  if (!firstChoice.message) {
    return { valid: false, reason: "missing message in first choice" };
  }

  if (typeof firstChoice.message.content !== "string") {
    return { valid: false, reason: "message content is not a string" };
  }

  if (firstChoice.message.content.length === 0) {
    return { valid: false, reason: "message content is empty" };
  }

  return { valid: true };
}

function validateCloudflareResponse(data: unknown): { valid: boolean; reason?: string } {
  const response = data as CloudflareResponse;

  if (response.ok !== true) {
    return { valid: false, reason: "ok is not true" };
  }

  if (typeof response.response !== "string") {
    return { valid: false, reason: "response is not a string" };
  }

  if (response.response.length === 0) {
    return { valid: false, reason: "response is empty" };
  }

  if (typeof response.model !== "string") {
    return { valid: false, reason: "model is not a string" };
  }

  return { valid: true };
}

// =============================================================================
// Request Helper
// =============================================================================

async function makeX402Request(
  x402Client: X402PaymentClient,
  endpoint: string,
  method: "POST",
  body: JsonBody,
  tokenType: TokenType,
  logger: ReturnType<typeof createTestLogger>
): Promise<{ status: number; data: unknown }> {
  logger.debug(`Requesting ${method} ${endpoint}...`);

  const result = await makeX402RequestWithRetry(endpoint, method, x402Client, tokenType, {
    body,
    retry: {
      maxRetries: 3,
      nonceConflictDelayMs: NONCE_CONFLICT_DELAY_MS,
      verbose: false,
    },
  });

  if (result.wasNonceConflict && result.retryCount > 0) {
    logger.debug(`Recovered from nonce conflict after ${result.retryCount} retries`);
  }

  return { status: result.status, data: result.data };
}

// =============================================================================
// Test Runner
// =============================================================================

export interface LifecycleTestResult {
  passed: number;
  total: number;
  success: boolean;
}

export async function runInferenceLifecycle(verbose = false): Promise<LifecycleTestResult> {
  if (!X402_CLIENT_PK) {
    throw new Error("Set X402_CLIENT_PK env var with mnemonic");
  }

  const { address, key } = await deriveChildAccount(X402_NETWORK, X402_CLIENT_PK, 0);
  const logger = createTestLogger("inference-lifecycle", verbose);
  logger.info(`Test wallet address: ${address}`);

  const x402Client = new X402PaymentClient({
    network: X402_NETWORK,
    privateKey: key,
  });

  // Use STX only to save on payments
  const tokenType: TokenType = "STX";

  // Pick 2 random OpenRouter models + 1 Cloudflare = 3 tests per run
  const selectedModels = pickRandom(TEST_MODELS.openrouter, 2);
  const questions = pickRandom(QUESTION_POOL, 3);
  logger.info(`Selected OpenRouter models: ${selectedModels.join(", ")}`);
  logger.info(`Testing with questions: ${questions.map((q) => q.slice(0, 30) + "...").join(", ")}`);

  let successCount = 0;
  let testIndex = 0;

  const totalTests = selectedModels.length + 1;

  // Test OpenRouter models
  for (let i = 0; i < selectedModels.length; i++) {
    const model = selectedModels[i];
    const question = questions[i];
    testIndex++;

    logger.info(`${testIndex}. Testing OpenRouter: ${model}`);
    logger.debug(`Question: ${question}`);

    const result = await makeX402Request(
      x402Client,
      "/inference/openrouter/chat",
      "POST",
      {
        model,
        messages: [{ role: "user", content: question }],
        max_tokens: 50,
        temperature: 0.1,
      },
      tokenType,
      logger
    );

    if (result.status === 200) {
      const validation = validateOpenRouterResponse(result.data);
      if (validation.valid) {
        const response = result.data as OpenRouterResponse;
        const content = response.choices?.[0]?.message?.content || "";
        logger.success(`${model}: "${content.slice(0, 60)}${content.length > 60 ? "..." : ""}"`);
        successCount++;
      } else {
        logger.error(`${model}: Invalid response - ${validation.reason}`);
        logger.debug("Response data", result.data);
      }
    } else {
      logger.error(`${model}: HTTP ${result.status} - ${JSON.stringify(result.data)}`);
    }

    await sleep(STEP_DELAY_MS);
  }

  // Test Cloudflare AI
  testIndex++;
  const cfModel = TEST_MODELS.cloudflare;
  const cfQuestion = questions[2];

  logger.info(`${testIndex}. Testing Cloudflare AI: ${cfModel}`);
  logger.debug(`Question: ${cfQuestion}`);

  const cfResult = await makeX402Request(
    x402Client,
    "/inference/cloudflare/chat",
    "POST",
    {
      model: cfModel,
      messages: [{ role: "user", content: cfQuestion }],
      max_tokens: 50,
      temperature: 0.1,
    },
    tokenType,
    logger
  );

  if (cfResult.status === 200) {
    const validation = validateCloudflareResponse(cfResult.data);
    if (validation.valid) {
      const response = cfResult.data as CloudflareResponse;
      const content = response.response || "";
      logger.success(`${cfModel}: "${content.slice(0, 60)}${content.length > 60 ? "..." : ""}"`);
      successCount++;
    } else {
      logger.error(`${cfModel}: Invalid response - ${validation.reason}`);
      logger.debug("Response data", cfResult.data);
    }
  } else {
    logger.error(`${cfModel}: HTTP ${cfResult.status} - ${JSON.stringify(cfResult.data)}`);
  }

  logger.summary(successCount, totalTests);
  return { passed: successCount, total: totalTests, success: successCount === totalTests };
}

// Run if executed directly
if (import.meta.main) {
  const verbose = process.argv.includes("-v") || process.argv.includes("--verbose");
  runInferenceLifecycle(verbose)
    .then((result) => process.exit(result.success ? 0 : 1))
    .catch((err) => {
      console.error("Test failed:", err);
      process.exit(1);
    });
}
