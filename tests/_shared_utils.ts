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
