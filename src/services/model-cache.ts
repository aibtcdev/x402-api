/**
 * Model Cache Service
 *
 * Isolate-scoped opportunistic cache -- resets on deploy/recycle.
 * Provides cached model lookups from the OpenRouter API to avoid
 * redundant fetches and to enable pre-payment model validation.
 */

import type { Logger } from "../types";
import type { ModelPricing } from "./pricing";
import { OpenRouterClient } from "./openrouter";

// =============================================================================
// Constants
// =============================================================================

/** Cache TTL: 1 hour in milliseconds */
const CACHE_TTL_MS = 60 * 60 * 1000;

/** Fetch timeout: 3 seconds so cold starts don't block requests */
const FETCH_TIMEOUT_MS = 3_000;

// =============================================================================
// Types
// =============================================================================

/** Discriminated union result from lookupModel */
export type ModelLookupResult =
  | { valid: true; pricing?: ModelPricing }
  | { valid: false; error: string };

// =============================================================================
// Module-level Cache
// =============================================================================

/** Module-level model registry -- isolate-scoped, resets on deploy/recycle */
const modelRegistry = new Map<string, ModelPricing>();

/** Timestamp of the last successful fetch */
let fetchedAt: number | null = null;

/** Timestamp of the last failed fetch attempt (backoff: don't retry every request) */
let lastFailedAt: number | null = null;

/** Minimum interval between retry attempts after a failure */
const RETRY_BACKOFF_MS = 30_000;

/** Shared in-flight refresh promise to collapse concurrent callers */
let inflightRefresh: Promise<void> | null = null;

// =============================================================================
// Cache Management
// =============================================================================

/**
 * Returns true if the cache is empty or the TTL has expired.
 */
function isCacheStale(): boolean {
  if (fetchedAt === null || modelRegistry.size === 0) {
    // If we recently failed, back off instead of retrying every request
    if (lastFailedAt !== null && Date.now() - lastFailedAt < RETRY_BACKOFF_MS) {
      return false;
    }
    return true;
  }
  return Date.now() - fetchedAt > CACHE_TTL_MS;
}

/**
 * Populate the module-level registry from an OpenRouter models fetch.
 * Converts per-token USD strings to per-1K numbers.
 * Silently no-ops on error; callers fall back to hardcoded pricing.
 */
async function refreshCache(apiKey: string, logger: Logger): Promise<void> {
  // Collapse concurrent callers into a single in-flight fetch
  if (inflightRefresh) {
    return inflightRefresh;
  }

  inflightRefresh = doRefresh(apiKey, logger);
  try {
    await inflightRefresh;
  } finally {
    inflightRefresh = null;
  }
}

async function doRefresh(apiKey: string, logger: Logger): Promise<void> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    const client = new OpenRouterClient(apiKey, logger);
    const modelsResponse = await client.getModels(controller.signal);

    modelRegistry.clear();

    for (const model of modelsResponse.data) {
      // OpenRouter returns per-token prices as strings (e.g., "0.000003")
      // Convert to per-1K numbers
      const promptPer1k = parseFloat(model.pricing.prompt) * 1000;
      const completionPer1k = parseFloat(model.pricing.completion) * 1000;

      // Skip models with non-numeric or negative pricing
      if (!isFinite(promptPer1k) || !isFinite(completionPer1k) || promptPer1k < 0 || completionPer1k < 0) {
        continue;
      }

      modelRegistry.set(model.id, { promptPer1k, completionPer1k });
    }

    fetchedAt = Date.now();
    lastFailedAt = null;
    logger.debug("Model cache refreshed", { count: modelRegistry.size });
  } catch (err) {
    lastFailedAt = Date.now();
    // Non-fatal: caller falls back to hardcoded pricing
    logger.warn("Model cache refresh failed -- using fallback pricing", {
      error: err instanceof Error ? err.message : String(err),
    });
  } finally {
    clearTimeout(timeout);
  }
}

// =============================================================================
// Public API
// =============================================================================

/**
 * Look up a model by ID, refreshing the cache if stale.
 *
 * Returns a discriminated union:
 *   { valid: true, pricing? }  -- model found (or fetch failed, fall back to hardcoded)
 *   { valid: false, error }    -- model definitively not in the registry
 *
 * On fetch failure or timeout the function returns `{ valid: true }` with no
 * pricing so the caller can fall back to hardcoded MODEL_PRICING.
 */
export async function lookupModel(
  modelId: string,
  apiKey: string,
  logger: Logger
): Promise<ModelLookupResult> {
  // Refresh the cache if needed
  if (isCacheStale()) {
    await refreshCache(apiKey, logger);
  }

  // If the cache is still empty (e.g., fetch failed), be permissive
  if (modelRegistry.size === 0) {
    logger.debug("Model cache empty after refresh attempt -- allowing request", { modelId });
    return { valid: true };
  }

  const cached = modelRegistry.get(modelId);

  if (!cached) {
    return {
      valid: false,
      error: `Model "${modelId}" not found in OpenRouter model registry`,
    };
  }

  return { valid: true, pricing: cached };
}
