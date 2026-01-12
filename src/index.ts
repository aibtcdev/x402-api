/**
 * x402 Stacks API Host
 *
 * Cloudflare Worker exposing APIs on a pay-per-use basis using the x402 protocol.
 * Supports STX, sBTC, and USDCx payments via Stacks blockchain.
 */

import { fromHono } from "chanfana";
import { Hono } from "hono";
import { cors } from "hono/cors";
import type { Env, AppContext } from "./types";

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

// Durable Objects
export { UsageDO } from "./durable-objects/UsageDO";
export { StorageDO } from "./durable-objects/StorageDO";

// =============================================================================
// Hono App
// =============================================================================

const app = new Hono<{ Bindings: Env }>();

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
