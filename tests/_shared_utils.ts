/**
 * Shared utilities for X402 API tests (V2 Protocol)
 */

import type {
  NetworkType,
  TokenType,
  PaymentRequiredV2,
  PaymentRequirementsV2,
  PaymentPayloadV2,
} from "x402-stacks";
import { encodePaymentPayload, X402_HEADERS } from "x402-stacks";

// =============================================================================
// Test Configuration Types
// =============================================================================

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

export const COLORS = {
  reset: "\x1b[0m",
  bright: "\x1b[1m",
  green: "\x1b[32m",
  red: "\x1b[31m",
  yellow: "\x1b[33m",
  cyan: "\x1b[36m",
  gray: "\x1b[90m",
} as const;

export const X402_CLIENT_PK = process.env.X402_CLIENT_PK;
export const X402_NETWORK = (process.env.X402_NETWORK || "testnet") as NetworkType;

// URL defaults based on network:
//   testnet  → https://x402.aibtc.dev (staging)
//   mainnet  → https://x402.aibtc.com (production)
//   localhost override with X402_WORKER_URL env var
function getWorkerUrl(): string {
  if (process.env.X402_WORKER_URL) {
    return process.env.X402_WORKER_URL;
  }
  return X402_NETWORK === "mainnet"
    ? "https://x402.aibtc.com"
    : "https://x402.aibtc.dev";
}

export const X402_WORKER_URL = getWorkerUrl();

export const TEST_TOKENS: TokenType[] = ["STX", "sBTC", "USDCx"];

// =============================================================================
// Randomization Helpers
// =============================================================================

/**
 * Fisher-Yates shuffle - returns a new shuffled array
 */
export function shuffle<T>(array: T[]): T[] {
  const result = [...array];
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

/**
 * Pick N random items from an array (without replacement)
 */
export function sampleArray<T>(array: T[], n: number): T[] {
  if (array.length === 0) return [];

  // Normalize n to a safe, non-negative integer within array bounds
  let count = Math.floor(n);
  if (!Number.isFinite(count)) count = 0;
  if (count <= 0) return [];
  if (count >= array.length) return shuffle(array);

  return shuffle(array).slice(0, count);
}

/**
 * Pick a random item from an array
 */
export function pickRandom<T>(array: T[]): T {
  if (array.length === 0) {
    throw new Error("pickRandom: cannot pick from an empty array");
  }
  return array[Math.floor(Math.random() * array.length)];
}

// =============================================================================
// Timing Constants
// =============================================================================

/** Delay between test steps (e.g., between CRUD operations in lifecycle tests) */
export const STEP_DELAY_MS = 300;

/** Default delay between independent tests */
export const DEFAULT_TEST_DELAY_MS = 500;

/** Small delay after lifecycle tests before continuing */
export const POST_LIFECYCLE_DELAY_MS = 100;

/** Default max retries for network errors */
export const DEFAULT_MAX_RETRIES = 3;

/** Sleep helper */
export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Error codes that should trigger a retry
 */
export const RETRYABLE_ERROR_CODES = [
  "NETWORK_ERROR",
  "FACILITATOR_UNAVAILABLE",
  "FACILITATOR_ERROR",
  "UNKNOWN_ERROR",
];

/**
 * HTTP status codes that should trigger a retry
 */
export const RETRYABLE_STATUS_CODES = [429, 500, 502, 503, 504];

/**
 * Check if error is a nonce conflict (transaction with same nonce already in mempool)
 * These require waiting for the stuck tx to confirm, then re-signing with fresh nonce
 */
export function isNonceConflict(errorText: string): boolean {
  const lower = errorText.toLowerCase();
  return (
    lower.includes("conflictingnonceinmempool") ||
    lower.includes("conflicting nonce") ||
    lower.includes("nonce already used") ||
    lower.includes("nonce too low")
  );
}

/**
 * Check if an error should be retried based on status, error code, or error message
 */
export function isRetryableError(
  status: number,
  errorCode?: string,
  errorMessage?: string
): boolean {
  if (RETRYABLE_STATUS_CODES.includes(status)) return true;

  if (errorCode && RETRYABLE_ERROR_CODES.includes(errorCode)) return true;

  if (errorMessage) {
    const lowerMsg = errorMessage.toLowerCase();
    const retryablePatterns = [
      "429",
      "rate limit",
      "too many requests",
      "settle",
      "connection failed",
      "request failed",
      "payment failed",
      "transaction failed",
      "timeout",
      "temporarily",
      "try again",
      "network error",
    ];
    if (retryablePatterns.some((pattern) => lowerMsg.includes(pattern))) return true;

    // Nonce conflicts are retryable with special handling
    if (isNonceConflict(lowerMsg)) return true;
  }

  return false;
}

/**
 * Calculate backoff delay with exponential growth capped at 10 seconds
 */
export function calculateBackoff(attempt: number, retryAfterSecs?: number): number {
  const backoffMs = Math.min(1000 * Math.pow(2, attempt), 10000);
  if (retryAfterSecs && retryAfterSecs > 0) {
    return Math.max(retryAfterSecs * 1000, backoffMs);
  }
  return backoffMs;
}

/**
 * HTTP status codes that represent terminal (non-retryable) outcomes.
 *
 * - 200: Successful response
 * - 404: "Not found" is expected in some lifecycle test steps (e.g., verifying
 *   a KV key was deleted). We treat it as terminal rather than retrying.
 */
export const TERMINAL_STATUS_CODES = [200, 404];

/**
 * Check if a status code represents a terminal (non-retryable) outcome.
 * Returns true for success (200) and expected "not found" cases (404).
 */
export function isTerminalStatus(status: number): boolean {
  return TERMINAL_STATUS_CODES.includes(status);
}

/**
 * Parsed error response from API
 */
export interface ParsedErrorInfo {
  errorCode?: string;
  errorMessage?: string;
  retryAfterSecs?: number;
  details?: Record<string, unknown>;
  rawText: string;
}

/**
 * Parse error information from response text.
 * Attempts to extract structured error data from JSON, falls back to raw text.
 *
 * @param text - Response body text
 * @param status - HTTP status code (optional, for better error messages)
 * @param retryAfterHeader - Retry-After header value (optional, overrides body)
 * @returns Parsed error information
 */
export function parseErrorResponse(
  text: string,
  status?: number,
  retryAfterHeader?: string | null
): ParsedErrorInfo {
  const result: ParsedErrorInfo = { rawText: text };

  try {
    const parsed = JSON.parse(text);
    result.errorCode = parsed.code;
    result.errorMessage = parsed.error;
    result.retryAfterSecs = parsed.retryAfter;
    result.details = parsed.details;

    // Override with header value if present
    if (retryAfterHeader) {
      const headerSecs = parseInt(retryAfterHeader, 10);
      if (!isNaN(headerSecs)) {
        result.retryAfterSecs = headerSecs;
      }
    }
  } catch {
    // Not JSON - rawText is already set
  }

  return result;
}

/**
 * Format error response for display in test output
 */
export function formatErrorMessage(parsed: ParsedErrorInfo): string {
  if (parsed.errorCode && parsed.errorMessage) {
    let msg = `[${parsed.errorCode}] ${parsed.errorMessage}`;
    if (parsed.retryAfterSecs) {
      msg += ` (retry after ${parsed.retryAfterSecs}s)`;
    }
    return msg;
  }
  if (parsed.errorMessage) {
    return parsed.errorMessage.slice(0, 80);
  }
  return parsed.rawText.slice(0, 80);
}

/**
 * Attempt to parse response body as JSON, fall back to raw text.
 * Returns the parsed data for use in test results.
 */
export function parseResponseData(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/** Helper to generate unique test IDs (timestamp + random) */
export function generateTestId(prefix = "test"): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export interface TestLogger {
  info: (msg: string) => void;
  success: (msg: string) => void;
  error: (msg: string) => void;
  summary: (successCount: number, total: number) => void;
  debug: (msg: string, data?: unknown) => void;
}

export function createTestLogger(testName: string, verbose = false): TestLogger {
  return {
    info: (msg) => console.log(`${COLORS.cyan}[${testName}]${COLORS.reset} ${msg}`),
    success: (msg) =>
      console.log(`${COLORS.bright}${COLORS.green}[${testName}] ${msg}${COLORS.reset}`),
    error: (msg) =>
      console.log(`${COLORS.bright}${COLORS.red}[${testName}] ${msg}${COLORS.reset}`),
    debug: (msg: string, data?: unknown) => {
      if (verbose) {
        console.log(
          `${COLORS.gray}[${testName}] ${msg}${data ? `: ${JSON.stringify(data, null, 2)}` : ""}${COLORS.reset}`
        );
      }
    },
    summary: (successCount, total) => {
      const passRate = ((successCount / total) * 100).toFixed(1);
      const color = successCount === total ? COLORS.green : COLORS.yellow;
      console.log(
        `${COLORS.bright}${color}[${testName}] ${successCount}/${total} passed (${passRate}%)${COLORS.reset}\n`
      );
    },
  };
}

/** JSON-serializable body type for API requests */
export type JsonBody = Record<string, unknown> | unknown[] | string | number | boolean | null;

// =============================================================================
// Response Validation Helpers
// =============================================================================

/** Type helper for data with tokenType field */
type DataWithToken = { tokenType: TokenType };

/** Check if response has matching tokenType */
export function hasTokenType(data: unknown, tokenType: TokenType): boolean {
  const d = data as DataWithToken;
  return d.tokenType === tokenType;
}

/** Check if response has a specific field */
export function hasField(data: unknown, field: string): boolean {
  return typeof data === "object" && data !== null && field in data;
}

/** Check if response has multiple fields */
export function hasFields(data: unknown, fields: string[]): boolean {
  return fields.every((f) => hasField(data, f));
}

/** Check if response has ok: true */
export function isOk(data: unknown): boolean {
  return hasField(data, "ok") && (data as { ok: boolean }).ok === true;
}

/**
 * Validation helpers for common response patterns
 * Re-exported for convenience in test configs
 */
export const validators = {
  hasTokenType,
  hasField,
  hasFields,
  isOk,

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

// =============================================================================
// Nonce Conflict Retry Helper
// =============================================================================

/** Delay before retrying after nonce conflict (wait for stuck tx to clear from mempool) */
export const NONCE_CONFLICT_DELAY_MS = 30000;

/** Result from makeX402RequestWithRetry */
export interface X402RequestResult {
  status: number;
  data: unknown;
  headers: Headers;
  retryCount?: number;
  wasNonceConflict?: boolean;
}

/** Config options for retry behavior */
export interface RetryConfig {
  maxRetries?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  nonceConflictDelayMs?: number;
  verbose?: boolean;
}

/**
 * Make an X402 request with smart retry logic for nonce conflicts
 *
 * For nonce conflicts:
 * - Wait longer (tx needs to confirm or drop from mempool)
 * - Re-fetch 402 response to get fresh nonce
 * - Re-sign payment with fresh nonce
 */
export async function makeX402RequestWithRetry(
  endpoint: string,
  method: "GET" | "POST" | "DELETE",
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  x402Client: any, // X402PaymentClient - avoid circular import
  tokenType: TokenType,
  options: {
    body?: unknown;
    extraHeaders?: Record<string, string>;
    baseUrl?: string;
    retry?: RetryConfig;
  } = {}
): Promise<X402RequestResult> {
  const { body, extraHeaders, baseUrl = X402_WORKER_URL, retry = {} } = options;

  const {
    maxRetries = DEFAULT_MAX_RETRIES,
    baseDelayMs = 1000,
    maxDelayMs = 10000,
    nonceConflictDelayMs = NONCE_CONFLICT_DELAY_MS,
    verbose = false,
  } = retry;

  const fullUrl = `${baseUrl}${endpoint}`;
  const tokenParam = endpoint.includes("?") ? `&tokenType=${tokenType}` : `?tokenType=${tokenType}`;
  const urlWithToken = `${fullUrl}${tokenParam}`;

  const log = (msg: string) => {
    if (verbose) console.log(`  ${COLORS.gray}[retry] ${msg}${COLORS.reset}`);
  };

  let retryCount = 0;
  let wasNonceConflict = false;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    // Step 1: Get 402 payment requirements (fresh on each attempt for nonce conflicts)
    log(`Attempt ${attempt + 1}/${maxRetries + 1}: fetching payment requirements...`);

    let initialRes: Response;
    try {
      initialRes = await fetch(urlWithToken, {
        method,
        headers: {
          ...(body ? { "Content-Type": "application/json" } : {}),
          ...extraHeaders,
        },
        body: body ? JSON.stringify(body) : undefined,
      });
    } catch (error) {
      // Network-level fetch error - treat as retryable
      log(`Network error during initial request: ${error instanceof Error ? error.message : String(error)}`);
      if (attempt < maxRetries) {
        retryCount++;
        const backoffMs = Math.min(baseDelayMs * Math.pow(2, attempt), maxDelayMs);
        log(`Waiting ${backoffMs}ms before retry...`);
        await sleep(backoffMs);
        continue;
      }
      // Max retries exceeded - return synthetic error response
      return {
        status: 0,
        data: { error: "network_error", message: error instanceof Error ? error.message : String(error) },
        headers: new Headers(),
        retryCount,
        wasNonceConflict,
      };
    }

    // If not 402, return as-is (success or non-payment error)
    if (initialRes.status !== 402) {
      const text = await initialRes.text();
      return {
        status: initialRes.status,
        data: parseResponseData(text),
        headers: initialRes.headers,
        retryCount,
        wasNonceConflict,
      };
    }

    // Step 2: Parse v2 payment requirements and sign payment
    const paymentReqBody: PaymentRequiredV2 = await initialRes.json();

    // Validate v2 format
    if (paymentReqBody.x402Version !== 2 || !paymentReqBody.accepts?.length) {
      return {
        status: 400,
        data: { error: "Invalid v2 payment requirements" },
        headers: new Headers(),
        retryCount,
        wasNonceConflict,
      };
    }

    const requirements = paymentReqBody.accepts[0];
    log(`Payment required: ${requirements.amount} ${requirements.asset}, network: ${requirements.network}`);

    // Parse tokenContract from v2 asset string (required for sBTC and USDCx)
    let tokenContract: { address: string; name: string } | undefined;
    if (requirements.asset !== "STX" && requirements.asset.includes(".")) {
      const [contractAddress, contractName] = requirements.asset.split(".");
      tokenContract = { address: contractAddress, name: contractName };
    }

    // Build v1-compatible request for the client's signPayment method
    const v1CompatibleRequest = {
      maxAmountRequired: requirements.amount,
      resource: paymentReqBody.resource.url,
      payTo: requirements.payTo,
      network: (requirements.network.includes("2147483648") ? "testnet" : "mainnet") as "mainnet" | "testnet",
      nonce: crypto.randomUUID(),
      expiresAt: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
      tokenType,
      tokenContract,
    };

    const signResult = await x402Client.signPayment(v1CompatibleRequest);
    if (!signResult.success || !signResult.signedTransaction) {
      return {
        status: 500,
        data: { error: `Payment signing failed: ${signResult.error || "empty transaction"}` },
        headers: new Headers(),
        retryCount,
        wasNonceConflict,
      };
    }
    log("Payment signed");

    // Build v2 payment payload
    const paymentPayload: PaymentPayloadV2 = {
      x402Version: 2,
      resource: paymentReqBody.resource,
      accepted: requirements,
      payload: {
        transaction: signResult.signedTransaction,
      },
    };

    // Step 3: Submit with v2 payment-signature header
    let paidRes: Response;
    try {
      paidRes = await fetch(urlWithToken, {
        method,
        headers: {
          ...(body ? { "Content-Type": "application/json" } : {}),
          ...extraHeaders,
          [X402_HEADERS.PAYMENT_SIGNATURE]: encodePaymentPayload(paymentPayload),
          "X-PAYMENT-TOKEN-TYPE": tokenType,
        },
        body: body ? JSON.stringify(body) : undefined,
      });
    } catch (error) {
      // Network-level fetch error on paid request - treat as retryable
      log(`Network error during paid request: ${error instanceof Error ? error.message : String(error)}`);
      if (attempt < maxRetries) {
        retryCount++;
        const backoffMs = Math.min(baseDelayMs * Math.pow(2, attempt), maxDelayMs);
        log(`Waiting ${backoffMs}ms before retry...`);
        await sleep(backoffMs);
        continue;
      }
      // Max retries exceeded - return synthetic error response
      return {
        status: 0,
        data: { error: "network_error", message: error instanceof Error ? error.message : String(error) },
        headers: new Headers(),
        retryCount,
        wasNonceConflict,
      };
    }

    // Success or expected terminal status
    if (isTerminalStatus(paidRes.status)) {
      const text = await paidRes.text();
      return {
        status: paidRes.status,
        data: parseResponseData(text),
        headers: paidRes.headers,
        retryCount,
        wasNonceConflict,
      };
    }

    // Check if we should retry
    const errText = await paidRes.text();
    let errorCode: string | undefined;
    let errorMessage: string | undefined;
    let bodyRetryAfter: number | undefined;
    let validationError: string | undefined;

    try {
      const parsed = JSON.parse(errText);
      errorCode = parsed.code;
      errorMessage = parsed.error || parsed.details?.settleError || parsed.details?.exceptionMessage;
      bodyRetryAfter = parsed.retryAfter;
      validationError = parsed.details?.validationError;
    } catch {
      /* not JSON */
    }

    const fullErrorText = `${errorCode || ""} ${errorMessage || ""} ${validationError || ""} ${errText}`;

    // Check for nonce conflict specifically (handled differently from other retryable errors)
    if (isNonceConflict(fullErrorText) && attempt < maxRetries) {
      wasNonceConflict = true;
      retryCount++;
      log(`Nonce conflict detected, waiting ${nonceConflictDelayMs}ms for mempool to clear...`);
      await sleep(nonceConflictDelayMs);
      continue;
    }

    // Check for other retryable errors (mutually exclusive with nonce conflict)
    if (!isNonceConflict(fullErrorText) && isRetryableError(paidRes.status, errorCode, errorMessage || errText) && attempt < maxRetries) {
      retryCount++;
      const retryAfterSecs = paidRes.headers.get("Retry-After")
        ? parseInt(paidRes.headers.get("Retry-After")!, 10)
        : bodyRetryAfter || 0;
      const backoffMs = Math.min(baseDelayMs * Math.pow(2, attempt), maxDelayMs);
      const delayMs = retryAfterSecs > 0 ? retryAfterSecs * 1000 : backoffMs;

      log(`Retryable error (${paidRes.status}), waiting ${delayMs}ms...`);
      await sleep(delayMs);
      continue;
    }

    // Non-retryable error or max retries exceeded
    return {
      status: paidRes.status,
      data: parseResponseData(errText),
      headers: paidRes.headers,
      retryCount,
      wasNonceConflict,
    };
  }

  // Should not reach here, but TypeScript needs a return
  throw new Error("Unexpected end of retry loop");
}
