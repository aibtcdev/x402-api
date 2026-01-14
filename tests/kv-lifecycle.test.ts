#!/usr/bin/env bun
/**
 * KV Storage Lifecycle Test
 *
 * Tests the complete lifecycle of KV storage operations:
 * 1. Set a value
 * 2. Get the value back
 * 3. List keys
 * 4. Delete the key
 * 5. Verify deletion
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
  const url = `${X402_WORKER_URL}${endpoint}?tokenType=${tokenType}`;

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
      // 404 is expected in some lifecycle steps (e.g., verifying key deletion)
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
      // 404 is expected in some lifecycle steps (e.g., verifying key deletion)
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

export async function runKvLifecycle(verbose = false): Promise<LifecycleTestResult> {
  if (!X402_CLIENT_PK) {
    throw new Error("Set X402_CLIENT_PK env var with mnemonic");
  }

  const { address, key } = await deriveChildAccount(X402_NETWORK, X402_CLIENT_PK, 0);
  const logger = createTestLogger("kv-lifecycle", verbose);
  logger.info(`Test wallet address: ${address}`);

  const x402Client = new X402PaymentClient({
    network: X402_NETWORK,
    privateKey: key,
  });

  // Test with STX only to save on payments
  const tokenType: TokenType = "STX";
  const testKey = generateTestId("kv-key");
  const testValue = JSON.stringify({ message: "Hello from KV test", timestamp: Date.now() });

  let successCount = 0;
  const totalTests = 5;

  // Test 1: Set a value
  logger.info("1. Testing /storage/kv (POST - set)...");
  const setResult = await makeX402Request(
    x402Client,
    "/storage/kv",
    "POST",
    { key: testKey, value: testValue },
    tokenType,
    logger
  );

  const setData = setResult.data as { ok?: boolean; key?: string; created?: boolean };
  if (setResult.status === 200 && setData.ok && setData.key === testKey) {
    logger.success(`Set key "${testKey}"`);
    successCount++;
  } else {
    logger.error(`Set failed: ${JSON.stringify(setResult.data)}`);
    // Bail out early - no state to test if initial set fails
    logger.info("Bailing out: initial set failed, skipping remaining tests");
    logger.summary(0, totalTests);
    return { passed: 0, total: totalTests, success: false };
  }

  await new Promise((resolve) => setTimeout(resolve, STEP_DELAY_MS));

  // Test 2: Get the value back
  logger.info("2. Testing /storage/kv/:key (GET)...");
  const getResult = await makeX402Request(
    x402Client,
    `/storage/kv/${testKey}`,
    "GET",
    null,
    tokenType,
    logger
  );

  const getData = getResult.data as { ok?: boolean; value?: string };
  if (getResult.status === 200 && getData.ok && getData.value === testValue) {
    logger.success(`Got value back correctly`);
    successCount++;
  } else {
    logger.error(`Get failed: ${JSON.stringify(getResult.data)}`);
  }

  await new Promise((resolve) => setTimeout(resolve, STEP_DELAY_MS));

  // Test 3: List keys
  logger.info("3. Testing /storage/kv (GET - list)...");
  const listResult = await makeX402Request(
    x402Client,
    "/storage/kv",
    "GET",
    null,
    tokenType,
    logger
  );

  const listData = listResult.data as { ok?: boolean; keys?: Array<{ key: string }> };
  if (listResult.status === 200 && listData.ok && Array.isArray(listData.keys)) {
    const foundKey = listData.keys.find((k) => k.key === testKey);
    if (foundKey) {
      logger.success(`Listed ${listData.keys.length} keys, found test key`);
      successCount++;
    } else {
      logger.error(`List returned keys but test key not found`);
    }
  } else {
    logger.error(`List failed: ${JSON.stringify(listResult.data)}`);
  }

  await new Promise((resolve) => setTimeout(resolve, STEP_DELAY_MS));

  // Test 4: Delete the key
  logger.info("4. Testing /storage/kv/:key (DELETE)...");
  const deleteResult = await makeX402Request(
    x402Client,
    `/storage/kv/${testKey}`,
    "DELETE",
    null,
    tokenType,
    logger
  );

  const deleteData = deleteResult.data as { ok?: boolean; deleted?: boolean };
  if (deleteResult.status === 200 && deleteData.ok) {
    logger.success(`Deleted key "${testKey}"`);
    successCount++;
  } else {
    logger.error(`Delete failed: ${JSON.stringify(deleteResult.data)}`);
  }

  await new Promise((resolve) => setTimeout(resolve, STEP_DELAY_MS));

  // Test 5: Verify deletion
  logger.info("5. Verifying deletion...");
  const verifyResult = await makeX402Request(
    x402Client,
    `/storage/kv/${testKey}`,
    "GET",
    null,
    tokenType,
    logger
  );

  if (verifyResult.status === 404) {
    logger.success(`Verified key is deleted (404)`);
    successCount++;
  } else {
    logger.error(`Key still exists after delete: ${JSON.stringify(verifyResult.data)}`);
  }

  logger.summary(successCount, totalTests);
  return { passed: successCount, total: totalTests, success: successCount === totalTests };
}

// Run if executed directly
if (import.meta.main) {
  const verbose = process.argv.includes("-v") || process.argv.includes("--verbose");
  runKvLifecycle(verbose)
    .then((result) => process.exit(result.success ? 0 : 1))
    .catch((err) => {
      console.error("Test failed:", err);
      process.exit(1);
    });
}
