#!/usr/bin/env bun
/**
 * DB Storage Lifecycle Test
 *
 * Tests the complete lifecycle of database storage operations:
 * 1. Execute (create a table)
 * 2. Execute (insert data)
 * 3. Query (select data)
 * 4. Schema (verify table exists)
 * 5. Execute (drop table to clean up)
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

export async function runDbLifecycle(verbose = false): Promise<LifecycleTestResult> {
  if (!X402_CLIENT_PK) {
    throw new Error("Set X402_CLIENT_PK env var with mnemonic");
  }

  const { address, key } = await deriveChildAccount(X402_NETWORK, X402_CLIENT_PK, 0);
  const logger = createTestLogger("db-lifecycle", verbose);
  logger.info(`Test wallet address: ${address}`);

  const x402Client = new X402PaymentClient({
    network: X402_NETWORK,
    privateKey: key,
  });

  // Test with STX only to save on payments
  const tokenType: TokenType = "STX";
  // Generate unique table name to avoid conflicts
  const tableName = `test_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

  let successCount = 0;
  const totalTests = 5;

  // Test 1: Create table
  logger.info("1. Testing /storage/db/execute (POST - create table)...");
  const createResult = await makeX402Request(
    x402Client,
    "/storage/db/execute",
    "POST",
    { query: `CREATE TABLE ${tableName} (id INTEGER PRIMARY KEY, name TEXT, value TEXT)` },
    tokenType,
    logger
  );

  const createData = createResult.data as { ok?: boolean; rowsAffected?: number };
  if (createResult.status === 200 && createData.ok) {
    logger.success(`Created table "${tableName}"`);
    successCount++;
  } else {
    logger.error(`Create table failed: ${JSON.stringify(createResult.data)}`);
    logger.info("Bailing out: initial create failed, skipping remaining tests");
    logger.summary(0, totalTests);
    return { passed: 0, total: totalTests, success: false };
  }

  await new Promise((resolve) => setTimeout(resolve, STEP_DELAY_MS));

  // Test 2: Insert data
  logger.info("2. Testing /storage/db/execute (POST - insert)...");
  const insertResult = await makeX402Request(
    x402Client,
    "/storage/db/execute",
    "POST",
    { query: `INSERT INTO ${tableName} (id, name, value) VALUES (1, 'test', 'hello world')` },
    tokenType,
    logger
  );

  const insertData = insertResult.data as { ok?: boolean; rowsAffected?: number };
  if (insertResult.status === 200 && insertData.ok && insertData.rowsAffected === 1) {
    logger.success(`Inserted 1 row into "${tableName}"`);
    successCount++;
  } else {
    logger.error(`Insert failed: ${JSON.stringify(insertResult.data)}`);
  }

  await new Promise((resolve) => setTimeout(resolve, STEP_DELAY_MS));

  // Test 3: Query data
  logger.info("3. Testing /storage/db/query (POST - select)...");
  const queryResult = await makeX402Request(
    x402Client,
    "/storage/db/query",
    "POST",
    { query: `SELECT * FROM ${tableName} WHERE id = 1` },
    tokenType,
    logger
  );

  const queryData = queryResult.data as { ok?: boolean; rows?: unknown[]; columns?: string[] };
  if (
    queryResult.status === 200 &&
    queryData.ok &&
    Array.isArray(queryData.rows) &&
    queryData.rows.length === 1
  ) {
    logger.success(`Query returned 1 row`);
    successCount++;
  } else {
    logger.error(`Query failed: ${JSON.stringify(queryResult.data)}`);
  }

  await new Promise((resolve) => setTimeout(resolve, STEP_DELAY_MS));

  // Test 4: Get schema
  logger.info("4. Testing /storage/db/schema (GET)...");
  const schemaResult = await makeX402Request(
    x402Client,
    "/storage/db/schema",
    "GET",
    null,
    tokenType,
    logger
  );

  const schemaData = schemaResult.data as { ok?: boolean; tables?: Array<{ name: string }> };
  if (schemaResult.status === 200 && schemaData.ok && Array.isArray(schemaData.tables)) {
    const foundTable = schemaData.tables.find((t) => t.name === tableName);
    if (foundTable) {
      logger.success(`Schema shows table "${tableName}" exists`);
      successCount++;
    } else {
      logger.error(`Schema returned but test table not found`);
    }
  } else {
    logger.error(`Schema failed: ${JSON.stringify(schemaResult.data)}`);
  }

  await new Promise((resolve) => setTimeout(resolve, STEP_DELAY_MS));

  // Test 5: Drop table (cleanup)
  logger.info("5. Testing /storage/db/execute (POST - drop table)...");
  const dropResult = await makeX402Request(
    x402Client,
    "/storage/db/execute",
    "POST",
    { query: `DROP TABLE ${tableName}` },
    tokenType,
    logger
  );

  const dropData = dropResult.data as { ok?: boolean };
  if (dropResult.status === 200 && dropData.ok) {
    logger.success(`Dropped table "${tableName}"`);
    successCount++;
  } else {
    logger.error(`Drop table failed: ${JSON.stringify(dropResult.data)}`);
  }

  logger.summary(successCount, totalTests);
  return { passed: successCount, total: totalTests, success: successCount === totalTests };
}

// Run if executed directly
if (import.meta.main) {
  const verbose = process.argv.includes("-v") || process.argv.includes("--verbose");
  runDbLifecycle(verbose)
    .then((result) => process.exit(result.success ? 0 : 1))
    .catch((err) => {
      console.error("Test failed:", err);
      process.exit(1);
    });
}
