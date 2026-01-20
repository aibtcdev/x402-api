/**
 * Shared utilities for X402 API tests
 */

import type { NetworkType, TokenType } from "x402-stacks";

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
  rawText: string;
}

/**
 * Parse error information from response text.
 * Attempts to extract structured error data from JSON, falls back to raw text.
 */
export function parseErrorResponse(text: string): ParsedErrorInfo {
  const result: ParsedErrorInfo = { rawText: text };

  try {
    const parsed = JSON.parse(text);
    result.errorCode = parsed.code;
    result.errorMessage = parsed.error;
    result.retryAfterSecs = parsed.retryAfter;
  } catch {
    // Not JSON - rawText is already set
  }

  return result;
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
