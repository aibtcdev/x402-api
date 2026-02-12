/**
 * X402 Schema Generator
 *
 * Generates x402.json format for StacksX402 scanner discovery.
 * Static generation without network calls (Cloudflare Workers can't self-fetch).
 *
 * V2 format includes Bazaar-compatible metadata with:
 * - Full input/output examples
 * - JSON schemas per endpoint
 * - Rich discovery metadata from the registry
 */

import { TIER_PRICING, stxToTokenAmount } from "../services/pricing";
import type { PricingTier, TokenType } from "../types";
import { getEndpointMetadata } from "../bazaar";
import type { EndpointMetadata } from "../bazaar";

// =============================================================================
// Types
// =============================================================================

export interface X402Entry {
  scheme: "exact";
  network: "stacks";
  asset: TokenType;
  payTo: string;
  maxAmountRequired: string;
  maxTimeoutSeconds: number;
  resource: string;
  description: string;
  mimeType: "application/json";
  outputSchema: {
    input: X402InputSchema;
    output: X402OutputSchema;
  };
}

export interface X402InputSchema {
  type: "http";
  method: "GET" | "POST" | "DELETE";
  bodyType?: "json" | "form" | "text" | "binary";
  bodySchema?: Record<string, unknown>; // Full JSON Schema
  queryParams?: Record<string, unknown>; // Query parameter schema
}

export interface X402OutputSchema {
  type: "json";
  example: Record<string, unknown>; // Realistic output example
  schema?: Record<string, unknown>; // Full JSON Schema (optional)
}

export interface X402Schema {
  x402Version: 2; // V2 includes Bazaar metadata
  name: string;
  image: string;
  accepts: X402Entry[];
}

export interface GeneratorConfig {
  network: "mainnet" | "testnet";
  payTo: string;
  name?: string;
  image?: string;
}

// =============================================================================
// Endpoint Registry (for static generation without OpenAPI fetch)
// =============================================================================

interface EndpointInfo {
  path: string;
  method: "GET" | "POST" | "DELETE";
  description: string;
  tier: PricingTier;
}

// Array format allows multiple methods per path
const ENDPOINT_REGISTRY: EndpointInfo[] = [
  // Inference - OpenRouter (dynamic pricing, use standard as placeholder)
  { path: "/inference/openrouter/chat", method: "POST", description: "Chat completion via OpenRouter (100+ models)", tier: "dynamic" },

  // Inference - Cloudflare
  { path: "/inference/cloudflare/chat", method: "POST", description: "Chat completion via Cloudflare AI", tier: "standard" },

  // Stacks endpoints
  { path: "/stacks/address/:address", method: "GET", description: "Convert between Stacks address formats", tier: "standard" },
  { path: "/stacks/decode/clarity", method: "POST", description: "Decode Clarity value from hex", tier: "standard" },
  { path: "/stacks/decode/transaction", method: "POST", description: "Decode raw Stacks transaction", tier: "standard" },
  { path: "/stacks/profile/:address", method: "GET", description: "Get BNS profile for address", tier: "standard" },
  { path: "/stacks/verify/message", method: "POST", description: "Verify signed message", tier: "standard" },
  { path: "/stacks/verify/sip018", method: "POST", description: "Verify SIP-018 structured data signature", tier: "standard" },

  // Hashing endpoints
  { path: "/hashing/sha256", method: "POST", description: "SHA256 hash (Clarity-compatible)", tier: "standard" },
  { path: "/hashing/sha512", method: "POST", description: "SHA512 hash", tier: "standard" },
  { path: "/hashing/sha512-256", method: "POST", description: "SHA512/256 hash (Clarity-compatible)", tier: "standard" },
  { path: "/hashing/keccak256", method: "POST", description: "Keccak256 hash (Clarity-compatible)", tier: "standard" },
  { path: "/hashing/hash160", method: "POST", description: "Hash160 (SHA256 + RIPEMD160, Clarity-compatible)", tier: "standard" },
  { path: "/hashing/ripemd160", method: "POST", description: "RIPEMD160 hash", tier: "standard" },

  // Storage - KV (same path, different methods)
  { path: "/storage/kv/:key", method: "GET", description: "Get value by key", tier: "standard" },
  { path: "/storage/kv", method: "POST", description: "Set key-value pair", tier: "standard" },
  { path: "/storage/kv/:key", method: "DELETE", description: "Delete key", tier: "standard" },
  { path: "/storage/kv", method: "GET", description: "List all keys", tier: "standard" },

  // Storage - Paste (same path, different methods)
  { path: "/storage/paste", method: "POST", description: "Create paste", tier: "standard" },
  { path: "/storage/paste/:id", method: "GET", description: "Get paste by ID", tier: "standard" },
  { path: "/storage/paste/:id", method: "DELETE", description: "Delete paste", tier: "standard" },

  // Storage - DB
  { path: "/storage/db/query", method: "POST", description: "Execute SQL query", tier: "standard" },
  { path: "/storage/db/execute", method: "POST", description: "Execute SQL statement", tier: "standard" },
  { path: "/storage/db/schema", method: "GET", description: "Get database schema", tier: "standard" },

  // Storage - Sync (Locks)
  { path: "/storage/sync/lock", method: "POST", description: "Acquire distributed lock", tier: "standard" },
  { path: "/storage/sync/unlock", method: "POST", description: "Release distributed lock", tier: "standard" },
  { path: "/storage/sync/extend", method: "POST", description: "Extend lock TTL", tier: "standard" },
  { path: "/storage/sync/status/:name", method: "GET", description: "Get lock status", tier: "standard" },
  { path: "/storage/sync/list", method: "GET", description: "List all locks", tier: "standard" },

  // Storage - Queue
  { path: "/storage/queue/push", method: "POST", description: "Push job to queue", tier: "standard" },
  { path: "/storage/queue/pop", method: "POST", description: "Pop job from queue", tier: "standard" },
  { path: "/storage/queue/peek", method: "GET", description: "Peek at next job", tier: "standard" },
  { path: "/storage/queue/status", method: "GET", description: "Get queue status", tier: "standard" },
  { path: "/storage/queue/clear", method: "POST", description: "Clear queue", tier: "standard" },

  // Storage - Memory (Vector)
  { path: "/storage/memory/store", method: "POST", description: "Store memory with embedding", tier: "standard" },
  { path: "/storage/memory/search", method: "POST", description: "Semantic search memories", tier: "standard" },
  { path: "/storage/memory/delete", method: "POST", description: "Delete memory", tier: "standard" },
  { path: "/storage/memory/list", method: "GET", description: "List all memories", tier: "standard" },
  { path: "/storage/memory/clear", method: "POST", description: "Clear all memories", tier: "standard" },
];

// =============================================================================
// Conversion Helpers
// =============================================================================

const TOKENS: TokenType[] = ["STX", "sBTC", "USDCx"];

/**
 * Get timeout based on endpoint type
 */
function getTimeoutForTier(tier: PricingTier): number {
  switch (tier) {
    case "dynamic":
      return 120; // LLM requests can take longer
    default:
      return 60;
  }
}

/**
 * Get amount in smallest unit for a tier and token
 */
function getAmountForTier(tier: PricingTier, token: TokenType): string {
  // Skip free tier
  if (tier === "free") return "0";

  // For dynamic pricing, use standard tier as the base (actual price varies)
  const effectiveTier = tier === "dynamic" ? "standard" : tier;
  const tierPricing = TIER_PRICING[effectiveTier];

  if (!tierPricing || tierPricing.stx === 0) return "0";

  const amount = stxToTokenAmount(tierPricing.stx, token);
  return amount.toString();
}

// =============================================================================
// Main Generator
// =============================================================================

/**
 * Build rich input/output schema from Bazaar metadata
 */
function buildOutputSchema(
  basicInfo: EndpointInfo,
  metadata?: EndpointMetadata
): { input: X402InputSchema; output: X402OutputSchema } {
  // Build input schema
  const input: X402InputSchema = {
    type: "http",
    method: basicInfo.method,
  };

  // Add rich metadata if available
  if (metadata) {
    if (metadata.bodyType) {
      input.bodyType = metadata.bodyType;
    }
    if (metadata.bodySchema) {
      input.bodySchema = metadata.bodySchema;
    }
    if (metadata.queryParams) {
      input.queryParams = metadata.queryParams;
    }
  }

  // Build output schema
  const output: X402OutputSchema = {
    type: "json",
    example: metadata?.outputExample || {},
  };

  // Add output schema if available
  if (metadata?.outputSchema) {
    output.schema = metadata.outputSchema;
  }

  return { input, output };
}

/**
 * Normalize path from basic registry to Bazaar pattern format
 * e.g., "/stacks/address/:address" -> "/stacks/address/{address}"
 */
function normalizePath(path: string): string {
  return path.replace(/:([^/]+)/g, "{$1}");
}

/**
 * Generate x402.json schema statically (v2 format with Bazaar metadata)
 * Uses hardcoded endpoint registry + Bazaar registry - no network calls needed
 */
export function generateX402Schema(config: GeneratorConfig): X402Schema {
  const accepts: X402Entry[] = [];

  // Process each paid endpoint
  for (const info of ENDPOINT_REGISTRY) {
    // Skip free tier
    if (info.tier === "free") continue;

    const timeout = getTimeoutForTier(info.tier);

    // Normalize path and lookup in Bazaar registry for rich metadata
    const normalizedPath = normalizePath(info.path);
    const metadata = getEndpointMetadata(normalizedPath, info.method);

    // Create entry for each supported token
    for (const token of TOKENS) {
      const amount = getAmountForTier(info.tier, token);

      // Skip if amount is 0
      if (amount === "0") continue;

      accepts.push({
        scheme: "exact",
        network: "stacks",
        asset: token,
        payTo: config.payTo,
        maxAmountRequired: amount,
        maxTimeoutSeconds: timeout,
        resource: normalizedPath,
        description: info.description,
        mimeType: "application/json",
        outputSchema: buildOutputSchema(info, metadata),
      });
    }
  }

  return {
    x402Version: 2,
    name: config.name || "x402 Stacks API",
    image: config.image || "https://aibtc.dev/logos/aibtcdev-avatar-1000px.png",
    accepts,
  };
}
