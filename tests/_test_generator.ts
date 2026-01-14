/**
 * Test Generator for X402 API Endpoints
 *
 * Creates standardized test functions for paid endpoints that follow the
 * X402 payment flow: initial 402 -> sign payment -> retry with header -> validate.
 */

import { X402PaymentClient } from "x402-stacks";
import type { TokenType, NetworkType } from "x402-stacks";
import { deriveChildAccount } from "../src/utils/wallet";
import {
  TEST_TOKENS,
  X402_CLIENT_PK,
  X402_NETWORK,
  X402_WORKER_URL,
  createTestLogger,
  type TestLogger,
} from "./_shared_utils";

export interface X402PaymentRequired {
  maxAmountRequired: string;
  resource: string;
  payTo: string;
  network: "mainnet" | "testnet";
  nonce: string;
  expiresAt: string;
  tokenType: TokenType;
  pricingTier?: string;
}

export interface TestConfig {
  /** Short name for the test (used in logs) */
  name: string;
  /** API endpoint path (e.g., "/hashing/sha256") */
  endpoint: string;
  /** HTTP method */
  method: "GET" | "POST" | "DELETE";
  /** Request body for POST requests */
  body?: Record<string, unknown>;
  /** Function to validate the response data */
  validateResponse: (data: unknown, tokenType: TokenType) => boolean;
  /** Optional description for logging */
  description?: string;
  /** Custom headers to include */
  headers?: Record<string, string>;
  /** Expected content type (defaults to application/json) */
  expectedContentType?: string;
  /** Additional HTTP status codes to accept as valid (besides 200) */
  allowedStatuses?: number[];
  /** Skip payment flow for free endpoints */
  skipPayment?: boolean;
}

export interface TestResult {
  tokenResults: Record<string, boolean>;
}

/**
 * Creates a test function for an X402 paid endpoint.
 * The returned function follows the standard X402 payment flow.
 */
export function createEndpointTest(config: TestConfig) {
  return async function testX402ManualFlow(verbose = false): Promise<TestResult> {
    if (!X402_CLIENT_PK) {
      throw new Error("Set X402_CLIENT_PK env var with testnet private key mnemonic");
    }

    const { address, key } = await deriveChildAccount(
      X402_NETWORK as NetworkType,
      X402_CLIENT_PK,
      0
    );

    const logger = createTestLogger(config.name, verbose);
    logger.info(`Test wallet address: ${address}`);
    if (config.description) {
      logger.info(`Testing: ${config.description}`);
    }

    const x402Client = new X402PaymentClient({
      network: X402_NETWORK as NetworkType,
      privateKey: key,
    });

    const tokenResults: Record<string, boolean> = TEST_TOKENS.reduce(
      (acc, t) => {
        acc[t] = false;
        return acc;
      },
      {} as Record<string, boolean>
    );

    for (const tokenType of TEST_TOKENS) {
      logger.info(`--- Testing ${tokenType} ---`);

      try {
        const success = await testSingleToken(config, tokenType, x402Client, logger);
        tokenResults[tokenType] = success;
      } catch (error) {
        logger.error(`Exception for ${tokenType}: ${String(error)}`);
        tokenResults[tokenType] = false;
      }
    }

    const successCount = Object.values(tokenResults).filter((v) => v).length;
    logger.summary(successCount, TEST_TOKENS.length);

    return { tokenResults };
  };
}

async function testSingleToken(
  config: TestConfig,
  tokenType: TokenType,
  x402Client: X402PaymentClient,
  logger: TestLogger
): Promise<boolean> {
  const endpoint = config.endpoint.includes("?")
    ? `${config.endpoint}&tokenType=${tokenType}`
    : `${config.endpoint}?tokenType=${tokenType}`;
  const fullUrl = `${X402_WORKER_URL}${endpoint}`;

  // For free endpoints, skip the payment flow
  if (config.skipPayment) {
    logger.debug("Direct request (free endpoint)...");

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
      logger.error(`Request failed (${res.status}): ${text.slice(0, 100)}`);
      return false;
    }

    const contentType = res.headers.get("content-type") || "";
    if (contentType.includes("application/json")) {
      const data = await res.json();
      logger.debug("Response data", data);
      if (config.validateResponse(data, tokenType)) {
        logger.success(`Passed for ${tokenType}`);
        return true;
      }
      logger.error(`Validation failed for ${tokenType}`);
      return false;
    }
    logger.success(`Passed for ${tokenType}`);
    return true;
  }

  // Step 1: Initial request (expect 402)
  logger.debug("1. Initial request (expect 402)...");

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
    logger.error(`Expected 402, got ${initialRes.status}: ${text.slice(0, 100)}`);
    return false;
  }

  const paymentReq: X402PaymentRequired = await initialRes.json();
  logger.debug("402 Payment req", paymentReq);

  if (paymentReq.tokenType !== tokenType) {
    logger.error(`Expected tokenType ${tokenType}, got ${paymentReq.tokenType}`);
    return false;
  }

  // Step 2: Sign payment
  logger.debug("2. Signing payment...");
  const signResult = await x402Client.signPayment(paymentReq);
  logger.debug("Signed payment", signResult);

  // Step 3: Retry with X-PAYMENT header
  logger.debug("3. Retry with X-PAYMENT...");

  const retryRes = await fetch(fullUrl, {
    method: config.method,
    headers: {
      ...(config.body ? { "Content-Type": "application/json" } : {}),
      ...config.headers,
      "X-PAYMENT": signResult.signedTransaction,
      "X-PAYMENT-TOKEN-TYPE": tokenType,
    },
    body: config.body ? JSON.stringify(config.body) : undefined,
  });

  logger.debug(`Retry status: ${retryRes.status}`);

  // Check if status is acceptable (200 or in allowedStatuses)
  const acceptableStatuses = [200, ...(config.allowedStatuses || [])];
  if (!acceptableStatuses.includes(retryRes.status)) {
    const errText = await retryRes.text();
    logger.error(`Retry failed (${retryRes.status}): ${errText.slice(0, 100)}`);
    return false;
  }

  // Step 4: Validate response
  const contentType = retryRes.headers.get("content-type") || "";
  const expectedContentType = config.expectedContentType || "application/json";

  if (!contentType.includes(expectedContentType.split("/")[0])) {
    logger.error(`Expected content-type ${expectedContentType}, got ${contentType}`);
    return false;
  }

  // For JSON responses, parse and validate
  if (contentType.includes("application/json")) {
    const data = await retryRes.json();
    logger.debug("Response data", data);

    if (config.validateResponse(data, tokenType)) {
      logger.success(`Passed for ${tokenType}`);
      return true;
    } else {
      logger.error(`Validation failed for ${tokenType}`);
      logger.debug("Full response", data);
      return false;
    }
  }

  // For non-JSON responses (images, audio, etc.)
  logger.success(`Passed for ${tokenType} (${contentType})`);
  return true;
}

/**
 * Validation helpers for common response patterns
 */
export const validators = {
  /** Validate that a field exists and matches tokenType */
  hasTokenType: (data: unknown, tokenType: TokenType): boolean => {
    const d = data as { tokenType: TokenType };
    return d.tokenType === tokenType;
  },

  /** Validate that a field exists */
  hasField: (data: unknown, field: string): boolean => {
    return typeof data === "object" && data !== null && field in data;
  },

  /** Validate that multiple fields exist */
  hasFields: (data: unknown, fields: string[]): boolean => {
    return fields.every(
      (f) => typeof data === "object" && data !== null && f in data
    );
  },

  /** Validate result equals expected value */
  resultEquals:
    <T>(expected: T) =>
    (data: unknown, tokenType: TokenType) => {
      const d = data as { result: T; tokenType: TokenType };
      return d.result === expected && d.tokenType === tokenType;
    },

  /** Validate result is a non-empty string */
  resultIsString: (data: unknown, tokenType: TokenType) => {
    const d = data as { result: string; tokenType: TokenType };
    return typeof d.result === "string" && d.result.length > 0 && d.tokenType === tokenType;
  },

  /** Validate result is a number */
  resultIsNumber: (data: unknown, tokenType: TokenType) => {
    const d = data as { result: number; tokenType: TokenType };
    return typeof d.result === "number" && d.tokenType === tokenType;
  },

  /** Validate result is an array */
  resultIsArray: (data: unknown, tokenType: TokenType) => {
    const d = data as { result: unknown[]; tokenType: TokenType };
    return Array.isArray(d.result) && d.tokenType === tokenType;
  },
};

/**
 * Create multiple tests from a configuration array
 */
export function createEndpointTests(
  configs: TestConfig[]
): Record<string, () => Promise<TestResult>> {
  const tests: Record<string, () => Promise<TestResult>> = {};

  for (const config of configs) {
    tests[config.name] = createEndpointTest(config);
  }

  return tests;
}
