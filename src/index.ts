/**
 * x402 Stacks API Host
 *
 * Cloudflare Worker exposing APIs on a pay-per-use basis using the x402 protocol.
 * Supports STX, sBTC, and USDCx payments via Stacks blockchain.
 */

import { fromHono } from "chanfana";
import { Hono } from "hono";
import { cors } from "hono/cors";
import type { Env, AppContext, AppVariables, TokenType, PricingTier } from "./types";
import type { MetricsRecord } from "./durable-objects/MetricsDO";
import { TIER_PRICING } from "./services/pricing";

// Note: x402 middleware is applied via endpoint base classes (SimpleEndpoint, AIEndpoint, etc.)
// Direct middleware imports available if needed: x402Simple, x402AI, x402StorageRead, etc.

// Inference endpoints
import { OpenRouterListModels, OpenRouterChat } from "./endpoints/inference/openrouter";
import { CloudflareListModels, CloudflareChat } from "./endpoints/inference/cloudflare";

// Stacks endpoints
import {
  AddressConvert,
  DecodeClarity,
  DecodeTransaction,
  Profile,
  VerifyMessage,
  VerifySIP018,
} from "./endpoints/stacks";

// Hashing endpoints
import {
  HashSha256,
  HashSha512,
  HashSha512_256,
  HashKeccak256,
  HashHash160,
  HashRipemd160,
} from "./endpoints/hashing";

// Storage endpoints
import {
  KvGet,
  KvSet,
  KvDelete,
  KvList,
  PasteCreate,
  PasteGet,
  PasteDelete,
  DbQuery,
  DbExecute,
  DbSchema,
  SyncLock,
  SyncUnlock,
  SyncExtend,
  SyncStatus,
  SyncList,
  QueuePush,
  QueuePop,
  QueuePeek,
  QueueStatus,
  QueueClear,
  MemoryStore,
  MemorySearch,
  MemoryDelete,
  MemoryList,
  MemoryClear,
} from "./endpoints/storage";

// Dashboard endpoint
import { Dashboard } from "./endpoints/dashboard";

// Durable Objects
export { UsageDO } from "./durable-objects/UsageDO";
export { StorageDO } from "./durable-objects/StorageDO";
export { MetricsDO } from "./durable-objects/MetricsDO";

// =============================================================================
// Hono App
// =============================================================================

const app = new Hono<{ Bindings: Env; Variables: AppVariables }>();

// CORS middleware
app.use(
  "*",
  cors({
    origin: "*",
    allowMethods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allowHeaders: [
      "X-PAYMENT",
      "X-PAYMENT-TOKEN-TYPE",
      "Authorization",
      "Content-Type",
    ],
    exposeHeaders: ["X-PAYMENT-RESPONSE", "X-PAYER-ADDRESS", "X-Request-ID"],
  })
);

// =============================================================================
// Global Metrics Middleware
// =============================================================================

// Endpoint to tier/category mapping for metrics
const ENDPOINT_CONFIG: Record<string, { tier: PricingTier; category: string }> = {
  // Inference
  "/inference/openrouter/chat": { tier: "dynamic", category: "inference" },
  "/inference/cloudflare/chat": { tier: "ai", category: "inference" },
  // Stacks
  "/stacks/address": { tier: "simple", category: "stacks" },
  "/stacks/decode/clarity": { tier: "simple", category: "stacks" },
  "/stacks/decode/transaction": { tier: "simple", category: "stacks" },
  "/stacks/profile": { tier: "simple", category: "stacks" },
  "/stacks/verify/message": { tier: "simple", category: "stacks" },
  "/stacks/verify/sip018": { tier: "simple", category: "stacks" },
  // Hashing
  "/hashing/sha256": { tier: "simple", category: "hashing" },
  "/hashing/sha512": { tier: "simple", category: "hashing" },
  "/hashing/sha512-256": { tier: "simple", category: "hashing" },
  "/hashing/keccak256": { tier: "simple", category: "hashing" },
  "/hashing/hash160": { tier: "simple", category: "hashing" },
  "/hashing/ripemd160": { tier: "simple", category: "hashing" },
  // Storage - KV
  "/storage/kv": { tier: "storage_read", category: "storage" },
  // Storage - Paste
  "/storage/paste": { tier: "storage_write", category: "storage" },
  // Storage - DB
  "/storage/db/query": { tier: "storage_read", category: "storage" },
  "/storage/db/execute": { tier: "storage_write", category: "storage" },
  "/storage/db/schema": { tier: "storage_read", category: "storage" },
  // Storage - Sync
  "/storage/sync/lock": { tier: "storage_write", category: "storage" },
  "/storage/sync/unlock": { tier: "storage_write", category: "storage" },
  "/storage/sync/extend": { tier: "storage_write", category: "storage" },
  "/storage/sync/status": { tier: "storage_read", category: "storage" },
  "/storage/sync/list": { tier: "storage_read", category: "storage" },
  // Storage - Queue
  "/storage/queue/push": { tier: "storage_write", category: "storage" },
  "/storage/queue/pop": { tier: "storage_write", category: "storage" },
  "/storage/queue/peek": { tier: "storage_read", category: "storage" },
  "/storage/queue/status": { tier: "storage_read", category: "storage" },
  "/storage/queue/clear": { tier: "storage_write", category: "storage" },
  // Storage - Memory
  "/storage/memory/store": { tier: "storage_write_large", category: "storage" },
  "/storage/memory/search": { tier: "storage_read", category: "storage" },
  "/storage/memory/delete": { tier: "storage_write", category: "storage" },
  "/storage/memory/list": { tier: "storage_read", category: "storage" },
  "/storage/memory/clear": { tier: "storage_write", category: "storage" },
};

function normalizeEndpoint(path: string): string {
  // Remove path parameters: /stacks/profile/SP123 -> /stacks/profile
  return path.replace(/\/[A-Za-z0-9]+$/, "").replace(/\/:[^/]+/g, "");
}

function getEndpointConfig(path: string): { tier: PricingTier; category: string } {
  const normalized = normalizeEndpoint(path);

  // Try exact match first
  if (ENDPOINT_CONFIG[normalized]) {
    return ENDPOINT_CONFIG[normalized];
  }

  // Try prefix match
  for (const [key, config] of Object.entries(ENDPOINT_CONFIG)) {
    if (normalized.startsWith(key)) {
      return config;
    }
  }

  // Default
  return { tier: "simple", category: "other" };
}

function getAmountCharged(tier: PricingTier, tokenType: TokenType): number {
  const pricing = TIER_PRICING[tier];
  if (!pricing) return 0;

  switch (tokenType) {
    case "STX":
      return Math.round(pricing.stx * 1_000_000);
    case "sBTC":
      return Math.round(pricing.stx * 100_000_000 * 0.00005);
    case "USDCx":
      return Math.round(pricing.usd * 1_000_000);
    default:
      return 0;
  }
}

function classifyError(statusCode: number): string {
  if (statusCode >= 500) return "server_error";
  if (statusCode === 402) return "payment_required";
  if (statusCode === 401 || statusCode === 403) return "auth_error";
  if (statusCode === 404) return "not_found";
  if (statusCode === 429) return "rate_limited";
  if (statusCode >= 400) return "client_error";
  return "unknown";
}

// Global metrics tracking middleware
app.use("*", async (c, next) => {
  const startTime = Date.now();

  await next();

  // Only track metrics for paid requests
  const paymentHeader = c.req.header("X-PAYMENT");
  if (!paymentHeader) return;

  // Skip metrics for free endpoints
  const path = c.req.path;
  if (path === "/" || path === "/health" || path === "/docs" || path === "/dashboard") {
    return;
  }

  const durationMs = Date.now() - startTime;
  const statusCode = c.res?.status || 500;
  const isSuccess = statusCode >= 200 && statusCode < 300;

  const tokenTypeStr = c.req.header("X-PAYMENT-TOKEN-TYPE") || c.req.query("tokenType") || "STX";
  const tokenType = (["STX", "sBTC", "USDCx"].includes(tokenTypeStr) ? tokenTypeStr : "STX") as TokenType;

  const endpoint = normalizeEndpoint(c.req.routePath || path);
  const { tier, category } = getEndpointConfig(endpoint);

  const requestId = c.req.header("cf-ray") || crypto.randomUUID();
  const cfData = (c.req.raw as unknown as { cf?: { colo?: string } })?.cf;
  const colo = cfData?.colo || "UNK";

  const responseBytes = parseInt(c.res?.headers.get("content-length") || "0", 10);

  const x402Context = c.get("x402");
  const payerAddress = x402Context?.payerAddress;
  const model = x402Context?.priceEstimate?.model;
  const inputTokens = x402Context?.priceEstimate?.estimatedInputTokens;
  const outputTokens = x402Context?.priceEstimate?.estimatedOutputTokens;

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
          const id = c.env.METRICS_DO.idFromName("global-metrics");
          const metricsDO = c.env.METRICS_DO.get(id);
          await metricsDO.recordMetrics(record);
        } catch (error) {
          console.error("Failed to record metrics:", error);
        }
      })()
    );
  }
});

// =============================================================================
// chanfana OpenAPI Registry
// =============================================================================

const openapi = fromHono(app, {
  docs_url: "/docs",
  schema: {
    info: {
      title: "x402 Stacks API",
      version: "1.0.0",
      description: `
Pay-per-use API powered by x402 protocol on Stacks blockchain.

## Payment
All paid endpoints require an \`X-PAYMENT\` header with a signed Stacks transaction.
Optionally specify token via \`X-PAYMENT-TOKEN-TYPE\` (STX, sBTC, USDCx).

## Pricing Tiers
| Tier | STX | Description |
|------|-----|-------------|
| free | 0 | No payment required |
| simple | 0.001 | Basic compute (hashing, conversion) |
| ai | 0.003 | AI-enhanced operations |
| storage_read | 0.001 | Read from storage |
| storage_write | 0.002 | Write to storage |
| storage_write_large | 0.005 | Large writes (embeddings) |
| dynamic | varies | LLM costs + 20% margin |
      `.trim(),
    },
    tags: [
      { name: "Info", description: "Service information" },
      { name: "Inference - OpenRouter", description: "OpenRouter LLM API (100+ models)" },
      { name: "Inference - Cloudflare", description: "Cloudflare AI models" },
      { name: "Stacks", description: "Stacks blockchain utilities" },
      { name: "Hashing", description: "Clarity-compatible hashing functions" },
      { name: "Storage - KV", description: "Key-value storage" },
      { name: "Storage - Paste", description: "Text paste bin" },
      { name: "Storage - DB", description: "SQL database" },
      { name: "Storage - Sync", description: "Distributed locks" },
      { name: "Storage - Queue", description: "Job queue" },
      { name: "Storage - Memory", description: "Vector memory with embeddings" },
    ],
    servers: [
      { url: "https://x402.aibtc.com", description: "Production (mainnet)" },
      { url: "https://x402.aibtc.dev", description: "Staging (testnet)" },
    ],
  },
});

// =============================================================================
// Info Endpoints
// =============================================================================

app.get("/", (c) => {
  return c.json({
    service: "x402-stacks-api",
    version: "1.0.0",
    description: "Pay-per-use API powered by x402 protocol on Stacks blockchain",
    docs: "/docs",
    categories: {
      inference: "/inference/* - LLM chat completions",
      stacks: "/stacks/* - Blockchain utilities",
      hashing: "/hashing/* - Clarity-compatible hashing",
      storage: "/storage/* - Stateful operations (KV, paste, DB, sync, queue, memory)",
    },
    payment: {
      tokens: ["STX", "sBTC", "USDCx"],
      header: "X-PAYMENT",
      tokenTypeHeader: "X-PAYMENT-TOKEN-TYPE",
    },
  });
});

app.get("/health", (c) => {
  return c.json({
    status: "ok",
    environment: c.env.ENVIRONMENT,
    timestamp: new Date().toISOString(),
  });
});

// Dashboard (free, HTML)
openapi.get("/dashboard", Dashboard);

// =============================================================================
// Inference Routes
// =============================================================================

// OpenRouter (free list, dynamic chat)
openapi.get("/inference/openrouter/models", OpenRouterListModels);
openapi.post("/inference/openrouter/chat", OpenRouterChat);

// Cloudflare AI (free list, ai tier chat)
openapi.get("/inference/cloudflare/models", CloudflareListModels);
openapi.post("/inference/cloudflare/chat", CloudflareChat);

// =============================================================================
// Stacks Routes (simple tier)
// =============================================================================

openapi.get("/stacks/address/:address", AddressConvert);
openapi.post("/stacks/decode/clarity", DecodeClarity);
openapi.post("/stacks/decode/transaction", DecodeTransaction);
openapi.get("/stacks/profile/:address", Profile);
openapi.post("/stacks/verify/message", VerifyMessage);
openapi.post("/stacks/verify/sip018", VerifySIP018);

// =============================================================================
// Hashing Routes (simple tier)
// =============================================================================

openapi.post("/hashing/sha256", HashSha256);
openapi.post("/hashing/sha512", HashSha512);
openapi.post("/hashing/sha512-256", HashSha512_256);
openapi.post("/hashing/keccak256", HashKeccak256);
openapi.post("/hashing/hash160", HashHash160);
openapi.post("/hashing/ripemd160", HashRipemd160);

// =============================================================================
// Storage Routes
// =============================================================================

// KV (read/write tiers)
openapi.get("/storage/kv/:key", KvGet);
openapi.post("/storage/kv", KvSet);
openapi.delete("/storage/kv/:key", KvDelete);
openapi.get("/storage/kv", KvList);

// Paste (read/write tiers)
openapi.post("/storage/paste", PasteCreate);
openapi.get("/storage/paste/:id", PasteGet);
openapi.delete("/storage/paste/:id", PasteDelete);

// DB (read/write tiers)
openapi.post("/storage/db/query", DbQuery);
openapi.post("/storage/db/execute", DbExecute);
openapi.get("/storage/db/schema", DbSchema);

// Sync/Locks (read/write tiers)
openapi.post("/storage/sync/lock", SyncLock);
openapi.post("/storage/sync/unlock", SyncUnlock);
openapi.post("/storage/sync/extend", SyncExtend);
openapi.get("/storage/sync/status/:name", SyncStatus);
openapi.get("/storage/sync/list", SyncList);

// Queue (read/write tiers)
openapi.post("/storage/queue/push", QueuePush);
openapi.post("/storage/queue/pop", QueuePop);
openapi.get("/storage/queue/peek", QueuePeek);
openapi.get("/storage/queue/status", QueueStatus);
openapi.post("/storage/queue/clear", QueueClear);

// Memory/Vector (read/write_large tiers)
openapi.post("/storage/memory/store", MemoryStore);
openapi.post("/storage/memory/search", MemorySearch);
openapi.post("/storage/memory/delete", MemoryDelete);
openapi.get("/storage/memory/list", MemoryList);
openapi.post("/storage/memory/clear", MemoryClear);

// =============================================================================
// Error Handling
// =============================================================================

app.onError((err, c) => {
  console.error("Unhandled error:", err);
  return c.json(
    {
      ok: false,
      error: "Internal server error",
      message: err.message,
    },
    500
  );
});

app.notFound((c) => {
  return c.json(
    {
      ok: false,
      error: "Not found",
      path: c.req.path,
      hint: "Visit /docs for API documentation",
    },
    404
  );
});

// =============================================================================
// Export
// =============================================================================

export default app;
