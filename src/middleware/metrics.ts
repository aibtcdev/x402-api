/**
 * Global Metrics Middleware
 *
 * Tracks all paid API requests to the global MetricsDO for dashboard analytics.
 * Records: calls, success/error rates, latency, response size, geographic distribution.
 */

import type { MiddlewareHandler } from "hono";
import type { Env, AppVariables, TokenType, PricingTier } from "../types";
import type { MetricsRecord } from "../durable-objects/MetricsDO";
import { TIER_PRICING } from "../services/pricing";

// =============================================================================
// Types
// =============================================================================

export interface MetricsMiddlewareOptions {
  /** Pricing tier for this endpoint */
  tier: PricingTier;
  /** Category for grouping (e.g., "inference", "stacks", "hashing", "storage") */
  category: string;
}

// =============================================================================
// Helper Functions
// =============================================================================

/**
 * Normalize endpoint path by removing path parameters
 * e.g., /stacks/profile/SP123... -> /stacks/profile
 */
function normalizeEndpoint(routePath: string): string {
  return routePath.replace(/\/:[^/]+/g, "");
}

/**
 * Classify error types based on status code
 */
function classifyError(statusCode: number): string {
  if (statusCode >= 500) return "server_error";
  if (statusCode === 402) return "payment_required";
  if (statusCode === 401 || statusCode === 403) return "auth_error";
  if (statusCode === 404) return "not_found";
  if (statusCode === 429) return "rate_limited";
  if (statusCode >= 400) return "client_error";
  return "unknown";
}

/**
 * Get amount charged based on tier and token type
 */
function getAmountCharged(tier: PricingTier, tokenType: TokenType): number {
  const pricing = TIER_PRICING[tier];
  if (!pricing) return 0;

  // Convert to micro units for storage
  // STX: store as microSTX (multiply by 1,000,000)
  // sBTC: store as sats (multiply by 100,000,000)
  // USDCx: store as micro units (multiply by 1,000,000)
  switch (tokenType) {
    case "STX":
      return Math.round(pricing.stx * 1_000_000);
    case "sBTC":
      // sBTC pricing is in BTC, convert to sats
      return Math.round(pricing.stx * 100_000_000 * 0.00005); // Approximate STX/BTC ratio
    case "USDCx":
      return Math.round(pricing.usd * 1_000_000);
    default:
      return 0;
  }
}

// =============================================================================
// Singleton DO Accessor
// =============================================================================

const METRICS_DO_ID = "global-metrics";

function getMetricsDO(env: Env) {
  const id = env.METRICS_DO.idFromName(METRICS_DO_ID);
  return env.METRICS_DO.get(id);
}

// =============================================================================
// Middleware Factory
// =============================================================================

/**
 * Create metrics tracking middleware for an endpoint
 *
 * @example
 * ```ts
 * app.post("/hashing/sha256", metricsMiddleware({ tier: "simple", category: "hashing" }), handler);
 * ```
 */
export function metricsMiddleware(
  options: MetricsMiddlewareOptions
): MiddlewareHandler<{ Bindings: Env; Variables: AppVariables }> {
  const { tier, category } = options;

  return async (c, next) => {
    const startTime = Date.now();

    // Execute the actual handler
    await next();

    // Only track metrics for paid requests (those with X-PAYMENT header)
    // This avoids counting 402 responses in metrics
    const paymentHeader = c.req.header("X-PAYMENT");
    if (!paymentHeader) return;

    // Calculate metrics
    const durationMs = Date.now() - startTime;
    const statusCode = c.res?.status || 500;
    const isSuccess = statusCode >= 200 && statusCode < 300;

    // Get token type
    const tokenTypeStr =
      c.req.header("X-PAYMENT-TOKEN-TYPE") || c.req.query("tokenType") || "STX";
    const tokenType = (
      ["STX", "sBTC", "USDCx"].includes(tokenTypeStr) ? tokenTypeStr : "STX"
    ) as TokenType;

    // Get endpoint path (normalized)
    const endpoint = normalizeEndpoint(c.req.routePath);

    // Get request metadata
    const requestId = c.req.header("cf-ray") || crypto.randomUUID();
    const colo = c.req.header("cf-ipcountry") ||
                 (c.req.raw as unknown as { cf?: { colo?: string } })?.cf?.colo ||
                 "UNK";

    // Get response size (approximate from content-length or 0)
    const responseBytes = parseInt(c.res?.headers.get("content-length") || "0", 10);

    // Get payer address from x402 context
    const x402Context = c.get("x402");
    const payerAddress = x402Context?.payerAddress;

    // Get model info for LLM endpoints
    const model = x402Context?.priceEstimate?.model;
    const inputTokens = x402Context?.priceEstimate?.estimatedInputTokens;
    const outputTokens = x402Context?.priceEstimate?.estimatedOutputTokens;

    // Build metrics record
    const record: MetricsRecord = {
      requestId,
      endpoint,
      category,
      method: c.req.method,
      statusCode,
      isSuccess,
      errorType: isSuccess ? undefined : classifyError(statusCode),
      pricingType: tier === "dynamic" ? "dynamic" : "fixed",
      tier: tier === "dynamic" ? undefined : tier,
      amountCharged: getAmountCharged(tier, tokenType),
      token: tokenType,
      durationMs,
      responseBytes,
      colo,
      payerAddress,
      model,
      inputTokens,
      outputTokens,
    };

    // Fire-and-forget metrics recording
    if (c.env.METRICS_DO) {
      c.executionCtx.waitUntil(
        (async () => {
          try {
            const metricsDO = getMetricsDO(c.env);
            await metricsDO.recordMetrics(record);
          } catch (error) {
            console.error("Failed to record metrics:", error);
          }
        })()
      );
    }
  };
}

// =============================================================================
// Convenience Middleware Creators
// =============================================================================

/** Metrics for simple tier endpoints */
export const metricsSimple = (category: string) =>
  metricsMiddleware({ tier: "simple", category });

/** Metrics for AI tier endpoints */
export const metricsAI = (category: string) =>
  metricsMiddleware({ tier: "ai", category });

/** Metrics for storage read endpoints */
export const metricsStorageRead = (category: string) =>
  metricsMiddleware({ tier: "storage_read", category });

/** Metrics for storage write endpoints */
export const metricsStorageWrite = (category: string) =>
  metricsMiddleware({ tier: "storage_write", category });

/** Metrics for large storage write endpoints */
export const metricsStorageWriteLarge = (category: string) =>
  metricsMiddleware({ tier: "storage_write_large", category });

/** Metrics for dynamic pricing (LLM) endpoints */
export const metricsDynamic = (category: string) =>
  metricsMiddleware({ tier: "dynamic", category });

// =============================================================================
// Dashboard Data Fetcher
// =============================================================================

/**
 * Fetch all dashboard data from MetricsDO
 */
export async function getDashboardData(env: Env) {
  const metricsDO = getMetricsDO(env);

  const [summary, endpoints, daily, colos, errors, recentRequests, modelStats] =
    await Promise.all([
      metricsDO.getSummary(),
      metricsDO.getEndpointStats(),
      metricsDO.getDailyStats(7),
      metricsDO.getColoStats(),
      metricsDO.getErrorStats(),
      metricsDO.getRecentRequests(10),
      metricsDO.getModelStats(),
    ]);

  return {
    summary,
    endpoints,
    daily,
    colos,
    errors,
    recentRequests,
    modelStats,
  };
}
