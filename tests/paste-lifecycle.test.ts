#!/usr/bin/env bun
/**
 * Paste Storage Lifecycle Test
 *
 * Tests the complete lifecycle of paste storage operations:
 * 1. Create a paste
 * 2. Get the paste back
 * 3. Delete the paste
 * 4. Verify deletion
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
    body: body ?? undefined,
    retry: {
      maxRetries: 3,
      nonceConflictDelayMs: NONCE_CONFLICT_DELAY_MS,
      verbose: false,
    },
  });

  if (result.wasNonceConflict && result.retryCount && result.retryCount > 0) {
    logger.debug(`Recovered from nonce conflict after ${result.retryCount} retries`);
  }

  return { status: result.status, data: result.data };
}

export interface LifecycleTestResult {
  passed: number;
  total: number;
  success: boolean;
}

export async function runPasteLifecycle(verbose = false): Promise<LifecycleTestResult> {
  if (!X402_CLIENT_PK) {
    throw new Error("Set X402_CLIENT_PK env var with mnemonic");
  }

  const { address, key } = await deriveChildAccount(X402_NETWORK, X402_CLIENT_PK, 0);
  const logger = createTestLogger("paste-lifecycle", verbose);
  logger.info(`Test wallet address: ${address}`);

  const x402Client = new X402PaymentClient({
    network: X402_NETWORK,
    privateKey: key,
  });

  // Test with STX only to save on payments
  const tokenType: TokenType = "STX";
  const testContent = `Test paste content from lifecycle test - ${generateTestId("paste")}`;
  const testTitle = "Test Paste";
  const testLanguage = "text";

  let successCount = 0;
  const totalTests = 4;
  let pasteId: string | null = null;

  // Test 1: Create a paste
  logger.info("1. Testing /storage/paste (POST - create)...");
  const createResult = await makeX402Request(
    x402Client,
    "/storage/paste",
    "POST",
    { content: testContent, title: testTitle, language: testLanguage, ttl: 300 },
    tokenType,
    logger
  );

  const createData = createResult.data as { ok?: boolean; id?: string; createdAt?: string };
  if (createResult.status === 200 && createData.ok && createData.id) {
    pasteId = createData.id;
    logger.success(`Created paste with id "${pasteId}"`);
    successCount++;
  } else {
    logger.error(`Create failed: ${JSON.stringify(createResult.data)}`);
    logger.info("Bailing out: initial create failed, skipping remaining tests");
    logger.summary(0, totalTests);
    return { passed: 0, total: totalTests, success: false };
  }

  await new Promise((resolve) => setTimeout(resolve, STEP_DELAY_MS));

  // Test 2: Get the paste back
  logger.info("2. Testing /storage/paste/:id (GET)...");
  const getResult = await makeX402Request(
    x402Client,
    `/storage/paste/${pasteId}`,
    "GET",
    null,
    tokenType,
    logger
  );

  const getData = getResult.data as { ok?: boolean; content?: string; title?: string };
  if (getResult.status === 200 && getData.ok && getData.content === testContent) {
    logger.success(`Got paste back correctly`);
    successCount++;
  } else {
    logger.error(`Get failed: ${JSON.stringify(getResult.data)}`);
  }

  await new Promise((resolve) => setTimeout(resolve, STEP_DELAY_MS));

  // Test 3: Delete the paste
  logger.info("3. Testing /storage/paste/:id (DELETE)...");
  const deleteResult = await makeX402Request(
    x402Client,
    `/storage/paste/${pasteId}`,
    "DELETE",
    null,
    tokenType,
    logger
  );

  const deleteData = deleteResult.data as { ok?: boolean; deleted?: boolean };
  if (deleteResult.status === 200 && deleteData.ok) {
    logger.success(`Deleted paste "${pasteId}"`);
    successCount++;
  } else {
    logger.error(`Delete failed: ${JSON.stringify(deleteResult.data)}`);
  }

  await new Promise((resolve) => setTimeout(resolve, STEP_DELAY_MS));

  // Test 4: Verify deletion
  logger.info("4. Verifying deletion...");
  const verifyResult = await makeX402Request(
    x402Client,
    `/storage/paste/${pasteId}`,
    "GET",
    null,
    tokenType,
    logger
  );

  if (verifyResult.status === 404) {
    logger.success(`Verified paste is deleted (404)`);
    successCount++;
  } else {
    logger.error(`Paste still exists after delete: ${JSON.stringify(verifyResult.data)}`);
  }

  logger.summary(successCount, totalTests);
  return { passed: successCount, total: totalTests, success: successCount === totalTests };
}

// Run if executed directly
if (import.meta.main) {
  const verbose = process.argv.includes("-v") || process.argv.includes("--verbose");
  runPasteLifecycle(verbose)
    .then((result) => process.exit(result.success ? 0 : 1))
    .catch((err) => {
      console.error("Test failed:", err);
      process.exit(1);
    });
}
