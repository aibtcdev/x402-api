/**
 * Test Generator for X402 API Endpoints (V2 Protocol)
 *
 * Creates standardized test functions for paid endpoints that follow the
 * X402 v2 payment flow: initial 402 -> sign payment -> retry with header -> validate.
 */

import {
  X402PaymentClient,
  encodePaymentPayload,
  X402_HEADERS,
} from "x402-stacks";
import type {
  TokenType,
  NetworkType,
  PaymentRequiredV2,
  PaymentRequirementsV2,
  PaymentPayloadV2,
} from "x402-stacks";
import { deriveChildAccount } from "../src/utils/wallet";
import {
  TEST_TOKENS,
  X402_CLIENT_PK,
  X402_NETWORK,
  X402_WORKER_URL,
  createTestLogger,
  validators,
  type TestLogger,
} from "./_shared_utils";

// Re-export validators for convenience
export { validators };

export type { PaymentRequiredV2 };

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
 * Decode base64 JSON from header or body
 */
function decodeBase64Json<T>(base64: string): T | null {
  try {
    const json = atob(base64);
    return JSON.parse(json) as T;
  } catch {
    return null;
  }
}

/**
 * Creates a test function for an X402 v2 paid endpoint.
 * The returned function follows the standard X402 v2 payment flow.
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

  // Parse v2 payment required from response body
  const paymentReqBody: PaymentRequiredV2 = await initialRes.json();
  logger.debug("402 Payment req (v2)", paymentReqBody);

  // Validate v2 format
  if (paymentReqBody.x402Version !== 2) {
    logger.error(`Expected x402Version 2, got ${paymentReqBody.x402Version}`);
    return false;
  }

  if (!paymentReqBody.accepts || paymentReqBody.accepts.length === 0) {
    logger.error("No accepts array in payment requirements");
    return false;
  }

  // Get the payment requirements for the requested token type
  const requirements = paymentReqBody.accepts[0];

  logger.debug("Using requirements", {
    scheme: requirements.scheme,
    network: requirements.network,
    amount: requirements.amount,
    asset: requirements.asset,
    payTo: requirements.payTo,
  });

  // Step 2: Sign payment using v1 client (which returns signedTransaction)
  // We need to build a v1-compatible payment request for the client
  logger.debug("2. Signing payment...");

  // Build v1-compatible request for the client's signPayment method
  const v1CompatibleRequest = {
    maxAmountRequired: requirements.amount,
    resource: paymentReqBody.resource.url,
    payTo: requirements.payTo,
    network: X402_NETWORK as "mainnet" | "testnet",
    nonce: crypto.randomUUID(),
    expiresAt: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
    tokenType: tokenType,
  };

  const signResult = await x402Client.signPayment(v1CompatibleRequest);
  logger.debug("Signed payment", { signedTransaction: signResult.signedTransaction.substring(0, 50) + "..." });

  // Step 3: Build v2 payment payload
  const paymentPayload: PaymentPayloadV2 = {
    x402Version: 2,
    resource: paymentReqBody.resource,
    accepted: requirements,
    payload: {
      transaction: signResult.signedTransaction,
    },
  };

  // Encode to base64 for header
  const paymentSignature = encodePaymentPayload(paymentPayload);
  logger.debug("Payment signature (base64)", paymentSignature.substring(0, 50) + "...");

  // Step 4: Retry with payment-signature header
  logger.debug("3. Retry with payment-signature header...");

  const retryRes = await fetch(fullUrl, {
    method: config.method,
    headers: {
      ...(config.body ? { "Content-Type": "application/json" } : {}),
      ...config.headers,
      [X402_HEADERS.PAYMENT_SIGNATURE]: paymentSignature,
      "X-PAYMENT-TOKEN-TYPE": tokenType,
    },
    body: config.body ? JSON.stringify(config.body) : undefined,
  });

  logger.debug(`Retry status: ${retryRes.status}`);

  // Check if status is acceptable (200 or in allowedStatuses)
  const acceptableStatuses = [200, ...(config.allowedStatuses || [])];
  if (!acceptableStatuses.includes(retryRes.status)) {
    const errText = await retryRes.text();
    logger.error(`Retry failed (${retryRes.status}): ${errText.slice(0, 200)}`);
    return false;
  }

  // Check for payment-response header
  const paymentResponseHeader = retryRes.headers.get(X402_HEADERS.PAYMENT_RESPONSE);
  if (paymentResponseHeader) {
    logger.debug("Payment response header present");
  }

  // Step 5: Validate response
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
