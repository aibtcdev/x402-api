#!/usr/bin/env bun
/**
 * Sync (Distributed Lock) Lifecycle Test
 *
 * Tests the complete lifecycle of distributed lock operations:
 * 1. Lock (acquire a lock)
 * 2. Status (verify lock is held)
 * 3. List (verify lock appears in list)
 * 4. Extend (extend lock TTL)
 * 5. Unlock (release the lock)
 * 6. Verify unlock via status
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

export async function runSyncLifecycle(verbose = false): Promise<LifecycleTestResult> {
  if (!X402_CLIENT_PK) {
    throw new Error("Set X402_CLIENT_PK env var with mnemonic");
  }

  const { address, key } = await deriveChildAccount(X402_NETWORK, X402_CLIENT_PK, 0);
  const logger = createTestLogger("sync-lifecycle", verbose);
  logger.info(`Test wallet address: ${address}`);

  const x402Client = new X402PaymentClient({
    network: X402_NETWORK,
    privateKey: key,
  });

  // Test with STX only to save on payments
  const tokenType: TokenType = "STX";
  const lockName = generateTestId("lock");

  let successCount = 0;
  const totalTests = 6;
  let lockToken: string | null = null;

  // Test 1: Acquire lock
  logger.info("1. Testing /storage/sync/lock (POST - acquire)...");
  const lockResult = await makeX402Request(
    x402Client,
    "/storage/sync/lock",
    "POST",
    { name: lockName, ttl: 60 },
    tokenType,
    logger
  );

  const lockData = lockResult.data as { ok?: boolean; acquired?: boolean; token?: string; name?: string };
  if (lockResult.status === 200 && lockData.ok && lockData.acquired && lockData.token) {
    lockToken = lockData.token;
    logger.success(`Acquired lock "${lockName}" with token`);
    successCount++;
  } else {
    logger.error(`Lock acquire failed: ${JSON.stringify(lockResult.data)}`);
    logger.info("Bailing out: initial lock failed, skipping remaining tests");
    logger.summary(0, totalTests);
    return { passed: 0, total: totalTests, success: false };
  }

  await new Promise((resolve) => setTimeout(resolve, STEP_DELAY_MS));

  // Test 2: Check status
  logger.info("2. Testing /storage/sync/status/:name (GET)...");
  const statusResult = await makeX402Request(
    x402Client,
    `/storage/sync/status/${lockName}`,
    "GET",
    null,
    tokenType,
    logger
  );

  const statusData = statusResult.data as { ok?: boolean; locked?: boolean; name?: string };
  if (statusResult.status === 200 && statusData.ok && statusData.locked === true) {
    logger.success(`Status shows lock "${lockName}" is held`);
    successCount++;
  } else {
    logger.error(`Status check failed: ${JSON.stringify(statusResult.data)}`);
  }

  await new Promise((resolve) => setTimeout(resolve, STEP_DELAY_MS));

  // Test 3: List locks
  logger.info("3. Testing /storage/sync/list (GET)...");
  const listResult = await makeX402Request(
    x402Client,
    "/storage/sync/list",
    "GET",
    null,
    tokenType,
    logger
  );

  const listData = listResult.data as { ok?: boolean; locks?: Array<{ name: string }>; count?: number };
  if (listResult.status === 200 && listData.ok && Array.isArray(listData.locks)) {
    const foundLock = listData.locks.find((l) => l.name === lockName);
    if (foundLock) {
      logger.success(`List shows ${listData.count} lock(s), found test lock`);
      successCount++;
    } else {
      logger.error(`List returned locks but test lock not found`);
    }
  } else {
    logger.error(`List failed: ${JSON.stringify(listResult.data)}`);
  }

  await new Promise((resolve) => setTimeout(resolve, STEP_DELAY_MS));

  // Test 4: Extend lock
  logger.info("4. Testing /storage/sync/extend (POST)...");
  const extendResult = await makeX402Request(
    x402Client,
    "/storage/sync/extend",
    "POST",
    { name: lockName, token: lockToken, ttl: 120 },
    tokenType,
    logger
  );

  const extendData = extendResult.data as { ok?: boolean; extended?: boolean; name?: string };
  if (extendResult.status === 200 && extendData.ok && extendData.extended) {
    logger.success(`Extended lock "${lockName}" TTL`);
    successCount++;
  } else {
    logger.error(`Extend failed: ${JSON.stringify(extendResult.data)}`);
  }

  await new Promise((resolve) => setTimeout(resolve, STEP_DELAY_MS));

  // Test 5: Release lock
  logger.info("5. Testing /storage/sync/unlock (POST)...");
  const unlockResult = await makeX402Request(
    x402Client,
    "/storage/sync/unlock",
    "POST",
    { name: lockName, token: lockToken },
    tokenType,
    logger
  );

  const unlockData = unlockResult.data as { ok?: boolean; released?: boolean; name?: string };
  if (unlockResult.status === 200 && unlockData.ok && unlockData.released) {
    logger.success(`Released lock "${lockName}"`);
    successCount++;
  } else {
    logger.error(`Unlock failed: ${JSON.stringify(unlockResult.data)}`);
  }

  await new Promise((resolve) => setTimeout(resolve, STEP_DELAY_MS));

  // Test 6: Verify unlock via status
  logger.info("6. Verifying unlock via status...");
  const verifyResult = await makeX402Request(
    x402Client,
    `/storage/sync/status/${lockName}`,
    "GET",
    null,
    tokenType,
    logger
  );

  const verifyData = verifyResult.data as { ok?: boolean; locked?: boolean };
  if (verifyResult.status === 200 && verifyData.ok && verifyData.locked === false) {
    logger.success(`Verified lock "${lockName}" is released`);
    successCount++;
  } else {
    logger.error(`Lock still held after unlock: ${JSON.stringify(verifyResult.data)}`);
  }

  logger.summary(successCount, totalTests);
  return { passed: successCount, total: totalTests, success: successCount === totalTests };
}

// Run if executed directly
if (import.meta.main) {
  const verbose = process.argv.includes("-v") || process.argv.includes("--verbose");
  runSyncLifecycle(verbose)
    .then((result) => process.exit(result.success ? 0 : 1))
    .catch((err) => {
      console.error("Test failed:", err);
      process.exit(1);
    });
}
