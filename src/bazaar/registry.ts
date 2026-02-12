/**
 * Bazaar Endpoint Discovery Registry
 *
 * Complete metadata catalog for all ~40 API endpoints.
 * Provides input/output examples and JSON schemas for the Bazaar discovery layer.
 */

import type { EndpointMetadata } from "./types";

// =============================================================================
// Shared Constants
// =============================================================================

/** Token type query parameter, repeated across most paid endpoints */
const TOKEN_TYPE_PARAM = {
  type: "string",
  enum: ["STX", "sBTC", "USDCx"],
  default: "STX",
} as const;

/** Standard queryParams containing only the tokenType selector */
const TOKEN_TYPE_QUERY: Record<string, unknown> = {
  tokenType: TOKEN_TYPE_PARAM,
};

/** Request body schema shared by all hashing endpoints */
const HASH_BODY_SCHEMA: Record<string, unknown> = {
  type: "object",
  required: ["data"],
  properties: {
    data: { type: "string", description: "Data to hash" },
  },
};

/** Chat messages array schema shared by OpenRouter and Cloudflare chat */
const CHAT_MESSAGES_SCHEMA = {
  type: "array",
  items: {
    type: "object",
    required: ["role", "content"],
    properties: {
      role: { type: "string", enum: ["system", "user", "assistant"] },
      content: { type: "string" },
    },
  },
};

// =============================================================================
// HASHING ENDPOINTS (6)
// =============================================================================

const hashingEndpoints: EndpointMetadata[] = [
  {
    path: "/hashing/sha256",
    method: "POST",
    category: "hashing",
    description: "Compute SHA-256 hash using SubtleCrypto. Clarity-compatible output.",
    bodyType: "json",
    bodySchema: HASH_BODY_SCHEMA,
    outputExample: {
      ok: true,
      hash: "0x9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08",
      algorithm: "SHA-256",
      tokenType: "STX",
    },
  },
  {
    path: "/hashing/sha512",
    method: "POST",
    category: "hashing",
    description: "Compute SHA-512 hash using SubtleCrypto. Clarity-compatible output.",
    bodyType: "json",
    bodySchema: HASH_BODY_SCHEMA,
    outputExample: {
      ok: true,
      hash: "0xee26b0dd4af7e749aa1a8ee3c10ae9923f618980772e473f8819a5d4940e0db27ac185f8a0e1d5f84f88bc887fd67b143732c304cc5fa9ad8e6f57f50028a8ff",
      algorithm: "SHA-512",
      tokenType: "STX",
    },
  },
  {
    path: "/hashing/sha512-256",
    method: "POST",
    category: "hashing",
    description: "Compute SHA-512/256 hash. Clarity-compatible output.",
    bodyType: "json",
    bodySchema: HASH_BODY_SCHEMA,
    outputExample: {
      ok: true,
      hash: "0x3d37fe58435e0d87323dee4a2c1b339ef954de63716ee79f5747f94d974f913f",
      algorithm: "SHA-512/256",
      tokenType: "STX",
    },
  },
  {
    path: "/hashing/keccak256",
    method: "POST",
    category: "hashing",
    description: "Compute Keccak-256 hash. Ethereum-compatible.",
    bodyType: "json",
    bodySchema: HASH_BODY_SCHEMA,
    outputExample: {
      ok: true,
      hash: "0x9c22ff5f21f0b81b113e63f7db6da94fedef11b2119b4088b89664fb9a3cb658",
      algorithm: "Keccak-256",
      tokenType: "STX",
    },
  },
  {
    path: "/hashing/hash160",
    method: "POST",
    category: "hashing",
    description: "Compute Hash160 (RIPEMD-160 of SHA-256). Bitcoin-compatible.",
    bodyType: "json",
    bodySchema: HASH_BODY_SCHEMA,
    outputExample: {
      ok: true,
      hash: "0x5e52fee47e6b070565f74372468cdc699de89107",
      algorithm: "Hash160",
      tokenType: "STX",
    },
  },
  {
    path: "/hashing/ripemd160",
    method: "POST",
    category: "hashing",
    description: "Compute RIPEMD-160 hash.",
    bodyType: "json",
    bodySchema: HASH_BODY_SCHEMA,
    outputExample: {
      ok: true,
      hash: "0x5e52fee47e6b070565f74372468cdc699de89107",
      algorithm: "RIPEMD-160",
      tokenType: "STX",
    },
  },
];

// =============================================================================
// STACKS ENDPOINTS (6)
// =============================================================================

const stacksEndpoints: EndpointMetadata[] = [
  {
    path: "/stacks/address/{address}",
    method: "GET",
    category: "stacks",
    description: "Convert Stacks address between mainnet and testnet versions.",
    queryParams: TOKEN_TYPE_QUERY,
    outputExample: {
      ok: true,
      original: "SP2PABAF9FTAJYNFZH93XENAJ8FVY99RRM50D2JG9",
      converted: "ST2PABAF9FTAJYNFZH93XENAJ8FVY99RRM4W6ZSQ3",
      tokenType: "STX",
    },
  },
  {
    path: "/stacks/decode/clarity",
    method: "POST",
    category: "stacks",
    description: "Decode Clarity value from hex to JSON.",
    bodyType: "json",
    bodySchema: {
      type: "object",
      required: ["hex"],
      properties: {
        hex: { type: "string", description: "Hex-encoded Clarity value (e.g., 0x0100...)" },
      },
    },
    outputExample: {
      ok: true,
      type: "uint",
      value: "1",
      tokenType: "STX",
    },
  },
  {
    path: "/stacks/decode/transaction",
    method: "POST",
    category: "stacks",
    description: "Decode Stacks transaction from hex to JSON.",
    bodyType: "json",
    bodySchema: {
      type: "object",
      required: ["hex"],
      properties: {
        hex: { type: "string", description: "Hex-encoded transaction" },
      },
    },
    outputExample: {
      ok: true,
      txType: "contract_call",
      sender: "SP2PABAF9FTAJYNFZH93XENAJ8FVY99RRM50D2JG9",
      payload: {
        contractAddress: "SP2PABAF9FTAJYNFZH93XENAJ8FVY99RRM50D2JG9",
        contractName: "test-contract",
        functionName: "test-function",
        functionArgs: [],
      },
      tokenType: "STX",
    },
  },
  {
    path: "/stacks/profile/{address}",
    method: "GET",
    category: "stacks",
    description: "Get comprehensive profile for a Stacks address including balances, BNS name, and token holdings.",
    queryParams: TOKEN_TYPE_QUERY,
    outputExample: {
      ok: true,
      profile: {
        input: "SP2PABAF9FTAJYNFZH93XENAJ8FVY99RRM50D2JG9",
        address: "SP2PABAF9FTAJYNFZH93XENAJ8FVY99RRM50D2JG9",
        bnsName: "satoshi.btc",
        blockHeight: 150000,
        stxBalance: {
          balance: "1000000000",
          locked: "0",
        },
        nonce: 42,
        fungibleTokens: [],
        nonFungibleTokens: [],
      },
      tokenType: "STX",
    },
  },
  {
    path: "/stacks/verify/message",
    method: "POST",
    category: "stacks",
    description: "Verify a signed message using Stacks ECDSA signature.",
    bodyType: "json",
    bodySchema: {
      type: "object",
      required: ["message", "signature", "publicKey"],
      properties: {
        message: { type: "string", description: "Original message" },
        signature: { type: "string", description: "Hex-encoded signature" },
        publicKey: { type: "string", description: "Hex-encoded compressed public key (33 bytes)" },
      },
    },
    outputExample: {
      ok: true,
      valid: true,
      message: "test message",
      tokenType: "STX",
    },
  },
  {
    path: "/stacks/verify/sip018",
    method: "POST",
    category: "stacks",
    description: "Verify SIP-018 signed structured data.",
    bodyType: "json",
    bodySchema: {
      type: "object",
      required: ["signature", "publicKey", "domain", "message"],
      properties: {
        signature: { type: "string", description: "Hex-encoded signature" },
        publicKey: { type: "string", description: "Hex-encoded compressed public key (33 bytes)" },
        domain: {
          type: "object",
          required: ["name", "version", "chainId"],
          properties: {
            name: { type: "string" },
            version: { type: "string" },
            chainId: { type: "number" },
          },
        },
        message: { type: "string", description: "Hex-encoded Clarity value" },
      },
    },
    outputExample: {
      ok: true,
      valid: true,
      tokenType: "STX",
    },
  },
];

// =============================================================================
// INFERENCE ENDPOINTS (4)
// =============================================================================

const inferenceEndpoints: EndpointMetadata[] = [
  {
    path: "/inference/openrouter/models",
    method: "GET",
    category: "inference",
    description: "List available OpenRouter models (free endpoint).",
    outputExample: {
      models: [
        {
          id: "openai/gpt-4o",
          name: "GPT-4o",
          context_length: 128000,
          pricing: {
            prompt: "0.000005",
            completion: "0.000015",
          },
        },
      ],
    },
  },
  {
    path: "/inference/openrouter/chat",
    method: "POST",
    category: "inference",
    description: "Create a chat completion via OpenRouter. Dynamic pricing based on model and token usage.",
    bodyType: "json",
    bodySchema: {
      type: "object",
      required: ["model", "messages"],
      properties: {
        model: { type: "string", description: "Model ID (e.g., openai/gpt-4o)" },
        messages: CHAT_MESSAGES_SCHEMA,
        temperature: { type: "number", minimum: 0, maximum: 2 },
        max_tokens: { type: "integer", minimum: 1 },
        stream: { type: "boolean", default: false },
      },
    },
    queryParams: TOKEN_TYPE_QUERY,
    outputExample: {
      id: "gen-123",
      model: "openai/gpt-4o",
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: "Hello! How can I help you today?",
          },
          finish_reason: "stop",
        },
      ],
      usage: {
        prompt_tokens: 10,
        completion_tokens: 8,
        total_tokens: 18,
      },
    },
  },
  {
    path: "/inference/cloudflare/models",
    method: "GET",
    category: "inference",
    description: "List available Cloudflare AI models (free endpoint).",
    outputExample: {
      models: [
        {
          name: "@cf/meta/llama-3.1-8b-instruct",
          description: "Llama 3.1 8B Instruct",
        },
      ],
    },
  },
  {
    path: "/inference/cloudflare/chat",
    method: "POST",
    category: "inference",
    description: "Create a chat completion via Cloudflare AI. Standard pricing.",
    bodyType: "json",
    bodySchema: {
      type: "object",
      required: ["model", "messages"],
      properties: {
        model: { type: "string", description: "Model name (e.g., @cf/meta/llama-3.1-8b-instruct)" },
        messages: CHAT_MESSAGES_SCHEMA,
        temperature: { type: "number" },
        max_tokens: { type: "integer" },
      },
    },
    queryParams: TOKEN_TYPE_QUERY,
    outputExample: {
      response: "Hello! How can I assist you today?",
      tokenType: "STX",
    },
  },
];

// =============================================================================
// STORAGE - KV ENDPOINTS (4)
// =============================================================================

const kvEndpoints: EndpointMetadata[] = [
  {
    path: "/storage/kv",
    method: "POST",
    category: "storage",
    description: "Set a value in the KV store.",
    bodyType: "json",
    bodySchema: {
      type: "object",
      required: ["key", "value"],
      properties: {
        key: { type: "string", description: "Key to set" },
        value: { type: "string", description: "Value to store" },
        metadata: { type: "object", description: "Optional metadata" },
        ttl: { type: "integer", description: "TTL in seconds (optional)" },
      },
    },
    queryParams: TOKEN_TYPE_QUERY,
    outputExample: {
      ok: true,
      key: "my-key",
      created: true,
      tokenType: "STX",
    },
  },
  {
    path: "/storage/kv/{key}",
    method: "GET",
    category: "storage",
    description: "Get a value from the KV store.",
    queryParams: TOKEN_TYPE_QUERY,
    outputExample: {
      ok: true,
      key: "my-key",
      value: "my-value",
      metadata: {},
      tokenType: "STX",
    },
  },
  {
    path: "/storage/kv",
    method: "GET",
    category: "storage",
    description: "List all keys in the KV store.",
    queryParams: {
      prefix: { type: "string", description: "Filter keys by prefix" },
      limit: { type: "integer", description: "Maximum number of keys to return" },
      tokenType: TOKEN_TYPE_PARAM,
    },
    outputExample: {
      ok: true,
      keys: ["key1", "key2"],
      count: 2,
      tokenType: "STX",
    },
  },
  {
    path: "/storage/kv/{key}",
    method: "DELETE",
    category: "storage",
    description: "Delete a key from the KV store.",
    queryParams: TOKEN_TYPE_QUERY,
    outputExample: {
      ok: true,
      key: "my-key",
      deleted: true,
      tokenType: "STX",
    },
  },
];

// =============================================================================
// STORAGE - PASTE ENDPOINTS (3)
// =============================================================================

const pasteEndpoints: EndpointMetadata[] = [
  {
    path: "/storage/paste",
    method: "POST",
    category: "storage",
    description: "Create a paste (text snippet with syntax highlighting).",
    bodyType: "json",
    bodySchema: {
      type: "object",
      required: ["content"],
      properties: {
        content: { type: "string", description: "Paste content" },
        language: { type: "string", description: "Programming language for syntax highlighting" },
        ttl: { type: "integer", description: "TTL in seconds (optional)" },
      },
    },
    queryParams: TOKEN_TYPE_QUERY,
    outputExample: {
      ok: true,
      id: "paste-abc123",
      createdAt: "2024-01-01T00:00:00.000Z",
      tokenType: "STX",
    },
  },
  {
    path: "/storage/paste/{id}",
    method: "GET",
    category: "storage",
    description: "Get a paste by ID.",
    queryParams: TOKEN_TYPE_QUERY,
    outputExample: {
      ok: true,
      id: "paste-abc123",
      content: "console.log('hello world');",
      language: "javascript",
      createdAt: "2024-01-01T00:00:00.000Z",
      tokenType: "STX",
    },
  },
  {
    path: "/storage/paste/{id}",
    method: "DELETE",
    category: "storage",
    description: "Delete a paste by ID.",
    queryParams: TOKEN_TYPE_QUERY,
    outputExample: {
      ok: true,
      id: "paste-abc123",
      deleted: true,
      tokenType: "STX",
    },
  },
];

// =============================================================================
// STORAGE - DB ENDPOINTS (3)
// =============================================================================

const dbEndpoints: EndpointMetadata[] = [
  {
    path: "/storage/db/query",
    method: "POST",
    category: "storage",
    description: "Execute a read-only SQL query against the SQLite database.",
    bodyType: "json",
    bodySchema: {
      type: "object",
      required: ["query"],
      properties: {
        query: { type: "string", description: "SQL SELECT query" },
        params: { type: "array", description: "Query parameters for placeholders" },
      },
    },
    queryParams: TOKEN_TYPE_QUERY,
    outputExample: {
      ok: true,
      rows: [{ id: 1, name: "test" }],
      columns: ["id", "name"],
      count: 1,
      tokenType: "STX",
    },
  },
  {
    path: "/storage/db/execute",
    method: "POST",
    category: "storage",
    description: "Execute a write SQL statement (CREATE, INSERT, UPDATE, DELETE).",
    bodyType: "json",
    bodySchema: {
      type: "object",
      required: ["query"],
      properties: {
        query: { type: "string", description: "SQL write statement" },
        params: { type: "array", description: "Query parameters for placeholders" },
      },
    },
    queryParams: TOKEN_TYPE_QUERY,
    outputExample: {
      ok: true,
      rowsAffected: 1,
      tokenType: "STX",
    },
  },
  {
    path: "/storage/db/schema",
    method: "GET",
    category: "storage",
    description: "Get the database schema (list of tables and columns).",
    queryParams: TOKEN_TYPE_QUERY,
    outputExample: {
      ok: true,
      tables: [
        {
          name: "users",
          columns: [
            { name: "id", type: "INTEGER" },
            { name: "name", type: "TEXT" },
          ],
        },
      ],
      tokenType: "STX",
    },
  },
];

// =============================================================================
// STORAGE - SYNC/LOCK ENDPOINTS (5)
// =============================================================================

const syncEndpoints: EndpointMetadata[] = [
  {
    path: "/storage/sync/lock",
    method: "POST",
    category: "storage",
    description: "Acquire a distributed lock.",
    bodyType: "json",
    bodySchema: {
      type: "object",
      required: ["name"],
      properties: {
        name: { type: "string", description: "Lock name" },
        ttl: { type: "integer", description: "Lock TTL in seconds (default: 30)" },
      },
    },
    queryParams: TOKEN_TYPE_QUERY,
    outputExample: {
      ok: true,
      acquired: true,
      name: "my-lock",
      token: "lock-token-abc123",
      expiresAt: "2024-01-01T00:01:00.000Z",
      tokenType: "STX",
    },
  },
  {
    path: "/storage/sync/unlock",
    method: "POST",
    category: "storage",
    description: "Release a distributed lock.",
    bodyType: "json",
    bodySchema: {
      type: "object",
      required: ["name", "token"],
      properties: {
        name: { type: "string", description: "Lock name" },
        token: { type: "string", description: "Lock token from acquire" },
      },
    },
    queryParams: TOKEN_TYPE_QUERY,
    outputExample: {
      ok: true,
      released: true,
      name: "my-lock",
      tokenType: "STX",
    },
  },
  {
    path: "/storage/sync/extend",
    method: "POST",
    category: "storage",
    description: "Extend the TTL of an acquired lock.",
    bodyType: "json",
    bodySchema: {
      type: "object",
      required: ["name", "token", "ttl"],
      properties: {
        name: { type: "string", description: "Lock name" },
        token: { type: "string", description: "Lock token from acquire" },
        ttl: { type: "integer", description: "New TTL in seconds" },
      },
    },
    queryParams: TOKEN_TYPE_QUERY,
    outputExample: {
      ok: true,
      extended: true,
      name: "my-lock",
      expiresAt: "2024-01-01T00:02:00.000Z",
      tokenType: "STX",
    },
  },
  {
    path: "/storage/sync/status/{name}",
    method: "GET",
    category: "storage",
    description: "Get the status of a lock.",
    queryParams: TOKEN_TYPE_QUERY,
    outputExample: {
      ok: true,
      name: "my-lock",
      locked: true,
      expiresAt: "2024-01-01T00:01:00.000Z",
      tokenType: "STX",
    },
  },
  {
    path: "/storage/sync/list",
    method: "GET",
    category: "storage",
    description: "List all locks.",
    queryParams: TOKEN_TYPE_QUERY,
    outputExample: {
      ok: true,
      locks: [
        {
          name: "my-lock",
          locked: true,
          expiresAt: "2024-01-01T00:01:00.000Z",
        },
      ],
      count: 1,
      tokenType: "STX",
    },
  },
];

// =============================================================================
// STORAGE - QUEUE ENDPOINTS (5)
// =============================================================================

const queueEndpoints: EndpointMetadata[] = [
  {
    path: "/storage/queue/push",
    method: "POST",
    category: "storage",
    description: "Push items to a queue.",
    bodyType: "json",
    bodySchema: {
      type: "object",
      required: ["name", "items"],
      properties: {
        name: { type: "string", description: "Queue name" },
        items: { type: "array", description: "Items to push" },
        priority: { type: "integer", description: "Priority level (higher = processed first)" },
      },
    },
    queryParams: TOKEN_TYPE_QUERY,
    outputExample: {
      ok: true,
      pushed: 1,
      name: "my-queue",
      tokenType: "STX",
    },
  },
  {
    path: "/storage/queue/pop",
    method: "POST",
    category: "storage",
    description: "Pop items from a queue.",
    bodyType: "json",
    bodySchema: {
      type: "object",
      required: ["name"],
      properties: {
        name: { type: "string", description: "Queue name" },
        count: { type: "integer", description: "Number of items to pop (default: 1)" },
      },
    },
    queryParams: TOKEN_TYPE_QUERY,
    outputExample: {
      ok: true,
      items: [{ task: "process data" }],
      count: 1,
      tokenType: "STX",
    },
  },
  {
    path: "/storage/queue/peek",
    method: "GET",
    category: "storage",
    description: "Peek at items in a queue without removing them.",
    queryParams: {
      name: { type: "string", description: "Queue name" },
      count: { type: "integer", description: "Number of items to peek (default: 10)" },
      tokenType: TOKEN_TYPE_PARAM,
    },
    outputExample: {
      ok: true,
      items: [{ task: "process data" }],
      count: 1,
      tokenType: "STX",
    },
  },
  {
    path: "/storage/queue/status",
    method: "GET",
    category: "storage",
    description: "Get queue status (length, oldest item timestamp, etc.).",
    queryParams: {
      name: { type: "string", description: "Queue name" },
      tokenType: TOKEN_TYPE_PARAM,
    },
    outputExample: {
      ok: true,
      name: "my-queue",
      length: 5,
      oldestTimestamp: "2024-01-01T00:00:00.000Z",
      tokenType: "STX",
    },
  },
  {
    path: "/storage/queue/clear",
    method: "POST",
    category: "storage",
    description: "Clear all items from a queue.",
    bodyType: "json",
    bodySchema: {
      type: "object",
      required: ["name"],
      properties: {
        name: { type: "string", description: "Queue name" },
      },
    },
    queryParams: TOKEN_TYPE_QUERY,
    outputExample: {
      ok: true,
      name: "my-queue",
      cleared: true,
      tokenType: "STX",
    },
  },
];

// =============================================================================
// STORAGE - MEMORY ENDPOINTS (5)
// =============================================================================

const memoryEndpoints: EndpointMetadata[] = [
  {
    path: "/storage/memory/store",
    method: "POST",
    category: "storage",
    description: "Store items in vector memory for semantic search.",
    bodyType: "json",
    bodySchema: {
      type: "object",
      required: ["items"],
      properties: {
        items: {
          type: "array",
          items: {
            type: "object",
            required: ["id", "text"],
            properties: {
              id: { type: "string", description: "Unique item ID" },
              text: { type: "string", description: "Text content to index" },
              metadata: { type: "object", description: "Optional metadata" },
            },
          },
        },
      },
    },
    queryParams: TOKEN_TYPE_QUERY,
    outputExample: {
      ok: true,
      stored: 1,
      tokenType: "STX",
    },
  },
  {
    path: "/storage/memory/search",
    method: "POST",
    category: "storage",
    description: "Semantic search across stored memories.",
    bodyType: "json",
    bodySchema: {
      type: "object",
      required: ["query"],
      properties: {
        query: { type: "string", description: "Search query" },
        limit: { type: "integer", description: "Max results (default: 10)" },
      },
    },
    queryParams: TOKEN_TYPE_QUERY,
    outputExample: {
      ok: true,
      results: [
        {
          id: "mem-123",
          text: "This is a test memory.",
          score: 0.95,
          metadata: {},
        },
      ],
      tokenType: "STX",
    },
  },
  {
    path: "/storage/memory/delete",
    method: "POST",
    category: "storage",
    description: "Delete memories by ID.",
    bodyType: "json",
    bodySchema: {
      type: "object",
      required: ["ids"],
      properties: {
        ids: {
          type: "array",
          items: { type: "string" },
          description: "Memory IDs to delete",
        },
      },
    },
    queryParams: TOKEN_TYPE_QUERY,
    outputExample: {
      ok: true,
      deleted: 1,
      tokenType: "STX",
    },
  },
  {
    path: "/storage/memory/list",
    method: "GET",
    category: "storage",
    description: "List all stored memories.",
    queryParams: {
      limit: { type: "integer", description: "Max items (default: 100)" },
      offset: { type: "integer", description: "Pagination offset" },
      tokenType: TOKEN_TYPE_PARAM,
    },
    outputExample: {
      ok: true,
      items: [
        {
          id: "mem-123",
          text: "This is a test memory.",
          createdAt: "2024-01-01T00:00:00.000Z",
        },
      ],
      total: 1,
      tokenType: "STX",
    },
  },
  {
    path: "/storage/memory/clear",
    method: "POST",
    category: "storage",
    description: "Clear all memories.",
    bodyType: "json",
    bodySchema: {
      type: "object",
      properties: {},
    },
    queryParams: TOKEN_TYPE_QUERY,
    outputExample: {
      ok: true,
      cleared: true,
      tokenType: "STX",
    },
  },
];

// =============================================================================
// REGISTRY EXPORT
// =============================================================================

/** All endpoint metadata arrays combined */
const ALL_ENDPOINTS: EndpointMetadata[] = [
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

/**
 * Build a registry key from method and path.
 * Uses "METHOD /path" format to avoid collisions when multiple
 * HTTP methods share the same path (e.g., GET and POST on /storage/kv).
 */
function registryKey(method: string, path: string): string {
  return `${method} ${path}`;
}

/**
 * Complete endpoint metadata registry.
 * Keyed by "METHOD /path" to disambiguate endpoints that share a path.
 */
export const ENDPOINT_METADATA_REGISTRY = new Map<string, EndpointMetadata>(
  ALL_ENDPOINTS.map((e) => [registryKey(e.method, e.path), e])
);

/**
 * Get metadata for an endpoint by path and optional method.
 *
 * When method is provided, performs an exact lookup.
 * When method is omitted, falls back to scanning for any matching path
 * (for backward compatibility).
 *
 * Supports parameterized paths: /stacks/address/SP123... matches /stacks/address/{address}
 */
export function getEndpointMetadata(
  path: string,
  method?: string
): EndpointMetadata | undefined {
  // Exact lookup when method is provided
  if (method) {
    const exact = ENDPOINT_METADATA_REGISTRY.get(registryKey(method, path));
    if (exact) return exact;
  }

  // Scan for matching path (exact or parameterized pattern)
  for (const metadata of ENDPOINT_METADATA_REGISTRY.values()) {
    if (method && metadata.method !== method) continue;

    if (metadata.path === path) return metadata;

    if (metadata.path.includes("{")) {
      const regex = new RegExp(`^${metadata.path.replace(/\{[^}]+\}/g, "[^/]+")}$`);
      if (regex.test(path)) return metadata;
    }
  }

  return undefined;
}
