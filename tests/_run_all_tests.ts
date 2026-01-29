#!/usr/bin/env bun
/**
 * X402 API Endpoint Test Runner
 *
 * Runs E2E payment tests against all registered endpoints.
 *
 * Modes:
 *   --mode=quick  (default)  Run stateless endpoints only (fast, no cleanup needed)
 *   --mode=full             Run stateless + all lifecycle tests for stateful endpoints
 *
 * Usage:
 *   bun run tests/_run_all_tests.ts                    # Quick mode, STX only
 *   bun run tests/_run_all_tests.ts --mode=full        # Full mode with lifecycle tests
 *   bun run tests/_run_all_tests.ts --all-tokens       # All endpoints, all tokens
 *   bun run tests/_run_all_tests.ts --token=sBTC       # All endpoints, specific token
 *   bun run tests/_run_all_tests.ts --category=stacks  # Single category
 *   bun run tests/_run_all_tests.ts --filter=sha256    # Filter by name
 *   bun run tests/_run_all_tests.ts --delay=1000       # 1s delay between tests
 *   bun run tests/_run_all_tests.ts --retries=3        # 3 retries for rate limits
 *
 * Randomization (for cron variance):
 *   bun run tests/_run_all_tests.ts --sample=5         # Run 5 random stateless endpoints
 *   bun run tests/_run_all_tests.ts --random-lifecycle=2  # Run 2 random lifecycle categories
 *   bun run tests/_run_all_tests.ts --random-token     # Pick one random token (STX/sBTC/USDCx)
 *   bun run tests/_run_all_tests.ts --mode=full --sample=5 --random-lifecycle=2 --random-token
 *
 * Environment:
 *   X402_CLIENT_PK      - Mnemonic for payments (required)
 *   X402_NETWORK        - Network (default: testnet)
 *   X402_WORKER_URL     - Worker URL (default: http://localhost:8787)
 *   VERBOSE=1           - Enable verbose logging
 *   TEST_DELAY_MS=500   - Delay between tests in ms (default: 500)
 *   TEST_MAX_RETRIES=2  - Max retries for rate-limited requests (default: 2)
 */

import type { TokenType, NetworkType, PaymentRequiredV2, PaymentPayloadV2 } from "x402-stacks";
import { X402PaymentClient, encodePaymentPayload, X402_HEADERS } from "x402-stacks";
import { deriveChildAccount } from "../src/utils/wallet";
import {
  STATELESS_ENDPOINTS,
  ENDPOINT_CATEGORIES,
  STATEFUL_CATEGORIES,
  isStatefulCategory,
  ENDPOINT_COUNTS,
} from "./endpoint-registry";
import type { TestConfig } from "./_test_generator";
import {
  COLORS,
  X402_CLIENT_PK,
  X402_NETWORK,
  X402_WORKER_URL,
  TEST_TOKENS,
  createTestLogger,
  DEFAULT_TEST_DELAY_MS,
  POST_LIFECYCLE_DELAY_MS,
  isRetryableError,
  isNonceConflict,
  calculateBackoff,
  sleep,
  NONCE_CONFLICT_DELAY_MS,
  sampleArray,
  pickRandom,
} from "./_shared_utils";

// Import lifecycle test runners
import { runKvLifecycle } from "./kv-lifecycle.test";
import { runPasteLifecycle } from "./paste-lifecycle.test";
import { runDbLifecycle } from "./db-lifecycle.test";
import { runSyncLifecycle } from "./sync-lifecycle.test";
import { runQueueLifecycle } from "./queue-lifecycle.test";
import { runMemoryLifecycle } from "./memory-lifecycle.test";
import { runInferenceLifecycle } from "./inference-lifecycle.test";

// =============================================================================
// Lifecycle Test Mapping (add as lifecycle tests are created)
// =============================================================================

const LIFECYCLE_RUNNERS: Record<
  string,
  (verbose?: boolean) => Promise<{ passed: number; total: number; success: boolean }>
> = {
  kv: runKvLifecycle,
  paste: runPasteLifecycle,
  db: runDbLifecycle,
  sync: runSyncLifecycle,
  queue: runQueueLifecycle,
  memory: runMemoryLifecycle,
  inference: runInferenceLifecycle,
};

// =============================================================================
// Expected Assets (must match TOKEN_CONTRACTS in src/middleware/x402.ts)
// =============================================================================

/**
 * Expected asset strings for each token type per network.
 * STX is always "STX", SIP-010 tokens use "address.contract-name" format.
 */
const EXPECTED_ASSETS: Record<"mainnet" | "testnet", Record<TokenType, string>> = {
  mainnet: {
    STX: "STX",
    sBTC: "SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token",
    USDCx: "SP120SBRBQJ00MCWS7TM5R8WJNTTKD5K0HFRC2CNE.usdcx",
  },
  testnet: {
    STX: "STX",
    sBTC: "ST1F7QA2MDF17S807EPA36TSS8AMEFY4KA9TVGWXT.sbtc-token",
    USDCx: "ST1PQHQKV0RJXZFY1DGX8MNSNYVE3VGZJSRTPGZGM.usdcx",
  },
};

/**
 * Get expected asset string for a token type on current network
 */
function getExpectedAsset(tokenType: TokenType): string {
  const network = X402_NETWORK as "mainnet" | "testnet";
  return EXPECTED_ASSETS[network][tokenType];
}

// =============================================================================
// Error Types
// =============================================================================

type PaymentErrorCode =
  | "FACILITATOR_UNAVAILABLE"
  | "FACILITATOR_ERROR"
  | "PAYMENT_INVALID"
  | "INSUFFICIENT_FUNDS"
  | "PAYMENT_EXPIRED"
  | "AMOUNT_TOO_LOW"
  | "NETWORK_ERROR"
  | "UNKNOWN_ERROR";

interface PaymentErrorResponse {
  error: string;
  code: PaymentErrorCode;
  retryAfter?: number;
  tokenType: TokenType;
  resource: string;
  details?: {
    settleError?: string;
    settleReason?: string;
    settleStatus?: string;
    exceptionMessage?: string;
  };
}

function isPaymentErrorResponse(obj: unknown): obj is PaymentErrorResponse {
  return (
    typeof obj === "object" &&
    obj !== null &&
    "error" in obj &&
    "code" in obj &&
    typeof (obj as PaymentErrorResponse).error === "string" &&
    typeof (obj as PaymentErrorResponse).code === "string"
  );
}

interface ParsedErrorResponse {
  message: string;
  details?: PaymentErrorResponse["details"];
  raw?: string;
}

function formatErrorResponse(
  status: number,
  body: string,
  retryAfter: string | null
): ParsedErrorResponse {
  try {
    const parsed = JSON.parse(body);
    if (isPaymentErrorResponse(parsed)) {
      let msg = `[${parsed.code}] ${parsed.error}`;
      if (parsed.retryAfter || retryAfter) {
        msg += ` (retry after ${parsed.retryAfter || retryAfter}s)`;
      }
      return { message: msg, details: parsed.details, raw: body };
    }
    if (parsed.error) {
      return { message: parsed.error.slice(0, 80), raw: body };
    }
  } catch {
    /* not JSON */
  }
  return { message: body.slice(0, 80), raw: body };
}

// =============================================================================
// Configuration
// =============================================================================

type TestMode = "quick" | "full";

interface RunConfig {
  mode: TestMode;
  tokens: TokenType[];
  category: string | null;
  filter: string | null;
  maxConsecutiveFailures: number;
  verbose: boolean;
  delayMs: number;
  maxRetries: number;
  // Randomization options
  sampleSize: number | null; // --sample=N: run N random stateless endpoints
  randomLifecycleCount: number | null; // --random-lifecycle=N: run N random lifecycle categories
  randomToken: boolean; // --random-token: pick one random token
}

function parseArgs(): RunConfig {
  const args = process.argv.slice(2);
  const config: RunConfig = {
    mode: "quick",
    tokens: ["STX"],
    category: null,
    filter: null,
    maxConsecutiveFailures: 5,
    verbose: process.env.VERBOSE === "1",
    delayMs: parseInt(process.env.TEST_DELAY_MS || String(DEFAULT_TEST_DELAY_MS), 10),
    maxRetries: parseInt(process.env.TEST_MAX_RETRIES || "3", 10),
    // Randomization defaults
    sampleSize: null,
    randomLifecycleCount: null,
    randomToken: false,
  };

  let tokenSpecified = false;

  for (const arg of args) {
    if (arg === "--mode=quick") {
      config.mode = "quick";
    } else if (arg === "--mode=full") {
      config.mode = "full";
    } else if (arg === "--all-tokens") {
      config.tokens = ["STX", "sBTC", "USDCx"];
      tokenSpecified = true;
    } else if (arg === "--random-token") {
      // Pick one random token - applied after parsing
      config.randomToken = true;
    } else if (arg.startsWith("--token=")) {
      const rawToken = arg.split("=")[1].toUpperCase();
      // Normalize token name (SBTC -> sBTC, USDCX -> USDCx)
      const normalizedToken =
        rawToken === "SBTC" ? "sBTC" : rawToken === "USDCX" ? "USDCx" : rawToken;
      // Validate after normalization
      const validTokens: TokenType[] = ["STX", "sBTC", "USDCx"];
      if (validTokens.includes(normalizedToken as TokenType)) {
        const token = normalizedToken as TokenType;
        if (!tokenSpecified) {
          config.tokens = [];
          tokenSpecified = true;
        }
        if (!config.tokens.includes(token)) {
          config.tokens.push(token);
        }
      }
    } else if (arg.startsWith("--sample=")) {
      config.sampleSize = parseInt(arg.split("=")[1], 10);
    } else if (arg.startsWith("--random-lifecycle=")) {
      config.randomLifecycleCount = parseInt(arg.split("=")[1], 10);
    } else if (arg.startsWith("--category=")) {
      config.category = arg.split("=")[1].toLowerCase();
    } else if (arg.startsWith("--filter=")) {
      config.filter = arg.split("=")[1].toLowerCase();
    } else if (arg.startsWith("--max-failures=")) {
      config.maxConsecutiveFailures = parseInt(arg.split("=")[1], 10);
    } else if (arg.startsWith("--delay=")) {
      config.delayMs = parseInt(arg.split("=")[1], 10);
    } else if (arg.startsWith("--retries=")) {
      config.maxRetries = parseInt(arg.split("=")[1], 10);
    } else if (arg === "--verbose" || arg === "-v") {
      config.verbose = true;
    }
  }

  // Apply random token selection if requested
  if (config.randomToken && !tokenSpecified) {
    config.tokens = [pickRandom(TEST_TOKENS)];
  }

  return config;
}

// =============================================================================
// X402 Payment Flow
// =============================================================================

async function testEndpointWithToken(
  config: TestConfig,
  tokenType: TokenType,
  x402Client: X402PaymentClient,
  verbose: boolean,
  maxRetries: number = 2
): Promise<{ passed: boolean; error?: string }> {
  const logger = createTestLogger(config.name, verbose);
  const endpoint = config.endpoint.includes("?")
    ? `${config.endpoint}&tokenType=${tokenType}`
    : `${config.endpoint}?tokenType=${tokenType}`;
  const fullUrl = `${X402_WORKER_URL}${endpoint}`;

  try {
    // For free endpoints, skip the payment flow
    if (config.skipPayment) {
      logger.debug("1. Direct request (free endpoint)...");

      const res = await fetch(fullUrl, {
        method: config.method,
        headers: {
          ...(config.body ? { "Content-Type": "application/json" } : {}),
          ...config.headers,
        },
        body: config.body ? JSON.stringify(config.body) : undefined,
      });

      const allowedStatuses = [200, ...(config.allowedStatuses || [])];
      if (!allowedStatuses.includes(res.status)) {
        const text = await res.text();
        return { passed: false, error: `(${res.status}) ${text.slice(0, 100)}` };
      }

      const contentType = res.headers.get("content-type") || "";
      if (contentType.includes("application/json")) {
        const data = await res.json();
        logger.debug("Response", data);
        if (config.validateResponse(data, tokenType)) {
          return { passed: true };
        }
        return { passed: false, error: "Response validation failed" };
      }
      return { passed: true };
    }

    // Step 1: Initial request (expect 402)
    logger.debug("1. Initial request...");

    const initialRes = await fetch(fullUrl, {
      method: config.method,
      headers: {
        ...(config.body ? { "Content-Type": "application/json" } : {}),
        ...config.headers,
      },
      body: config.body ? JSON.stringify(config.body) : undefined,
    });

    if (initialRes.status !== 402) {
      const text = await initialRes.text();
      return { passed: false, error: `Expected 402, got ${initialRes.status}: ${text.slice(0, 100)}` };
    }

    let paymentReq: PaymentRequiredV2 = await initialRes.json();

    // Validate v2 format
    if (paymentReq.x402Version !== 2) {
      return { passed: false, error: `Expected x402Version 2, got ${paymentReq.x402Version}` };
    }

    if (!paymentReq.accepts || paymentReq.accepts.length === 0) {
      return { passed: false, error: "No accepts array in payment requirements" };
    }

    // Step 2-3: Sign and submit payment with retry logic
    // For nonce conflicts, we need to re-fetch 402 and re-sign (can't reuse stale payment)
    let retryRes: Response | null = null;
    let lastError = "";

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      // Get the payment requirements from accepts array (inside loop to use fresh requirements after retry)
      const requirements = paymentReq.accepts[0];

      // Validate that the accepted asset matches the expected asset for this token type
      const expectedAsset = getExpectedAsset(tokenType);
      if (requirements.asset !== expectedAsset) {
        return {
          passed: false,
          error: `Payment requirements asset ${requirements.asset} does not match expected ${expectedAsset} for token type ${tokenType}`,
        };
      }

      // Sign payment (fresh on each attempt for nonce conflict recovery)
      if (attempt === 0) {
        logger.debug("2. Signing payment...");
      } else {
        logger.debug(`2. Re-signing payment (attempt ${attempt + 1}/${maxRetries + 1})...`);
      }

      // Derive network from requirements (2147483648 is testnet chain ID)
      const derivedNetwork: "mainnet" | "testnet" =
        requirements.network.includes("2147483648") ? "testnet" : "mainnet";

      // Build v1-compatible request for the client's signPayment method
      const v1CompatibleRequest = {
        maxAmountRequired: requirements.amount,
        resource: paymentReq.resource.url,
        payTo: requirements.payTo,
        network: derivedNetwork,
        nonce: crypto.randomUUID(),
        expiresAt: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
        tokenType: tokenType,
      };

      const signResult = await x402Client.signPayment(v1CompatibleRequest);

      // Build v2 payment payload
      const paymentPayload: PaymentPayloadV2 = {
        x402Version: 2,
        resource: paymentReq.resource,
        accepted: requirements,
        payload: {
          transaction: signResult.signedTransaction,
        },
      };

      // Encode to base64 for header
      const paymentSignature = encodePaymentPayload(paymentPayload);

      // Submit with payment-signature header (v2)
      if (attempt === 0) {
        logger.debug("3. Submitting with payment...");
      } else {
        logger.debug(`3. Retry attempt ${attempt}/${maxRetries}...`);
      }

      retryRes = await fetch(fullUrl, {
        method: config.method,
        headers: {
          ...(config.body ? { "Content-Type": "application/json" } : {}),
          ...config.headers,
          [X402_HEADERS.PAYMENT_SIGNATURE]: paymentSignature,
          "X-PAYMENT-TOKEN-TYPE": tokenType,
        },
        body: config.body ? JSON.stringify(config.body) : undefined,
      });

      const allowedStatuses = [200, ...(config.allowedStatuses || [])];
      if (allowedStatuses.includes(retryRes.status)) {
        break;
      }

      const errText = await retryRes.text();
      const retryAfterHeader = retryRes.headers.get("Retry-After");

      let errorCode: string | undefined;
      let errorMessage: string | undefined;
      let bodyRetryAfter: number | undefined;
      let errorDetails: Record<string, unknown> | undefined;
      let validationError: string | undefined;
      try {
        const parsed = JSON.parse(errText);
        errorCode = parsed.code;
        errorMessage = parsed.error || parsed.details?.exceptionMessage || parsed.details?.settleError;
        bodyRetryAfter = parsed.retryAfter;
        errorDetails = parsed.details;
        validationError = parsed.details?.validationError;
      } catch {
        /* not JSON */
      }

      const fullErrorText = `${errorCode || ""} ${errorMessage || ""} ${validationError || ""} ${errText}`;

      // Check for nonce conflict - needs re-sign with fresh nonce
      if (isNonceConflict(fullErrorText) && attempt < maxRetries) {
        logger.debug(`Nonce conflict detected, waiting ${NONCE_CONFLICT_DELAY_MS}ms for mempool to clear...`);
        await sleep(NONCE_CONFLICT_DELAY_MS);

        // Re-fetch 402 to get fresh payment requirements (v2)
        logger.debug("Re-fetching payment requirements...");
        const freshRes = await fetch(fullUrl, {
          method: config.method,
          headers: {
            ...(config.body ? { "Content-Type": "application/json" } : {}),
            ...config.headers,
          },
          body: config.body ? JSON.stringify(config.body) : undefined,
        });

        if (freshRes.status === 402) {
          const freshPaymentReq = await freshRes.json();
          // Validate re-fetched payment requirements (must be v2 with accepts array)
          if (
            !freshPaymentReq ||
            freshPaymentReq.x402Version !== 2 ||
            !Array.isArray(freshPaymentReq.accepts) ||
            freshPaymentReq.accepts.length === 0
          ) {
            logger.debug("Invalid payment requirements in re-fetched 402 response");
            return { passed: false, error: "Invalid payment requirements in re-fetched 402 response" };
          }
          paymentReq = freshPaymentReq as PaymentRequiredV2;
          logger.debug("Got fresh payment requirements");
        }
        continue;
      }

      // Check for other retryable errors (mutually exclusive with nonce conflict)
      if (!isNonceConflict(fullErrorText) && isRetryableError(retryRes.status, errorCode, errorMessage || errText) && attempt < maxRetries) {
        const retryAfterSecs = retryAfterHeader ? parseInt(retryAfterHeader, 10) : bodyRetryAfter || 0;
        const delayMs = calculateBackoff(attempt, retryAfterSecs);

        const errorSummary = errorMessage || errorCode || errText.slice(0, 100);
        const errorType = retryRes.status === 429 ? "Rate limited" : `Retryable error`;
        logger.debug(`${errorType} (${retryRes.status}): ${errorSummary}`);
        if (errorDetails) {
          logger.debug(`Details: ${JSON.stringify(errorDetails)}`);
        }
        logger.debug(`Waiting ${delayMs}ms before retry...`);
        await sleep(delayMs);
        continue;
      }

      const parsedError = formatErrorResponse(retryRes.status, errText, retryAfterHeader);
      lastError = `(${retryRes.status}) ${parsedError.message}`;

      if (parsedError.details) {
        logger.debug("Error details:", parsedError.details);
      }
      break;
    }

    const allowedStatuses = [200, ...(config.allowedStatuses || [])];
    if (!retryRes || !allowedStatuses.includes(retryRes.status)) {
      return { passed: false, error: lastError || "Request failed" };
    }

    // Step 4: Validate response
    const contentType = retryRes.headers.get("content-type") || "";
    const expectedContentType = config.expectedContentType || "application/json";

    if (!contentType.includes("application/json")) {
      if (contentType.includes(expectedContentType.split("/")[0])) {
        return { passed: true };
      }
      return {
        passed: false,
        error: `Wrong content-type: expected ${expectedContentType}, got ${contentType}`,
      };
    }

    const data = await retryRes.json();
    logger.debug("Response", data);

    if (config.validateResponse(data, tokenType)) {
      return { passed: true };
    }

    return { passed: false, error: "Response validation failed" };
  } catch (error) {
    return { passed: false, error: String(error) };
  }
}

// =============================================================================
// Test Runner
// =============================================================================

interface RunStats {
  total: number;
  passed: number;
  failed: number;
  skipped: number;
  byToken: Record<TokenType, { passed: number; failed: number }>;
  failedTests: Array<{ name: string; token: TokenType; error: string }>;
  lifecycleResults: Array<{ category: string; passed: number; total: number; success: boolean }>;
}

async function runStatelessTests(
  endpoints: TestConfig[],
  runConfig: RunConfig,
  x402Client: X402PaymentClient,
  stats: RunStats
): Promise<void> {
  let consecutiveFailures = 0;

  for (let i = 0; i < endpoints.length; i++) {
    const endpoint = endpoints[i];

    if (consecutiveFailures >= runConfig.maxConsecutiveFailures) {
      console.log(
        `\n${COLORS.red}${COLORS.bright}BAIL OUT: ${consecutiveFailures} consecutive failures${COLORS.reset}`
      );
      stats.skipped = (endpoints.length - i) * runConfig.tokens.length;
      break;
    }

    const progress = `[${i + 1}/${endpoints.length}]`;
    console.log(`${COLORS.bright}${progress}${COLORS.reset} ${COLORS.cyan}${endpoint.name}${COLORS.reset}`);

    let allPassed = true;
    const tokenResults: string[] = [];

    for (const token of runConfig.tokens) {
      stats.total++;

      const result = await testEndpointWithToken(
        endpoint,
        token,
        x402Client,
        runConfig.verbose,
        runConfig.maxRetries
      );

      if (result.passed) {
        stats.passed++;
        stats.byToken[token].passed++;
        tokenResults.push(`${COLORS.green}${token}:pass${COLORS.reset}`);
      } else {
        stats.failed++;
        stats.byToken[token].failed++;
        allPassed = false;
        tokenResults.push(`${COLORS.red}${token}:fail${COLORS.reset}`);
        stats.failedTests.push({
          name: endpoint.name,
          token,
          error: result.error || "Unknown error",
        });
      }
    }

    console.log(`    ${tokenResults.join("  ")}`);

    if (runConfig.delayMs > 0 && i < endpoints.length - 1) {
      await sleep(runConfig.delayMs);
    }

    if (allPassed) {
      consecutiveFailures = 0;
    } else {
      consecutiveFailures++;
    }

    // Small delay between test iterations for stability
    await sleep(POST_LIFECYCLE_DELAY_MS);
  }
}

async function runLifecycleTests(
  categories: string[],
  verbose: boolean,
  stats: RunStats
): Promise<void> {
  for (const category of categories) {
    const runner = LIFECYCLE_RUNNERS[category];
    if (!runner) {
      console.log(`${COLORS.yellow}  No lifecycle test for ${category} (not implemented yet)${COLORS.reset}`);
      continue;
    }

    try {
      const result = await runner(verbose);
      stats.lifecycleResults.push({
        category,
        passed: result.passed,
        total: result.total,
        success: result.success,
      });
      stats.total += result.total;
      stats.passed += result.passed;
      stats.failed += result.total - result.passed;
    } catch (error) {
      console.log(`${COLORS.red}  Lifecycle test ${category} crashed: ${error}${COLORS.reset}`);
      stats.lifecycleResults.push({ category, passed: 0, total: 1, success: false });
      stats.failed++;
      stats.total++;
    }
  }
}

async function runTests(runConfig: RunConfig): Promise<RunStats> {
  if (!X402_CLIENT_PK) {
    throw new Error("Set X402_CLIENT_PK env var with mnemonic");
  }

  if (X402_NETWORK !== "mainnet" && X402_NETWORK !== "testnet") {
    throw new Error(`Invalid X402_NETWORK: "${X402_NETWORK}". Must be "mainnet" or "testnet".`);
  }
  const network: NetworkType = X402_NETWORK;

  const { address, key } = await deriveChildAccount(network, X402_CLIENT_PK, 0);

  const x402Client = new X402PaymentClient({
    network,
    privateKey: key,
  });

  // Initialize stats
  const stats: RunStats = {
    total: 0,
    passed: 0,
    failed: 0,
    skipped: 0,
    byToken: {} as Record<TokenType, { passed: number; failed: number }>,
    failedTests: [],
    lifecycleResults: [],
  };

  for (const token of runConfig.tokens) {
    stats.byToken[token] = { passed: 0, failed: 0 };
  }

  // Determine what to run
  let endpointsToTest: TestConfig[] = [];
  let lifecycleCategories: string[] = [];

  if (runConfig.category) {
    // Specific category requested
    if (isStatefulCategory(runConfig.category)) {
      // Run lifecycle test for this stateful category
      lifecycleCategories = [runConfig.category];
    } else {
      // Run individual tests for this stateless category
      endpointsToTest = ENDPOINT_CATEGORIES[runConfig.category] || [];
    }
  } else if (runConfig.mode === "quick") {
    // Quick mode: stateless endpoints only
    endpointsToTest = [...STATELESS_ENDPOINTS];
  } else {
    // Full mode: stateless + all lifecycle tests
    endpointsToTest = [...STATELESS_ENDPOINTS];
    lifecycleCategories = [...STATEFUL_CATEGORIES];
  }

  // Apply filter if specified
  if (runConfig.filter && endpointsToTest.length > 0) {
    endpointsToTest = endpointsToTest.filter((e) =>
      e.name.toLowerCase().includes(runConfig.filter!)
    );
  }

  // Apply random sampling if specified
  if (runConfig.sampleSize !== null && endpointsToTest.length > 0) {
    endpointsToTest = sampleArray(endpointsToTest, runConfig.sampleSize);
  }

  // Apply random lifecycle sampling if specified
  if (runConfig.randomLifecycleCount !== null && lifecycleCategories.length > 0) {
    lifecycleCategories = sampleArray(lifecycleCategories, runConfig.randomLifecycleCount);
  }

  // Print header
  console.log(`\n${COLORS.bright}${"=".repeat(70)}${COLORS.reset}`);
  console.log(`${COLORS.bright}  X402 API ENDPOINT TEST RUNNER${COLORS.reset}`);
  console.log(`${COLORS.bright}${"=".repeat(70)}${COLORS.reset}`);
  console.log(`  Wallet:     ${address}`);
  console.log(`  Network:    ${network}`);
  console.log(`  Server:     ${X402_WORKER_URL}`);
  console.log(`  Mode:       ${runConfig.mode}`);
  if (runConfig.category) {
    console.log(`  Category:   ${runConfig.category}`);
  }
  console.log(`  Tokens:     ${runConfig.tokens.join(", ")}${runConfig.randomToken ? " (random)" : ""}`);
  if (endpointsToTest.length > 0) {
    const sampleNote = runConfig.sampleSize !== null ? ` (sampled from ${STATELESS_ENDPOINTS.length})` : "";
    console.log(`  Endpoints:  ${endpointsToTest.length} stateless${sampleNote}`);
    if (runConfig.sampleSize !== null) {
      console.log(`              [${endpointsToTest.map((e) => e.name).join(", ")}]`);
    }
  }
  if (lifecycleCategories.length > 0) {
    const lifecycleNote = runConfig.randomLifecycleCount !== null ? ` (sampled from ${STATEFUL_CATEGORIES.length})` : "";
    console.log(`  Lifecycle:  ${lifecycleCategories.join(", ")}${lifecycleNote}`);
  }
  console.log(`  Delay:      ${runConfig.delayMs}ms between tests`);
  console.log(`  Retries:    ${runConfig.maxRetries} for rate-limited requests`);
  console.log(`${COLORS.bright}${"=".repeat(70)}${COLORS.reset}\n`);

  // Run stateless tests
  if (endpointsToTest.length > 0) {
    console.log(
      `${COLORS.bright}Running ${endpointsToTest.length} stateless endpoint tests...${COLORS.reset}\n`
    );
    await runStatelessTests(endpointsToTest, runConfig, x402Client, stats);
  }

  // Run lifecycle tests
  if (lifecycleCategories.length > 0) {
    console.log(`\n${COLORS.bright}Running ${lifecycleCategories.length} lifecycle test(s)...${COLORS.reset}`);
    await runLifecycleTests(lifecycleCategories, runConfig.verbose, stats);
  }

  return stats;
}

// =============================================================================
// Main
// =============================================================================

async function main() {
  const config = parseArgs();

  console.clear();

  try {
    const stats = await runTests(config);

    // Print summary
    console.log(`\n${COLORS.bright}${"=".repeat(70)}${COLORS.reset}`);
    console.log(`${COLORS.bright}  SUMMARY${COLORS.reset}`);
    console.log(`${COLORS.bright}${"=".repeat(70)}${COLORS.reset}`);

    const passRate = stats.total > 0 ? ((stats.passed / stats.total) * 100).toFixed(1) : "0.0";
    const color =
      stats.failed === 0 ? COLORS.green : stats.passed > stats.failed ? COLORS.yellow : COLORS.red;

    console.log(
      `  ${color}${COLORS.bright}${stats.passed}/${stats.total} passed (${passRate}%)${COLORS.reset}`
    );

    if (stats.skipped > 0) {
      console.log(`  ${COLORS.yellow}${stats.skipped} skipped (bail-out)${COLORS.reset}`);
    }

    // Per-token breakdown (only if we ran stateless tests)
    if (Object.values(stats.byToken).some((t) => t.passed + t.failed > 0)) {
      console.log(`\n  By Token:`);
      for (const [token, tokenStats] of Object.entries(stats.byToken)) {
        const tokenTotal = tokenStats.passed + tokenStats.failed;
        if (tokenTotal > 0) {
          const tokenRate = ((tokenStats.passed / tokenTotal) * 100).toFixed(0);
          const tokenColor = tokenStats.failed === 0 ? COLORS.green : COLORS.yellow;
          console.log(
            `    ${tokenColor}${token}: ${tokenStats.passed}/${tokenTotal} (${tokenRate}%)${COLORS.reset}`
          );
        }
      }
    }

    // Lifecycle test results
    if (stats.lifecycleResults.length > 0) {
      console.log(`\n  Lifecycle Tests:`);
      for (const lr of stats.lifecycleResults) {
        const icon = lr.success
          ? `${COLORS.green}pass${COLORS.reset}`
          : `${COLORS.red}fail${COLORS.reset}`;
        console.log(`    ${icon} ${lr.category}: ${lr.passed}/${lr.total}`);
      }
    }

    // Failed tests detail
    if (stats.failedTests.length > 0) {
      console.log(`\n  ${COLORS.red}Failed Tests:${COLORS.reset}`);
      for (const fail of stats.failedTests) {
        console.log(`    ${COLORS.red}X${COLORS.reset} ${fail.name} [${fail.token}]`);
        console.log(`      ${COLORS.gray}${fail.error}${COLORS.reset}`);
      }
    }

    console.log(`\n${COLORS.bright}${"=".repeat(70)}${COLORS.reset}\n`);

    // Print endpoint counts
    console.log(`  Endpoint Counts: ${JSON.stringify(ENDPOINT_COUNTS)}\n`);

    process.exit(stats.failed > 0 ? 1 : 0);
  } catch (error) {
    console.error(`\n${COLORS.red}${COLORS.bright}FATAL ERROR:${COLORS.reset}`, error);
    process.exit(1);
  }
}

main();
