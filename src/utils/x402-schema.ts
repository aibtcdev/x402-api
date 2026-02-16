/**
 * X402 Manifest Generator (V2 Protocol)
 *
 * Generates x402.json discovery manifest for Bazaar/scanner registration.
 * Static generation without network calls (Cloudflare Workers can't self-fetch).
 *
 * V2 manifest format (per x402-specification-v2.md section 8):
 * - CAIP-2 network identifiers (e.g., "stacks:1", "stacks:2147483648")
 * - Per-endpoint grouping with resource objects
 * - Bazaar extensions for rich metadata
 * - Service metadata wrapper
 */

import { TIER_PRICING, stxToTokenAmount } from "../services/pricing";
import type { PricingTier, TokenType } from "../types";
import { getEndpointMetadata, buildBazaarExtension } from "../bazaar";
import type { EndpointMetadata, BazaarExtension } from "../bazaar";

// =============================================================================
// V2 Manifest Types
// =============================================================================

/**
 * V2 payment requirements (per-token accept entry)
 */
export interface V2PaymentRequirements {
  scheme: "exact";
  network: string; // CAIP-2 format: "stacks:1" or "stacks:2147483648"
  amount: string; // Required payment amount in atomic units
  asset: TokenType;
  payTo: string;
  maxTimeoutSeconds: number;
  extra?: Record<string, unknown>;
}

/**
 * V2 manifest entry (per-endpoint grouping)
 */
export interface V2ManifestEntry {
  resource: string; // Full URL: "https://api.example.com/path"
  type: "http";
  x402Version: 2;
  accepts: V2PaymentRequirements[];
  lastUpdated: number; // Unix timestamp
  metadata: {
    service?: {
      name: string;
      url: string;
    };
    category?: string;
  };
  extensions?: {
    bazaar?: BazaarExtension;
  };
}

/**
 * V2 manifest (discovery response)
 */
export interface V2Manifest {
  x402Version: 2;
  items: V2ManifestEntry[];
}

/**
 * Generator configuration
 */
export interface GeneratorConfig {
  network: "mainnet" | "testnet";
  payTo: string;
  baseUrl: string; // e.g., "https://x402.aibtc.dev"
  serviceName?: string;
  serviceUrl?: string;
}

// Legacy types retained for Bazaar extension compatibility
export interface X402InputSchema {
  type: "http";
  method: "GET" | "POST" | "DELETE";
  bodyType?: "json" | "form" | "text" | "binary";
  bodySchema?: Record<string, unknown>;
  queryParams?: Record<string, unknown>;
}

export interface X402OutputSchema {
  type: "json";
  example: Record<string, unknown>;
  schema?: Record<string, unknown>;
}

// =============================================================================
// Endpoint Registry (derived from OpenAPI routes)
// =============================================================================

interface EndpointInfo {
  path: string;
  method: "GET" | "POST" | "DELETE";
  description: string;
  tier: PricingTier;
}

/**
 * Static endpoint registry for x402.json generation.
 * Includes method and description metadata not present in ENDPOINT_CONFIG.
 *
 * Note: This is the minimal registry needed for x402 discovery.
 * For pricing/category info, see ENDPOINT_CONFIG in src/index.ts.
 */
const ENDPOINT_REGISTRY: EndpointInfo[] = [
  // Inference
  { path: "/inference/openrouter/chat", method: "POST", description: "Chat completion via OpenRouter (100+ models)", tier: "dynamic" },
  { path: "/inference/cloudflare/chat", method: "POST", description: "Chat completion via Cloudflare AI", tier: "standard" },

  // Stacks
  { path: "/stacks/address/:address", method: "GET", description: "Convert between Stacks address formats", tier: "standard" },
  { path: "/stacks/decode/clarity", method: "POST", description: "Decode Clarity value from hex", tier: "standard" },
  { path: "/stacks/decode/transaction", method: "POST", description: "Decode raw Stacks transaction", tier: "standard" },
  { path: "/stacks/profile/:address", method: "GET", description: "Get BNS profile for address", tier: "standard" },
  { path: "/stacks/verify/message", method: "POST", description: "Verify signed message", tier: "standard" },
  { path: "/stacks/verify/sip018", method: "POST", description: "Verify SIP-018 structured data signature", tier: "standard" },

  // Hashing
  { path: "/hashing/sha256", method: "POST", description: "SHA256 hash (Clarity-compatible)", tier: "standard" },
  { path: "/hashing/sha512", method: "POST", description: "SHA512 hash", tier: "standard" },
  { path: "/hashing/sha512-256", method: "POST", description: "SHA512/256 hash (Clarity-compatible)", tier: "standard" },
  { path: "/hashing/keccak256", method: "POST", description: "Keccak256 hash (Clarity-compatible)", tier: "standard" },
  { path: "/hashing/hash160", method: "POST", description: "Hash160 (SHA256 + RIPEMD160, Clarity-compatible)", tier: "standard" },
  { path: "/hashing/ripemd160", method: "POST", description: "RIPEMD160 hash", tier: "standard" },

  // Storage - KV
  { path: "/storage/kv/:key", method: "GET", description: "Get value by key", tier: "standard" },
  { path: "/storage/kv", method: "POST", description: "Set key-value pair", tier: "standard" },
  { path: "/storage/kv/:key", method: "DELETE", description: "Delete key", tier: "standard" },
  { path: "/storage/kv", method: "GET", description: "List all keys", tier: "standard" },

  // Storage - Paste
  { path: "/storage/paste", method: "POST", description: "Create paste", tier: "standard" },
  { path: "/storage/paste/:id", method: "GET", description: "Get paste by ID", tier: "standard" },
  { path: "/storage/paste/:id", method: "DELETE", description: "Delete paste", tier: "standard" },

  // Storage - DB
  { path: "/storage/db/query", method: "POST", description: "Execute SQL query", tier: "standard" },
  { path: "/storage/db/execute", method: "POST", description: "Execute SQL statement", tier: "standard" },
  { path: "/storage/db/schema", method: "GET", description: "Get database schema", tier: "standard" },

  // Storage - Sync
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

  // Storage - Memory
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
 * Convert network to CAIP-2 format
 * @see https://github.com/ChainAgnostic/CAIPs/blob/main/CAIPs/caip-2.md
 */
function getCAIP2Network(network: "mainnet" | "testnet"): string {
  return network === "mainnet" ? "stacks:1" : "stacks:2147483648";
}

/**
 * Normalize path from basic registry to Bazaar pattern format
 * e.g., "/stacks/address/:address" -> "/stacks/address/{address}"
 */
function normalizePath(path: string): string {
  return path.replace(/:([^/]+)/g, "{$1}");
}

/**
 * Generate V2 x402 discovery manifest
 *
 * Produces per-endpoint grouped manifest with CAIP-2 network IDs, resource objects,
 * service metadata, and Bazaar extensions.
 *
 * @param config - Generator configuration including baseUrl, payTo, network
 * @returns V2Manifest with items array (per-endpoint grouping)
 */
export function generateX402Manifest(config: GeneratorConfig): V2Manifest {
  const items: V2ManifestEntry[] = [];
  const caip2Network = getCAIP2Network(config.network);
  const timestamp = Math.floor(Date.now() / 1000);

  // Process each paid endpoint
  for (const info of ENDPOINT_REGISTRY) {
    // Skip free tier
    if (info.tier === "free") continue;

    const accepts: V2PaymentRequirements[] = [];
    const normalizedPath = normalizePath(info.path);
    const resourceUrl = `${config.baseUrl}${normalizedPath}`;
    const timeout = getTimeoutForTier(info.tier);

    // Create payment requirement for each supported token
    for (const token of TOKENS) {
      const amount = getAmountForTier(info.tier, token);

      // Skip if amount is 0
      if (amount === "0") continue;

      accepts.push({
        scheme: "exact",
        network: caip2Network,
        amount,
        asset: token,
        payTo: config.payTo,
        maxTimeoutSeconds: timeout,
      });
    }

    // Skip endpoint if no valid payment options
    if (accepts.length === 0) continue;

    // Lookup Bazaar metadata for rich discovery
    const metadata = getEndpointMetadata(normalizedPath, info.method);

    // Build manifest entry
    items.push({
      resource: resourceUrl,
      type: "http",
      x402Version: 2,
      accepts,
      lastUpdated: timestamp,
      metadata: {
        service: {
          name: config.serviceName || "x402 Stacks API",
          url: config.serviceUrl || config.baseUrl,
        },
        ...(metadata?.category && { category: metadata.category }),
      },
      ...(metadata && { extensions: { bazaar: buildBazaarExtension(metadata) } }),
    });
  }

  return {
    x402Version: 2,
    items,
  };
}
