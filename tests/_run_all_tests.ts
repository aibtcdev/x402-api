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
 * Environment:
 *   X402_CLIENT_PK      - Mnemonic for payments (required)
 *   X402_NETWORK        - Network (default: testnet)
 *   X402_WORKER_URL     - Worker URL (default: http://localhost:8787)
 *   VERBOSE=1           - Enable verbose logging
 *   TEST_DELAY_MS=500   - Delay between tests in ms (default: 500)
 *   TEST_MAX_RETRIES=2  - Max retries for rate-limited requests (default: 2)
 */

import type { TokenType, NetworkType } from "x402-stacks";
import { X402PaymentClient } from "x402-stacks";
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
  createTestLogger,
  DEFAULT_TEST_DELAY_MS,
  POST_LIFECYCLE_DELAY_MS,
  isRetryableError,
  calculateBackoff,
  sleep,
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

  return config;
}

// =============================================================================
// X402 Payment Flow
// =============================================================================

interface X402PaymentRequired {
  maxAmountRequired: string;
  resource: string;
  payTo: string;
  network: "mainnet" | "testnet";
  nonce: string;
  expiresAt: string;
  tokenType: TokenType;
}

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

    const paymentReq: X402PaymentRequired = await initialRes.json();

    if (paymentReq.tokenType !== tokenType) {
      return { passed: false, error: `Token mismatch: expected ${tokenType}, got ${paymentReq.tokenType}` };
    }

    // Step 2: Sign payment
    logger.debug("2. Signing payment...");
    const signResult = await x402Client.signPayment(paymentReq);

    // Step 3: Retry with X-PAYMENT header
    let retryRes: Response | null = null;
    let lastError = "";

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      if (attempt > 0) {
        logger.debug(`3. Retry attempt ${attempt}/${maxRetries}...`);
      } else {
        logger.debug("3. Retry with payment...");
      }

      retryRes = await fetch(fullUrl, {
        method: config.method,
        headers: {
          ...(config.body ? { "Content-Type": "application/json" } : {}),
          ...config.headers,
          "X-PAYMENT": signResult.signedTransaction,
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
      try {
        const parsed = JSON.parse(errText);
        errorCode = parsed.code;
        errorMessage = parsed.error || parsed.details?.exceptionMessage || parsed.details?.settleError;
        bodyRetryAfter = parsed.retryAfter;
        errorDetails = parsed.details;
      } catch {
        /* not JSON */
      }

      if (isRetryableError(retryRes.status, errorCode, errorMessage || errText) && attempt < maxRetries) {
        const retryAfterSecs = retryAfterHeader ? parseInt(retryAfterHeader, 10) : bodyRetryAfter || 0;
        const delayMs = calculateBackoff(attempt, retryAfterSecs);

        const errorSummary = errorMessage || errorCode || errText.slice(0, 100);
        const errorType = retryRes.status === 429 ? "Rate limited" : `Server error`;
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
  console.log(`  Tokens:     ${runConfig.tokens.join(", ")}`);
  if (endpointsToTest.length > 0) {
    console.log(`  Endpoints:  ${endpointsToTest.length} stateless`);
  }
  if (lifecycleCategories.length > 0) {
    console.log(`  Lifecycle:  ${lifecycleCategories.join(", ")}`);
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
