#!/usr/bin/env bun
/**
 * Queue Storage Lifecycle Test
 *
 * Tests the complete lifecycle of queue operations:
 * 1. Push (add items to queue)
 * 2. Status (check queue has items)
 * 3. Peek (view items without removing)
 * 4. Pop (remove and get items)
 * 5. Clear (remove remaining items)
 * 6. Status (verify queue is empty)
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
  generateTestId,
  DEFAULT_MAX_RETRIES,
  isRetryableError,
  calculateBackoff,
  sleep,
  isTerminalStatus,
  parseErrorResponse,
  parseResponseData,
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

/** JSON-serializable body type */
type JsonBody =
  | Record<string, unknown>
  | unknown[]
  | string
  | number
  | boolean
  | null;

async function makeX402Request(
  x402Client: X402PaymentClient,
  endpoint: string,
  method: "GET" | "POST" | "DELETE",
  body: JsonBody | undefined,
  tokenType: TokenType,
  logger: ReturnType<typeof createTestLogger>,
  maxRetries: number = DEFAULT_MAX_RETRIES
): Promise<{ status: number; data: unknown }> {
  const url = `${X402_WORKER_URL}${endpoint}${endpoint.includes("?") ? "&" : "?"}tokenType=${tokenType}`;

  // Track last error for retry exhaustion reporting
  let lastErrorStatus = 0;
  let lastErrorData: unknown = "Failed to get payment requirement";

  // Retry loop for initial request (get 402 payment requirement)
  let initialRes: Response | null = null;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      initialRes = await fetch(url, {
        method,
        headers: { "Content-Type": "application/json" },
        body: body ? JSON.stringify(body) : undefined,
      });

      // 402 is expected - break to continue payment flow
      if (initialRes.status === 402) break;

      // Terminal status codes (200, 404) - return immediately
      if (isTerminalStatus(initialRes.status)) {
        const text = await initialRes.text();
        return { status: initialRes.status, data: parseResponseData(text) };
      }

      // Parse error and check if retryable
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

      // Non-retryable error - return last captured error
      return { status: lastErrorStatus, data: lastErrorData };
    } catch (fetchError) {
      lastErrorStatus = 0;
      lastErrorData = { error: String(fetchError), code: "NETWORK_ERROR" };

      if (attempt < maxRetries) {
        const delayMs = calculateBackoff(attempt);
        logger.debug(`Fetch error, retry ${attempt + 1}/${maxRetries} in ${delayMs}ms: ${fetchError}`);
        await sleep(delayMs);
        continue;
      }
      return { status: lastErrorStatus, data: lastErrorData };
    }
  }

  // Check if we got a 402 payment requirement
  if (!initialRes || initialRes.status !== 402) {
    return { status: lastErrorStatus, data: lastErrorData };
  }

  const paymentReq: X402PaymentRequired = await initialRes.json();
  logger.debug("402 Payment req", paymentReq);

  const signResult = await x402Client.signPayment(paymentReq);
  logger.debug("Signed payment", signResult);

  // Reset error tracking for paid request phase
  lastErrorStatus = 0;
  lastErrorData = "Exhausted retries on paid request";

  // Retry loop for paid request
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const retryRes = await fetch(url, {
        method,
        headers: {
          "Content-Type": "application/json",
          "X-PAYMENT": signResult.signedTransaction,
          "X-PAYMENT-TOKEN-TYPE": tokenType,
        },
        body: body ? JSON.stringify(body) : undefined,
      });

      // Terminal status codes (200, 404) - return immediately
      if (isTerminalStatus(retryRes.status)) {
        const text = await retryRes.text();
        return { status: retryRes.status, data: parseResponseData(text) };
      }

      // Parse error and check if retryable
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

      // Non-retryable error - return last captured error
      return { status: lastErrorStatus, data: lastErrorData };
    } catch (fetchError) {
      lastErrorStatus = 0;
      lastErrorData = { error: String(fetchError), code: "NETWORK_ERROR" };

      if (attempt < maxRetries) {
        const delayMs = calculateBackoff(attempt);
        logger.debug(`Fetch error on paid request, retry ${attempt + 1}/${maxRetries} in ${delayMs}ms: ${fetchError}`);
        await sleep(delayMs);
        continue;
      }
      return { status: lastErrorStatus, data: lastErrorData };
    }
  }

  // Exhausted retries - return last captured error
  return { status: lastErrorStatus, data: lastErrorData };
}

export interface LifecycleTestResult {
  passed: number;
  total: number;
  success: boolean;
}

export async function runQueueLifecycle(verbose = false): Promise<LifecycleTestResult> {
  if (!X402_CLIENT_PK) {
    throw new Error("Set X402_CLIENT_PK env var with mnemonic");
  }

  const { address, key } = await deriveChildAccount(X402_NETWORK, X402_CLIENT_PK, 0);
  const logger = createTestLogger("queue-lifecycle", verbose);
  logger.info(`Test wallet address: ${address}`);

  const x402Client = new X402PaymentClient({
    network: X402_NETWORK,
    privateKey: key,
  });

  // Test with STX only to save on payments
  const tokenType: TokenType = "STX";
  const queueName = generateTestId("queue");
  const testItems = [
    { task: "task1", data: "first item" },
    { task: "task2", data: "second item" },
    { task: "task3", data: "third item" },
  ];

  let successCount = 0;
  const totalTests = 6;

  // Test 1: Push items to queue
  logger.info("1. Testing /storage/queue/push (POST)...");
  const pushResult = await makeX402Request(
    x402Client,
    "/storage/queue/push",
    "POST",
    { name: queueName, items: testItems, priority: 0 },
    tokenType,
    logger
  );

  const pushData = pushResult.data as { ok?: boolean; pushed?: number };
  if (pushResult.status === 200 && pushData.ok && pushData.pushed === testItems.length) {
    logger.success(`Pushed ${pushData.pushed} items to queue "${queueName}"`);
    successCount++;
  } else {
    logger.error(`Push failed: ${JSON.stringify(pushResult.data)}`);
    logger.info("Bailing out: initial push failed, skipping remaining tests");
    logger.summary(0, totalTests);
    return { passed: 0, total: totalTests, success: false };
  }

  await new Promise((resolve) => setTimeout(resolve, STEP_DELAY_MS));

  // Test 2: Check queue status
  logger.info("2. Testing /storage/queue/status (GET)...");
  const statusResult = await makeX402Request(
    x402Client,
    `/storage/queue/status?name=${queueName}`,
    "GET",
    null,
    tokenType,
    logger
  );

  const statusData = statusResult.data as { ok?: boolean; name?: string; pending?: number };
  if (statusResult.status === 200 && statusData.ok && statusData.pending === testItems.length) {
    logger.success(`Queue "${queueName}" has ${statusData.pending} pending items`);
    successCount++;
  } else {
    logger.error(`Status check failed: ${JSON.stringify(statusResult.data)}`);
  }

  await new Promise((resolve) => setTimeout(resolve, STEP_DELAY_MS));

  // Test 3: Peek at items
  logger.info("3. Testing /storage/queue/peek (GET)...");
  const peekResult = await makeX402Request(
    x402Client,
    `/storage/queue/peek?name=${queueName}&count=2`,
    "GET",
    null,
    tokenType,
    logger
  );

  const peekData = peekResult.data as { ok?: boolean; items?: unknown[]; count?: number };
  if (peekResult.status === 200 && peekData.ok && Array.isArray(peekData.items) && peekData.items.length === 2) {
    logger.success(`Peeked at ${peekData.items.length} items (queue unchanged)`);
    successCount++;
  } else {
    logger.error(`Peek failed: ${JSON.stringify(peekResult.data)}`);
  }

  await new Promise((resolve) => setTimeout(resolve, STEP_DELAY_MS));

  // Test 4: Pop one item
  logger.info("4. Testing /storage/queue/pop (POST)...");
  const popResult = await makeX402Request(
    x402Client,
    "/storage/queue/pop",
    "POST",
    { name: queueName, count: 1 },
    tokenType,
    logger
  );

  const popData = popResult.data as { ok?: boolean; items?: unknown[]; count?: number };
  if (popResult.status === 200 && popData.ok && Array.isArray(popData.items) && popData.items.length === 1) {
    logger.success(`Popped ${popData.items.length} item from queue`);
    successCount++;
  } else {
    logger.error(`Pop failed: ${JSON.stringify(popResult.data)}`);
  }

  await new Promise((resolve) => setTimeout(resolve, STEP_DELAY_MS));

  // Test 5: Clear remaining items
  logger.info("5. Testing /storage/queue/clear (POST)...");
  const clearResult = await makeX402Request(
    x402Client,
    "/storage/queue/clear",
    "POST",
    { name: queueName },
    tokenType,
    logger
  );

  const clearData = clearResult.data as { ok?: boolean; cleared?: number };
  if (clearResult.status === 200 && clearData.ok) {
    logger.success(`Cleared queue "${queueName}" (${clearData.cleared || 0} items removed)`);
    successCount++;
  } else {
    logger.error(`Clear failed: ${JSON.stringify(clearResult.data)}`);
  }

  await new Promise((resolve) => setTimeout(resolve, STEP_DELAY_MS));

  // Test 6: Verify queue is empty
  logger.info("6. Verifying queue is empty...");
  const verifyResult = await makeX402Request(
    x402Client,
    `/storage/queue/status?name=${queueName}`,
    "GET",
    null,
    tokenType,
    logger
  );

  const verifyData = verifyResult.data as { ok?: boolean; pending?: number };
  if (verifyResult.status === 200 && verifyData.ok && verifyData.pending === 0) {
    logger.success(`Queue "${queueName}" is empty`);
    successCount++;
  } else {
    logger.error(`Queue not empty after clear: ${JSON.stringify(verifyResult.data)}`);
  }

  logger.summary(successCount, totalTests);
  return { passed: successCount, total: totalTests, success: successCount === totalTests };
}

// Run if executed directly
if (import.meta.main) {
  const verbose = process.argv.includes("-v") || process.argv.includes("--verbose");
  runQueueLifecycle(verbose)
    .then((result) => process.exit(result.success ? 0 : 1))
    .catch((err) => {
      console.error("Test failed:", err);
      process.exit(1);
    });
}
