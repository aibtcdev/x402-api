#!/usr/bin/env bun
/**
 * Payment Polling Lifecycle Test
 *
 * Tests the boring-tx end-to-end path:
 * 1. Make a real x402 payment against /hashing/sha256
 * 2. Observe paymentId in X-PAYMENT-ID response header
 * 3. Poll GET /payment-status/:paymentId (DO cached state, free route)
 *    until terminal (confirmed | failed | replaced | not_found) or timeout
 * 4. Assert final snapshot has expected shape
 *
 * Requires X402_CLIENT_PK env var with testnet mnemonic.
 */

import type { TokenType } from "x402-stacks";
import { X402PaymentClient } from "x402-stacks";
import { deriveChildAccount } from "../src/utils/wallet";
import {
  X402_CLIENT_PK,
  X402_NETWORK,
  X402_WORKER_URL,
  createTestLogger,
  makeX402RequestWithRetry,
  NONCE_CONFLICT_DELAY_MS,
  sleep,
} from "./_shared_utils";

// =============================================================================
// Types
// =============================================================================

export interface LifecycleTestResult {
  passed: number;
  total: number;
  success: boolean;
}

interface PaymentStatusSnapshot {
  paymentId: string;
  status: string;
  terminalReason?: string;
  txid?: string;
  confirmedAt?: string;
  checkStatusUrl: string;
  polledAt: string;
  pollCount: number;
}

// =============================================================================
// Constants
// =============================================================================

const TERMINAL_STATUSES = new Set(["confirmed", "failed", "replaced", "not_found"]);

/** Poll interval: 10 seconds between DO status checks */
const POLL_INTERVAL_MS = 10_000;

/** Max polls before giving up: 12 * 10s = 2 minutes */
const MAX_POLLS = 12;

// =============================================================================
// Helpers
// =============================================================================

/**
 * Poll GET /payment-status/:paymentId on the worker until terminal or timeout.
 * This route is free (no x402 payment required) and returns the DO's cached snapshot.
 */
async function pollDOStatus(
  paymentId: string,
  verbose: boolean
): Promise<PaymentStatusSnapshot | null> {
  const logger = createTestLogger("payment-polling", verbose);
  const url = `${X402_WORKER_URL}/payment-status/${paymentId}`;

  for (let poll = 1; poll <= MAX_POLLS; poll++) {
    logger.debug(`Poll ${poll}/${MAX_POLLS}: GET /payment-status/${paymentId}`);

    let res: Response;
    try {
      res = await fetch(url, { headers: { Accept: "application/json" } });
    } catch (err) {
      logger.debug(`Poll ${poll} network error: ${err}`);
      await sleep(POLL_INTERVAL_MS);
      continue;
    }

    if (res.status === 404) {
      // DO not yet populated — relay fire-and-forget may not have landed yet
      logger.debug(`Poll ${poll}: 404 — DO not yet populated, waiting...`);
      await sleep(POLL_INTERVAL_MS);
      continue;
    }

    if (res.status !== 200) {
      logger.debug(`Poll ${poll}: unexpected status ${res.status}`);
      await sleep(POLL_INTERVAL_MS);
      continue;
    }

    const snapshot = await res.json() as PaymentStatusSnapshot;
    logger.debug(`Poll ${poll}: status=${snapshot.status} pollCount=${snapshot.pollCount}`);

    if (TERMINAL_STATUSES.has(snapshot.status)) {
      return snapshot;
    }

    // Not yet terminal — keep polling
    await sleep(POLL_INTERVAL_MS);
  }

  // Timeout — return last known state if available
  try {
    const res = await fetch(url, { headers: { Accept: "application/json" } });
    if (res.status === 200) {
      return await res.json() as PaymentStatusSnapshot;
    }
  } catch {
    // ignore
  }
  return null;
}

// =============================================================================
// Main lifecycle runner
// =============================================================================

export async function runPaymentPollingLifecycle(verbose = false): Promise<LifecycleTestResult> {
  if (!X402_CLIENT_PK) {
    throw new Error("Set X402_CLIENT_PK env var with mnemonic");
  }

  const { address, key } = await deriveChildAccount(X402_NETWORK, X402_CLIENT_PK, 0);
  const logger = createTestLogger("payment-polling", verbose);
  logger.info(`Test wallet address: ${address}`);
  logger.info(`Worker URL: ${X402_WORKER_URL}`);

  const x402Client = new X402PaymentClient({
    network: X402_NETWORK,
    privateKey: key,
  });

  const tokenType: TokenType = "STX";
  let successCount = 0;
  const totalTests = 3;

  // -------------------------------------------------------------------------
  // Test 1: Make a payment and observe X-PAYMENT-ID header
  // -------------------------------------------------------------------------
  logger.info("1. Making x402 payment to /hashing/sha256...");

  const result = await makeX402RequestWithRetry(
    "/hashing/sha256",
    "POST",
    x402Client,
    tokenType,
    {
      body: { data: "payment-polling-lifecycle-test" },
      retry: {
        maxRetries: 3,
        nonceConflictDelayMs: NONCE_CONFLICT_DELAY_MS,
        verbose,
      },
    }
  );

  logger.debug(`Payment result: status=${result.status}`, result.data);

  if (result.status !== 200) {
    logger.error(`Payment failed: status=${result.status} data=${JSON.stringify(result.data)}`);
    logger.summary(0, totalTests);
    return { passed: 0, total: totalTests, success: false };
  }

  const paymentId = result.headers.get("x-payment-id");
  logger.debug(`X-PAYMENT-ID header: ${paymentId}`);
  if (!paymentId || !paymentId.startsWith("pay_")) {
    logger.error(`X-PAYMENT-ID header missing or malformed: "${paymentId}"`);
    logger.summary(0, totalTests);
    return { passed: 0, total: totalTests, success: false };
  }

  logger.success(`Payment succeeded — paymentId: ${paymentId}`);
  successCount++;

  // -------------------------------------------------------------------------
  // Test 2: Poll DO until terminal
  // -------------------------------------------------------------------------
  logger.info(`2. Polling GET /payment-status/${paymentId} until terminal...`);

  const snapshot = await pollDOStatus(paymentId, verbose);

  if (!snapshot) {
    logger.error("Timed out waiting for terminal state or DO not populated");
    logger.summary(successCount, totalTests);
    return { passed: successCount, total: totalTests, success: false };
  }

  const isTerminal = TERMINAL_STATUSES.has(snapshot.status);
  if (isTerminal) {
    logger.success(`DO reached terminal state: ${snapshot.status} (pollCount=${snapshot.pollCount})`);
    successCount++;
  } else {
    logger.error(`DO did not reach terminal state: status=${snapshot.status}`);
  }

  // -------------------------------------------------------------------------
  // Test 3: Validate snapshot shape
  // -------------------------------------------------------------------------
  logger.info("3. Validating snapshot shape...");

  const hasExpectedShape =
    typeof snapshot.paymentId === "string" &&
    snapshot.paymentId === paymentId &&
    typeof snapshot.status === "string" &&
    typeof snapshot.checkStatusUrl === "string" &&
    snapshot.checkStatusUrl.length > 0 &&
    typeof snapshot.polledAt === "string" &&
    typeof snapshot.pollCount === "number";

  if (hasExpectedShape) {
    logger.success(
      `Snapshot shape valid: paymentId=${snapshot.paymentId} checkStatusUrl=${snapshot.checkStatusUrl}`
    );
    successCount++;
  } else {
    logger.error(`Snapshot shape invalid: ${JSON.stringify(snapshot)}`);
  }

  logger.summary(successCount, totalTests);
  return { passed: successCount, total: totalTests, success: successCount === totalTests };
}

// Run if executed directly
if (import.meta.main) {
  const verbose = process.argv.includes("-v") || process.argv.includes("--verbose");
  runPaymentPollingLifecycle(verbose)
    .then((result) => process.exit(result.success ? 0 : 1))
    .catch((err) => {
      console.error("Test failed:", err);
      process.exit(1);
    });
}
