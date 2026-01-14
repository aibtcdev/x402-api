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
  X402_WORKER_URL,
  createTestLogger,
  STEP_DELAY_MS,
  DEFAULT_MAX_RETRIES,
  isRetryableError,
  calculateBackoff,
  sleep,
  parseErrorResponse,
  parseResponseData,
  type JsonBody,
} from "./_shared_utils";

interface X402PaymentRequired {
  maxAmountRequired: string;
  resource: string;
  payTo: string;
  network: "mainnet" | "testnet";
  nonce: string;
  expiresAt: string;
  tokenType: TokenType;
}

// =============================================================================
// Test Configuration
// =============================================================================

/** Models to test - using cheap/fast options */
const TEST_MODELS = {
  openrouter: [
    "meta-llama/llama-3.1-8b-instruct",
    "mistralai/mistral-7b-instruct",
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

/** Get 3 random questions from the pool */
function getRandomQuestions(count: number = 3): string[] {
  const shuffled = [...QUESTION_POOL].sort(() => Math.random() - 0.5);
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
  logger: ReturnType<typeof createTestLogger>,
  maxRetries: number = DEFAULT_MAX_RETRIES
): Promise<{ status: number; data: unknown }> {
  const url = `${X402_WORKER_URL}${endpoint}?tokenType=${tokenType}`;

  let lastErrorStatus = 0;
  let lastErrorData: unknown = "Failed to get payment requirement";

  // Get 402 payment requirement
  let initialRes: Response | null = null;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      initialRes = await fetch(url, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

      if (initialRes.status === 402) break;

      if (initialRes.status === 200) {
        const text = await initialRes.text();
        return { status: 200, data: parseResponseData(text) };
      }

      const text = await initialRes.text();
      const errorInfo = parseErrorResponse(text);
      lastErrorStatus = initialRes.status;
      lastErrorData = parseResponseData(text);

      if (isRetryableError(initialRes.status, errorInfo.errorCode, errorInfo.errorMessage || text) && attempt < maxRetries) {
        const delayMs = calculateBackoff(attempt, errorInfo.retryAfterSecs);
        logger.debug(`Initial request failed (${initialRes.status}), retry ${attempt + 1}/${maxRetries} in ${delayMs}ms`);
        await sleep(delayMs);
        continue;
      }

      return { status: lastErrorStatus, data: lastErrorData };
    } catch (fetchError) {
      lastErrorStatus = 0;
      lastErrorData = { error: String(fetchError), code: "NETWORK_ERROR" };

      if (attempt < maxRetries) {
        const delayMs = calculateBackoff(attempt);
        logger.debug(`Fetch error, retry ${attempt + 1}/${maxRetries} in ${delayMs}ms`);
        await sleep(delayMs);
        continue;
      }
      return { status: lastErrorStatus, data: lastErrorData };
    }
  }

  if (!initialRes || initialRes.status !== 402) {
    return { status: lastErrorStatus, data: lastErrorData };
  }

  const paymentReq: X402PaymentRequired = await initialRes.json();
  logger.debug("402 Payment req", paymentReq);

  const signResult = await x402Client.signPayment(paymentReq);
  logger.debug("Signed payment");

  // Make paid request with longer timeout for LLM
  lastErrorStatus = 0;
  lastErrorData = "Exhausted retries on paid request";

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const retryRes = await fetch(url, {
        method,
        headers: {
          "Content-Type": "application/json",
          "X-PAYMENT": signResult.signedTransaction,
          "X-PAYMENT-TOKEN-TYPE": tokenType,
        },
        body: JSON.stringify(body),
      });

      if (retryRes.status === 200) {
        const text = await retryRes.text();
        return { status: 200, data: parseResponseData(text) };
      }

      const text = await retryRes.text();
      const errorInfo = parseErrorResponse(text);
      lastErrorStatus = retryRes.status;
      lastErrorData = parseResponseData(text);

      if (isRetryableError(retryRes.status, errorInfo.errorCode, errorInfo.errorMessage || text) && attempt < maxRetries) {
        const delayMs = calculateBackoff(attempt, errorInfo.retryAfterSecs);
        logger.debug(`Paid request failed (${retryRes.status}), retry ${attempt + 1}/${maxRetries} in ${delayMs}ms`);
        await sleep(delayMs);
        continue;
      }

      return { status: lastErrorStatus, data: lastErrorData };
    } catch (fetchError) {
      lastErrorStatus = 0;
      lastErrorData = { error: String(fetchError), code: "NETWORK_ERROR" };

      if (attempt < maxRetries) {
        const delayMs = calculateBackoff(attempt);
        logger.debug(`Fetch error on paid request, retry ${attempt + 1}/${maxRetries} in ${delayMs}ms`);
        await sleep(delayMs);
        continue;
      }
      return { status: lastErrorStatus, data: lastErrorData };
    }
  }

  return { status: lastErrorStatus, data: lastErrorData };
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

  // Get random questions for this test run
  const questions = getRandomQuestions(3);
  logger.info(`Testing with questions: ${questions.map((q) => q.slice(0, 30) + "...").join(", ")}`);

  let successCount = 0;
  let testIndex = 0;

  // Total tests: 2 OpenRouter models + 1 Cloudflare = 3 models
  // Each model gets 1 question (to keep costs low)
  const totalTests = TEST_MODELS.openrouter.length + 1;

  // Test OpenRouter models
  for (let i = 0; i < TEST_MODELS.openrouter.length; i++) {
    const model = TEST_MODELS.openrouter[i];
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
