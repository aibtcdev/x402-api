/**
 * Endpoint Registry for X402 API Tests
 *
 * Central configuration for all paid endpoints with test data and validation.
 * Used by _run_all_tests.ts for comprehensive E2E payment testing.
 */

import type { TestConfig } from "./_test_generator";
import type { TokenType } from "x402-stacks";
import { generateTestId } from "./_shared_utils";

// =============================================================================
// Test Fixtures
// =============================================================================

const FIXTURES = {
  // Stacks addresses
  mainnetAddress: "SP2PABAF9FTAJYNFZH93XENAJ8FVY99RRM50D2JG9",
  testnetAddress: "ST1PQHQKV0RJXZFY1DGX8MNSNYVE3VGZJSRTPGZGM",

  // Sample data
  shortText: "Hello, World!",
  testData: "test",

  // Precomputed hashes for "test"
  sha256OfTest: "0x9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08",

  // Clarity hex value (uint 1)
  clarityHexUint1: "0x0100000000000000000000000000000001",

  // Sample transaction hex
  sampleTxHex:
    "0x80800000000400164247d6f2b425ac5771423ae6c80c754f7172b0000000000000003200000000000000b400008537046ff1008368baaa3ff2235122c556b89dad4f9df0639b924cf32a44b866497e49846b24191e711b21faaae96ca0542e4a140168484740b94211cececb3303020000000000051ab52c45b1a7977204f17ac0b6f48306aea2dbb8e9000000000007a12046617563657400000000000000000000000000000000000000000000000000000000",
};

// =============================================================================
// Validation Helpers
// =============================================================================

type DataWithToken = { tokenType: TokenType };

const hasTokenType = (data: unknown, tokenType: TokenType): boolean => {
  const d = data as DataWithToken;
  return d.tokenType === tokenType;
};

const hasField = (data: unknown, field: string): boolean => {
  return typeof data === "object" && data !== null && field in data;
};

const hasFields = (data: unknown, fields: string[]): boolean => {
  return fields.every((f) => hasField(data, f));
};

const isOk = (data: unknown): boolean => {
  return hasField(data, "ok") && (data as { ok: boolean }).ok === true;
};

// =============================================================================
// HASHING ENDPOINTS (6) - Simple tier
// =============================================================================

const hashingEndpoints: TestConfig[] = [
  {
    name: "sha256",
    endpoint: "/hashing/sha256",
    method: "POST",
    body: { data: FIXTURES.testData },
    validateResponse: (data, tokenType) =>
      isOk(data) &&
      hasFields(data, ["hash", "algorithm"]) &&
      hasTokenType(data, tokenType) &&
      (data as { hash: string }).hash === FIXTURES.sha256OfTest,
  },
  {
    name: "sha512",
    endpoint: "/hashing/sha512",
    method: "POST",
    body: { data: FIXTURES.testData },
    validateResponse: (data, tokenType) =>
      isOk(data) && hasFields(data, ["hash", "algorithm"]) && hasTokenType(data, tokenType),
  },
  {
    name: "sha512-256",
    endpoint: "/hashing/sha512-256",
    method: "POST",
    body: { data: FIXTURES.testData },
    validateResponse: (data, tokenType) =>
      isOk(data) && hasFields(data, ["hash", "algorithm"]) && hasTokenType(data, tokenType),
  },
  {
    name: "keccak256",
    endpoint: "/hashing/keccak256",
    method: "POST",
    body: { data: FIXTURES.testData },
    validateResponse: (data, tokenType) =>
      isOk(data) && hasFields(data, ["hash", "algorithm"]) && hasTokenType(data, tokenType),
  },
  {
    name: "hash160",
    endpoint: "/hashing/hash160",
    method: "POST",
    body: { data: FIXTURES.testData },
    validateResponse: (data, tokenType) =>
      isOk(data) && hasFields(data, ["hash", "algorithm"]) && hasTokenType(data, tokenType),
  },
  {
    name: "ripemd160",
    endpoint: "/hashing/ripemd160",
    method: "POST",
    body: { data: FIXTURES.testData },
    validateResponse: (data, tokenType) =>
      isOk(data) && hasFields(data, ["hash", "algorithm"]) && hasTokenType(data, tokenType),
  },
];

// =============================================================================
// STACKS ENDPOINTS (6) - Simple tier
// =============================================================================

const stacksEndpoints: TestConfig[] = [
  {
    name: "address-convert",
    endpoint: `/stacks/address/${FIXTURES.mainnetAddress}`,
    method: "GET",
    validateResponse: (data, tokenType) =>
      isOk(data) && hasFields(data, ["original", "converted"]) && hasTokenType(data, tokenType),
  },
  {
    name: "decode-clarity",
    endpoint: "/stacks/decode/clarity",
    method: "POST",
    body: { hex: FIXTURES.clarityHexUint1 },
    validateResponse: (data, tokenType) =>
      isOk(data) && hasFields(data, ["type", "value"]) && hasTokenType(data, tokenType),
  },
  {
    name: "decode-transaction",
    endpoint: "/stacks/decode/transaction",
    method: "POST",
    body: { hex: FIXTURES.sampleTxHex },
    validateResponse: (data, tokenType) =>
      isOk(data) && hasFields(data, ["txType", "sender", "payload"]) && hasTokenType(data, tokenType),
  },
  {
    name: "profile",
    endpoint: `/stacks/profile/${FIXTURES.mainnetAddress}`,
    method: "GET",
    validateResponse: (data, tokenType) =>
      isOk(data) && hasField(data, "profile") && hasTokenType(data, tokenType),
  },
  {
    name: "verify-message",
    endpoint: "/stacks/verify/message",
    method: "POST",
    body: {
      message: "test message",
      signature: "0".repeat(130), // Invalid sig, but tests endpoint returns valid=false
      publicKey: "0".repeat(66), // 33-byte compressed pubkey in hex
    },
    validateResponse: (data, tokenType) =>
      isOk(data) && hasField(data, "valid") && hasTokenType(data, tokenType),
  },
  {
    name: "verify-sip018",
    endpoint: "/stacks/verify/sip018",
    method: "POST",
    body: {
      signature: "0".repeat(130), // Invalid sig, but tests endpoint returns valid=false
      publicKey: "0".repeat(66), // 33-byte compressed pubkey in hex
      domain: { name: "test", version: "1", chainId: 1 },
      message: "0x0100000000000000000000000000000001", // Serialized uint 1
    },
    validateResponse: (data, tokenType) =>
      isOk(data) && hasField(data, "valid") && hasTokenType(data, tokenType),
  },
];

// =============================================================================
// INFERENCE ENDPOINTS (4) - Free (list) + Dynamic/AI (chat)
// =============================================================================

const inferenceEndpoints: TestConfig[] = [
  {
    name: "openrouter-models",
    endpoint: "/inference/openrouter/models",
    method: "GET",
    skipPayment: true,
    validateResponse: (data) => hasField(data, "models") || hasField(data, "data"),
  },
  {
    name: "cloudflare-models",
    endpoint: "/inference/cloudflare/models",
    method: "GET",
    skipPayment: true,
    validateResponse: (data) => hasField(data, "models"),
  },
  // Chat endpoints require actual tokens, test separately
  // {
  //   name: "openrouter-chat",
  //   endpoint: "/inference/openrouter/chat",
  //   method: "POST",
  //   body: { model: "openai/gpt-3.5-turbo", messages: [{ role: "user", content: "Hi" }] },
  //   validateResponse: (data, tokenType) => hasField(data, "choices") && hasTokenType(data, tokenType),
  // },
];

// =============================================================================
// STORAGE - KV ENDPOINTS (4)
// =============================================================================

const kvEndpoints: TestConfig[] = [
  {
    name: "kv-set",
    endpoint: "/storage/kv",
    method: "POST",
    body: { key: generateTestId("kv"), value: JSON.stringify({ test: true }) },
    validateResponse: (data, tokenType) =>
      isOk(data) && hasFields(data, ["key", "created"]) && hasTokenType(data, tokenType),
  },
  {
    name: "kv-get",
    endpoint: "/storage/kv/nonexistent-key",
    method: "GET",
    allowedStatuses: [404],
    // Valid if: (success response with tokenType) OR (error response with error field)
    validateResponse: (data, tokenType) =>
      (isOk(data) && hasTokenType(data, tokenType)) ||
      (hasField(data, "error") && hasField(data, "ok") && (data as { ok: boolean }).ok === false),
  },
  {
    name: "kv-list",
    endpoint: "/storage/kv",
    method: "GET",
    validateResponse: (data, tokenType) =>
      isOk(data) && hasField(data, "keys") && hasTokenType(data, tokenType),
  },
  {
    name: "kv-delete",
    endpoint: "/storage/kv/nonexistent-key",
    method: "DELETE",
    allowedStatuses: [404],
    // Valid if: (success response with tokenType) OR (error response with error field)
    validateResponse: (data, tokenType) =>
      (isOk(data) && hasTokenType(data, tokenType)) ||
      (hasField(data, "error") && hasField(data, "ok") && (data as { ok: boolean }).ok === false),
  },
];

// =============================================================================
// STORAGE - PASTE ENDPOINTS (3)
// =============================================================================

const pasteEndpoints: TestConfig[] = [
  {
    name: "paste-create",
    endpoint: "/storage/paste",
    method: "POST",
    body: { content: "Hello, World! This is a test paste.", language: "text", ttl: 60 },
    validateResponse: (data, tokenType) =>
      isOk(data) && hasFields(data, ["id", "createdAt"]) && hasTokenType(data, tokenType),
  },
  {
    name: "paste-get",
    endpoint: "/storage/paste/nonexistent",
    method: "GET",
    allowedStatuses: [404],
    validateResponse: (data, tokenType) =>
      (isOk(data) && hasTokenType(data, tokenType)) ||
      (hasField(data, "error") && hasField(data, "ok") && (data as { ok: boolean }).ok === false),
  },
  {
    name: "paste-delete",
    endpoint: "/storage/paste/nonexistent",
    method: "DELETE",
    allowedStatuses: [404],
    validateResponse: (data, tokenType) =>
      (isOk(data) && hasTokenType(data, tokenType)) ||
      (hasField(data, "error") && hasField(data, "ok") && (data as { ok: boolean }).ok === false),
  },
];

// =============================================================================
// STORAGE - DB ENDPOINTS (3)
// =============================================================================

const dbEndpoints: TestConfig[] = [
  {
    name: "db-query",
    endpoint: "/storage/db/query",
    method: "POST",
    body: { query: "SELECT 1 as test" },
    validateResponse: (data, tokenType) =>
      isOk(data) && hasFields(data, ["rows", "columns"]) && hasTokenType(data, tokenType),
  },
  {
    name: "db-execute",
    endpoint: "/storage/db/execute",
    method: "POST",
    body: { query: "CREATE TABLE IF NOT EXISTS test_table (id INTEGER PRIMARY KEY, name TEXT)" },
    validateResponse: (data, tokenType) =>
      isOk(data) && hasField(data, "rowsAffected") && hasTokenType(data, tokenType),
  },
  {
    name: "db-schema",
    endpoint: "/storage/db/schema",
    method: "GET",
    validateResponse: (data, tokenType) =>
      isOk(data) && hasField(data, "tables") && hasTokenType(data, tokenType),
  },
];

// =============================================================================
// STORAGE - SYNC/LOCK ENDPOINTS (5)
// =============================================================================

const syncEndpoints: TestConfig[] = [
  {
    name: "sync-lock",
    endpoint: "/storage/sync/lock",
    method: "POST",
    body: { name: "test-lock", ttl: 60 },
    validateResponse: (data, tokenType) =>
      isOk(data) && hasFields(data, ["acquired", "name"]) && hasTokenType(data, tokenType),
  },
  {
    name: "sync-unlock",
    endpoint: "/storage/sync/unlock",
    method: "POST",
    body: { name: "test-lock", token: "invalid-token" },
    validateResponse: (data, tokenType) =>
      isOk(data) && hasFields(data, ["released", "name"]) && hasTokenType(data, tokenType),
  },
  {
    name: "sync-extend",
    endpoint: "/storage/sync/extend",
    method: "POST",
    body: { name: "test-lock", token: "invalid-token", ttl: 60 },
    validateResponse: (data, tokenType) =>
      isOk(data) && hasFields(data, ["extended", "name"]) && hasTokenType(data, tokenType),
  },
  {
    name: "sync-status",
    endpoint: "/storage/sync/status/test-lock",
    method: "GET",
    validateResponse: (data, tokenType) =>
      isOk(data) && hasFields(data, ["name", "locked"]) && hasTokenType(data, tokenType),
  },
  {
    name: "sync-list",
    endpoint: "/storage/sync/list",
    method: "GET",
    validateResponse: (data, tokenType) =>
      isOk(data) && hasFields(data, ["locks", "count"]) && hasTokenType(data, tokenType),
  },
];

// =============================================================================
// STORAGE - QUEUE ENDPOINTS (5)
// =============================================================================

const queueEndpoints: TestConfig[] = [
  {
    name: "queue-push",
    endpoint: "/storage/queue/push",
    method: "POST",
    body: { name: "test-queue", items: [{ task: "test" }], priority: 0 },
    validateResponse: (data, tokenType) =>
      isOk(data) && hasField(data, "pushed") && hasTokenType(data, tokenType),
  },
  {
    name: "queue-pop",
    endpoint: "/storage/queue/pop",
    method: "POST",
    body: { name: "test-queue", count: 1 },
    // Response has items array (may be empty if queue was empty)
    validateResponse: (data, tokenType) =>
      isOk(data) && hasField(data, "items") && hasTokenType(data, tokenType),
  },
  {
    name: "queue-peek",
    endpoint: "/storage/queue/peek?name=test-queue",
    method: "GET",
    // Response has items array (may be empty)
    validateResponse: (data, tokenType) =>
      isOk(data) && hasField(data, "items") && hasTokenType(data, tokenType),
  },
  {
    name: "queue-status",
    endpoint: "/storage/queue/status?name=test-queue",
    method: "GET",
    validateResponse: (data, tokenType) =>
      isOk(data) && hasField(data, "name") && hasTokenType(data, tokenType),
  },
  {
    name: "queue-clear",
    endpoint: "/storage/queue/clear",
    method: "POST",
    body: { name: "test-queue" },
    validateResponse: (data, tokenType) =>
      isOk(data) && hasTokenType(data, tokenType),
  },
];

// =============================================================================
// STORAGE - MEMORY ENDPOINTS (5)
// =============================================================================

const memoryEndpoints: TestConfig[] = [
  {
    name: "memory-store",
    endpoint: "/storage/memory/store",
    method: "POST",
    body: {
      items: [{ id: generateTestId("mem"), text: "This is a test memory for the API." }],
    },
    validateResponse: (data, tokenType) =>
      isOk(data) && hasField(data, "stored") && hasTokenType(data, tokenType),
  },
  {
    name: "memory-search",
    endpoint: "/storage/memory/search",
    method: "POST",
    body: { query: "test memory", limit: 10 },
    validateResponse: (data, tokenType) =>
      isOk(data) && hasField(data, "results") && hasTokenType(data, tokenType),
  },
  {
    name: "memory-delete",
    endpoint: "/storage/memory/delete",
    method: "POST",
    body: { ids: ["nonexistent-memory"] },
    validateResponse: (data, tokenType) =>
      isOk(data) && hasField(data, "deleted") && hasTokenType(data, tokenType),
  },
  {
    name: "memory-list",
    endpoint: "/storage/memory/list",
    method: "GET",
    validateResponse: (data, tokenType) =>
      isOk(data) && hasFields(data, ["items", "total"]) && hasTokenType(data, tokenType),
  },
  {
    name: "memory-clear",
    endpoint: "/storage/memory/clear",
    method: "POST",
    body: {},
    validateResponse: (data, tokenType) =>
      isOk(data) && hasTokenType(data, tokenType),
  },
];

// =============================================================================
// EXPORTS
// =============================================================================

// Stateless endpoints - can be tested individually without state management
export const STATELESS_ENDPOINTS: TestConfig[] = [
  ...hashingEndpoints,
  ...stacksEndpoints,
  ...inferenceEndpoints,
];

// Stateful categories - should use lifecycle tests for full CRUD
export const STATEFUL_CATEGORIES = ["kv", "paste", "db", "sync", "queue", "memory"] as const;

export type StatefulCategory = (typeof STATEFUL_CATEGORIES)[number];

// Full registry for reference (includes all endpoints)
export const ENDPOINT_REGISTRY: TestConfig[] = [
  ...hashingEndpoints,
  ...stacksEndpoints,
  ...inferenceEndpoints,
  ...kvEndpoints,
  ...pasteEndpoints,
  ...dbEndpoints,
  ...syncEndpoints,
  ...queueEndpoints,
  ...memoryEndpoints,
];

// Category mapping for filtered runs
export const ENDPOINT_CATEGORIES: Record<string, TestConfig[]> = {
  hashing: hashingEndpoints,
  stacks: stacksEndpoints,
  inference: inferenceEndpoints,
  kv: kvEndpoints,
  paste: pasteEndpoints,
  db: dbEndpoints,
  sync: syncEndpoints,
  queue: queueEndpoints,
  memory: memoryEndpoints,
};

// Check if a category is stateful
export function isStatefulCategory(category: string): category is StatefulCategory {
  return STATEFUL_CATEGORIES.includes(category as StatefulCategory);
}

// Export counts for verification
export const ENDPOINT_COUNTS = {
  total: ENDPOINT_REGISTRY.length,
  stateless: STATELESS_ENDPOINTS.length,
  hashing: hashingEndpoints.length,
  stacks: stacksEndpoints.length,
  inference: inferenceEndpoints.length,
  kv: kvEndpoints.length,
  paste: pasteEndpoints.length,
  db: dbEndpoints.length,
  sync: syncEndpoints.length,
  queue: queueEndpoints.length,
  memory: memoryEndpoints.length,
};
