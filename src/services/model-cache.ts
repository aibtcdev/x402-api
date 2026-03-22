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
  | { valid: true; pricing?: ModelPricing; degraded?: true }
  | { valid: false; error: string };

/** Cache state reported by getCacheStatus() */
export type CacheState = "warm" | "cold" | "degraded";

/** Cache status returned by getCacheStatus() */
export interface CacheStatus {
  /** warm = populated and fresh; cold = never fetched or empty; degraded = last fetch failed */
  state: CacheState;
  /** Number of models currently in the registry */
  modelCount: number;
  /** Timestamp (ms since epoch) of the last successful fetch, or null if never fetched */
  lastRefreshed: number | null;
  /** Timestamp (ms since epoch) of the last failed fetch attempt, or null if no failures */
  lastFailedAt: number | null;
}

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

    // Belt-and-suspenders guard: Phase 1 validator inside getModels() ensures
    // .data is an array, but guard locally so cache refresh is resilient to any
    // future changes in the validator contract.
    if (!Array.isArray(modelsResponse.data)) {
      logger.warn("Model cache: modelsResponse.data is not an array — skipping cache update");
      return;
    }

    modelRegistry.clear();

    for (const model of modelsResponse.data) {
      // Guard each model's pricing individually before parseFloat().
      // A single malformed model should not abort the entire cache refresh.
      if (
        typeof model.pricing !== "object" ||
        model.pricing === null ||
        typeof model.pricing.prompt !== "string" ||
        typeof model.pricing.completion !== "string"
      ) {
        logger.debug("Model cache: skipping model with invalid pricing", { modelId: model.id });
        continue;
      }

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
 * Returns the current cache state without triggering a refresh.
 *
 * States:
 *   "warm"     — registry populated and TTL not expired
 *   "cold"     — never fetched successfully (fetchedAt is null) or registry is empty with no prior failure
 *   "degraded" — last fetch attempt failed and registry may be empty or stale
 */
export function getCacheStatus(): CacheStatus {
  const modelCount = modelRegistry.size;

  let state: CacheState;

  if (lastFailedAt !== null && (modelCount === 0 || (fetchedAt !== null && Date.now() - fetchedAt > CACHE_TTL_MS))) {
    state = "degraded";
  } else if (fetchedAt !== null && modelCount > 0 && Date.now() - fetchedAt <= CACHE_TTL_MS) {
    state = "warm";
  } else {
    state = "cold";
  }

  return {
    state,
    modelCount,
    lastRefreshed: fetchedAt,
    lastFailedAt,
  };
}

/**
 * Find model IDs in the registry that are similar to the given model ID.
 *
 * Similarity strategy:
 *   1. If modelId contains "/", try to match other models with the same provider prefix.
 *   2. If no prefix matches found, fall back to lexicographic prefix match on the full ID.
 *   3. Returns at most maxResults results.
 */
export function getSimilarModels(modelId: string, maxResults = 3): string[] {
  if (modelRegistry.size === 0) {
    return [];
  }

  const allModels = Array.from(modelRegistry.keys()).sort();

  // Try provider prefix match (e.g., "openai/" from "openai/gpt-4o")
  const slashIdx = modelId.indexOf("/");
  if (slashIdx !== -1) {
    const providerPrefix = modelId.slice(0, slashIdx + 1);
    const providerMatches = allModels.filter(
      (id) => id.startsWith(providerPrefix) && id !== modelId
    );
    if (providerMatches.length > 0) {
      return providerMatches.slice(0, maxResults);
    }
  }

  // Fall back: full-string prefix match (e.g., "gpt" matches "gpt-4")
  const prefixLen = Math.max(3, Math.floor(modelId.length / 2));
  const prefix = modelId.slice(0, prefixLen).toLowerCase();
  const prefixMatches = allModels.filter(
    (id) => id.toLowerCase().startsWith(prefix) && id !== modelId
  );
  if (prefixMatches.length > 0) {
    return prefixMatches.slice(0, maxResults);
  }

  // No structural match — return first maxResults models as fallback hints
  return allModels.filter((id) => id !== modelId).slice(0, maxResults);
}

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

  // If the cache is still empty (e.g., fetch failed), be permissive but signal degraded state
  if (modelRegistry.size === 0) {
    logger.debug("Model cache empty after refresh attempt -- allowing request (degraded)", { modelId });
    return { valid: true, degraded: true };
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
