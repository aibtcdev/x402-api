#!/usr/bin/env bun
/**
 * Memory (Vector Storage) Lifecycle Test
 *
 * Tests the complete lifecycle of memory/vector storage operations:
 * 1. Store (add items with embeddings)
 * 2. List (verify items exist)
 * 3. Search (semantic similarity search)
 * 4. Delete (remove specific items)
 * 5. Clear (remove all items)
 * 6. List (verify empty)
 */

import type { TokenType } from "x402-stacks";
import { X402PaymentClient } from "x402-stacks";
import { deriveChildAccount } from "../src/utils/wallet";
import {
  X402_CLIENT_PK,
  X402_NETWORK,
  createTestLogger,
  STEP_DELAY_MS,
  generateTestId,
  makeX402RequestWithRetry,
  sleep,
  NONCE_CONFLICT_DELAY_MS,
} from "./_shared_utils";

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

export interface LifecycleTestResult {
  passed: number;
  total: number;
  success: boolean;
}

export async function runMemoryLifecycle(verbose = false): Promise<LifecycleTestResult> {
  if (!X402_CLIENT_PK) {
    throw new Error("Set X402_CLIENT_PK env var with mnemonic");
  }

  const { address, key } = await deriveChildAccount(X402_NETWORK, X402_CLIENT_PK, 0);
  const logger = createTestLogger("memory-lifecycle", verbose);
  logger.info(`Test wallet address: ${address}`);

  const x402Client = new X402PaymentClient({
    network: X402_NETWORK,
    privateKey: key,
  });

  // Test with STX only to save on payments
  const tokenType: TokenType = "STX";
  const testPrefix = generateTestId("mem");
  const testItems = [
    { id: `${testPrefix}-1`, text: "The quick brown fox jumps over the lazy dog." },
    { id: `${testPrefix}-2`, text: "Artificial intelligence is transforming the world of technology." },
    { id: `${testPrefix}-3`, text: "Bitcoin is a decentralized digital currency." },
  ];

  let successCount = 0;
  const totalTests = 6;

  // Test 1: Store items with embeddings
  logger.info("1. Testing /storage/memory/store (POST)...");
  const storeResult = await makeX402Request(
    x402Client,
    "/storage/memory/store",
    "POST",
    { items: testItems },
    tokenType,
    logger
  );

  const storeData = storeResult.data as { ok?: boolean; stored?: number };
  if (storeResult.status === 200 && storeData.ok && storeData.stored === testItems.length) {
    logger.success(`Stored ${storeData.stored} items with embeddings`);
    successCount++;
  } else {
    logger.error(`Store failed: ${JSON.stringify(storeResult.data)}`);
    logger.info("Bailing out: initial store failed, skipping remaining tests");
    logger.summary(0, totalTests);
    return { passed: 0, total: totalTests, success: false };
  }

  await new Promise((resolve) => setTimeout(resolve, STEP_DELAY_MS));

  // Test 2: List items
  logger.info("2. Testing /storage/memory/list (GET)...");
  const listResult = await makeX402Request(
    x402Client,
    "/storage/memory/list",
    "GET",
    null,
    tokenType,
    logger
  );

  const listData = listResult.data as { ok?: boolean; items?: Array<{ id: string }>; total?: number };
  if (listResult.status === 200 && listData.ok && Array.isArray(listData.items)) {
    // Check if our test items are in the list
    const foundItems = listData.items.filter((i) => i.id.startsWith(testPrefix));
    if (foundItems.length >= testItems.length) {
      logger.success(`List shows ${listData.total} total items, found ${foundItems.length} test items`);
      successCount++;
    } else {
      logger.error(`List returned items but only found ${foundItems.length} of ${testItems.length} test items`);
    }
  } else {
    logger.error(`List failed: ${JSON.stringify(listResult.data)}`);
  }

  await new Promise((resolve) => setTimeout(resolve, STEP_DELAY_MS));

  // Test 3: Search (semantic similarity)
  logger.info("3. Testing /storage/memory/search (POST)...");
  const searchResult = await makeX402Request(
    x402Client,
    "/storage/memory/search",
    "POST",
    { query: "cryptocurrency blockchain", limit: 5, threshold: 0.3 },
    tokenType,
    logger
  );

  const searchData = searchResult.data as { ok?: boolean; results?: Array<{ id: string; similarity: number }> };
  if (searchResult.status === 200 && searchData.ok && Array.isArray(searchData.results)) {
    // The Bitcoin-related item should have higher similarity
    logger.success(`Search returned ${searchData.results.length} results`);
    successCount++;
  } else {
    logger.error(`Search failed: ${JSON.stringify(searchResult.data)}`);
  }

  await new Promise((resolve) => setTimeout(resolve, STEP_DELAY_MS));

  // Test 4: Delete one item
  logger.info("4. Testing /storage/memory/delete (POST)...");
  const deleteResult = await makeX402Request(
    x402Client,
    "/storage/memory/delete",
    "POST",
    { ids: [testItems[0].id] },
    tokenType,
    logger
  );

  const deleteData = deleteResult.data as { ok?: boolean; deleted?: number };
  if (deleteResult.status === 200 && deleteData.ok && deleteData.deleted === 1) {
    logger.success(`Deleted 1 item`);
    successCount++;
  } else {
    logger.error(`Delete failed: ${JSON.stringify(deleteResult.data)}`);
  }

  await new Promise((resolve) => setTimeout(resolve, STEP_DELAY_MS));

  // Test 5: Clear all remaining items
  logger.info("5. Testing /storage/memory/clear (POST)...");
  const clearResult = await makeX402Request(
    x402Client,
    "/storage/memory/clear",
    "POST",
    {},
    tokenType,
    logger
  );

  const clearData = clearResult.data as { ok?: boolean; cleared?: number };
  if (clearResult.status === 200 && clearData.ok) {
    logger.success(`Cleared memory (${clearData.cleared || 0} items removed)`);
    successCount++;
  } else {
    logger.error(`Clear failed: ${JSON.stringify(clearResult.data)}`);
  }

  await new Promise((resolve) => setTimeout(resolve, STEP_DELAY_MS));

  // Test 6: Verify memory is empty
  logger.info("6. Verifying memory is empty...");
  const verifyResult = await makeX402Request(
    x402Client,
    "/storage/memory/list",
    "GET",
    null,
    tokenType,
    logger
  );

  const verifyData = verifyResult.data as { ok?: boolean; total?: number };
  if (verifyResult.status === 200 && verifyData.ok && verifyData.total === 0) {
    logger.success(`Memory is empty`);
    successCount++;
  } else {
    logger.error(`Memory not empty after clear: ${JSON.stringify(verifyResult.data)}`);
  }

  logger.summary(successCount, totalTests);
  return { passed: successCount, total: totalTests, success: successCount === totalTests };
}

// Run if executed directly
if (import.meta.main) {
  const verbose = process.argv.includes("-v") || process.argv.includes("--verbose");
  runMemoryLifecycle(verbose)
    .then((result) => process.exit(result.success ? 0 : 1))
    .catch((err) => {
      console.error("Test failed:", err);
      process.exit(1);
    });
}
