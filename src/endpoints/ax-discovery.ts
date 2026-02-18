/**
 * AX Discovery Routes
 *
 * Agent Experience (AX) discovery chain for x402.aibtc.com.
 * These routes help AI agents find, understand, and use the x402 Stacks API.
 *
 * Discovery chain:
 *   GET /.well-known/agent.json   — A2A agent card (capabilities, skills, pricing)
 *   GET /llms.txt                 — Quick-start guide (what it is, tiers, how to pay)
 *   GET /llms-full.txt            — Full reference (all endpoints, schemas, examples)
 *   GET /topics                   — Topic documentation index (plaintext)
 *   GET /topics/:topic            — Topic sub-docs (plaintext)
 *
 * For the full aibtc agent platform, see https://aibtc.com/llms.txt
 */

import { Hono } from "hono";
import type { Env, AppVariables } from "../types";

// =============================================================================
// Content Definitions
// =============================================================================

const LLMS_TXT = `# x402 Stacks API

> Pay-per-use API powered by x402 v2 protocol on Stacks blockchain.
> Agents pay per request via STX, sBTC, or USDCx — no API keys needed.

**Production:** https://x402.aibtc.com
**Staging:** https://x402.aibtc.dev
**OpenAPI Spec:** https://x402.aibtc.com/openapi.json
**Agent Card:** https://x402.aibtc.com/.well-known/agent.json

For the full aibtc agent platform (registration, messaging, identity), see https://aibtc.com/llms.txt

## What Is x402?

x402 is an HTTP payment protocol that enables pay-per-use APIs. When a request
lacks payment, the server returns HTTP 402 with payment requirements. The client
signs a Stacks transaction and retries with the payment signature.

This API supports x402 v2 (Coinbase-compatible) with Stacks blockchain payments.

## Pricing Tiers

| Tier     | Cost          | Endpoints                                    |
|----------|---------------|----------------------------------------------|
| free     | 0             | GET /inference/*/models, /, /health, /topics |
| standard | 0.001 STX     | All paid endpoints (hashing, stacks, storage)|
| dynamic  | varies        | OpenRouter LLM (cost + 20% margin)           |

**Token types:** STX, sBTC, USDCx (Circle USDC via xReserve)
Use \`X-PAYMENT-TOKEN-TYPE\` header to select token (default: STX).

Approximate standard pricing:
- 0.001 STX ≈ $0.0005 USD at $0.50/STX
- 0.001 STX ≈ 0.05 satoshis sBTC equivalent
- 0.001 STX ≈ 0.001 USDCx equivalent

## How to Make a Paid Request (x402 v2 Flow)

**Step 1 — Send request without payment:**
\`\`\`
POST https://x402.aibtc.com/hashing/sha256
Content-Type: application/json

{"data": "hello world"}
\`\`\`

**Step 2 — Receive 402 Payment Required:**
\`\`\`
HTTP/1.1 402 Payment Required
payment-required: <base64-encoded PaymentRequiredV2>
\`\`\`

Decode the \`payment-required\` header (base64 JSON) to get:
- \`payTo\`: Stacks address to pay
- \`amount\`: token amount (in microSTX, sats, or microUSDCx)
- \`asset\`: token contract address (for sBTC/USDCx)
- \`network\`: stacks:1 (mainnet) or stacks:2147483648 (testnet)

**Step 3 — Sign and retry:**
\`\`\`
POST https://x402.aibtc.com/hashing/sha256
Content-Type: application/json
payment-signature: <base64-encoded PaymentPayloadV2>

{"data": "hello world"}
\`\`\`

**Step 4 — Success:**
\`\`\`
HTTP/1.1 200 OK
payment-response: <base64-encoded PaymentResponseV2>

{"ok": true, "hash": "b94d27b9934d3e08...", "algorithm": "SHA-256", ...}
\`\`\`

The easiest way to handle this flow: use the AIBTC MCP server's \`execute_x402_endpoint\` tool
— it handles payment signing automatically.

## API Categories

| Category    | Endpoints                                          | Pricing  |
|-------------|---------------------------------------------------|----------|
| inference   | /inference/openrouter/* (100+ models)              | dynamic  |
| inference   | /inference/cloudflare/* (Cloudflare AI models)     | standard |
| stacks      | /stacks/* (address, decode, profile, verify)       | standard |
| hashing     | /hashing/* (sha256, sha512, keccak256, hash160...) | standard |
| storage     | /storage/kv, paste, db, sync, queue, memory        | standard |

## Quick Examples

**SHA-256 hash (most common starting point):**
\`\`\`bash
# Without payment (get 402):
curl -X POST https://x402.aibtc.com/hashing/sha256 \\
  -H "Content-Type: application/json" \\
  -d '{"data": "hello world"}'

# With payment:
curl -X POST https://x402.aibtc.com/hashing/sha256 \\
  -H "Content-Type: application/json" \\
  -H "payment-signature: <base64-PaymentPayloadV2>" \\
  -d '{"data": "hello world"}'
\`\`\`

**List OpenRouter models (free):**
\`\`\`bash
curl https://x402.aibtc.com/inference/openrouter/models
\`\`\`

**Check x402 payment manifest:**
\`\`\`bash
curl https://x402.aibtc.com/x402.json
\`\`\`

## Documentation

- Quick-start (this file): https://x402.aibtc.com/llms.txt
- Full reference: https://x402.aibtc.com/llms-full.txt
- Topic docs index: https://x402.aibtc.com/topics
- OpenAPI spec: https://x402.aibtc.com/openapi.json
- x402 payment manifest: https://x402.aibtc.com/x402.json
- Interactive docs: https://x402.aibtc.com/docs (Swagger UI)

Topic deep-dives:
- Inference: https://x402.aibtc.com/topics/inference
- Hashing: https://x402.aibtc.com/topics/hashing
- Storage: https://x402.aibtc.com/topics/storage
- Payment flow: https://x402.aibtc.com/topics/payment-flow
`;

const LLMS_FULL_TXT = `# x402 Stacks API — Full Reference

> Complete documentation for x402.aibtc.com — pay-per-use API on Stacks blockchain.

**Production:** https://x402.aibtc.com
**Staging:** https://x402.aibtc.dev
**Quick-start:** https://x402.aibtc.com/llms.txt
**OpenAPI spec:** https://x402.aibtc.com/openapi.json

For the full aibtc agent platform, see https://aibtc.com/llms-full.txt

## Payment Architecture

x402 v2 is a Coinbase-compatible HTTP payment protocol. The Stacks blockchain
is used for payment settlement — STX, sBTC (Bitcoin on Stacks), or USDCx (USDC).

### x402 v2 Headers

| Header               | Direction        | Description                                |
|----------------------|------------------|--------------------------------------------|
| payment-required     | server → client  | base64(PaymentRequiredV2) on 402 response  |
| payment-signature    | client → server  | base64(PaymentPayloadV2) on paid request   |
| payment-response     | server → client  | base64(PaymentResponseV2) on success       |
| X-PAYMENT-TOKEN-TYPE | client → server  | Token selection: STX, sBTC, USDCx          |

Legacy headers (still accepted for backward compatibility):
- \`X-PAYMENT\` (replaces payment-signature)
- \`X-PAYMENT-RESPONSE\` (replaces payment-response)

### PaymentRequiredV2 Structure (base64-decoded)

\`\`\`json
{
  "version": 2,
  "payTo": "SP1XXXXXXXXX",
  "amount": "1000",
  "asset": null,
  "network": "stacks:1",
  "extra": {
    "tier": "standard",
    "description": "0.001 STX per request"
  }
}
\`\`\`

### x402.json Discovery Manifest

\`\`\`
GET /x402.json
\`\`\`
Returns machine-readable payment manifest with supported tokens, pricing tiers,
and facilitator URL. Use this to auto-configure x402-stacks clients.

## Pricing

### Standard Tier (all paid endpoints except OpenRouter LLM)

| Token | Amount        | Approximate USD |
|-------|---------------|-----------------|
| STX   | 1000 microSTX | ~$0.0005        |
| sBTC  | 1 satoshi     | ~$0.001         |
| USDCx | 1000 micro    | ~$0.001         |

### Dynamic Tier (OpenRouter LLM only)

OpenRouter cost + 20% margin. Minimum $0.001 USD equivalent.

Formula: \`(input_tokens * model_prompt_cost + output_tokens * model_completion_cost) * 1.20\`

The server estimates tokens before the request and charges accordingly. Pricing
is pre-verified in the 402 response — clients sign the exact quoted amount.

Estimated output tokens = min(max_tokens, input_tokens * 2).

### Token Exchange Rates (approximate, embedded in pricing)

| Token | Rate      |
|-------|-----------|
| STX   | $0.50 USD |
| sBTC  | $100,000 USD (1 BTC) |
| USDCx | $1.00 USD |

## Free Endpoints (No Payment Required)

\`\`\`
GET  /                              — Service info JSON
GET  /health                        — Health check
GET  /docs                          — Swagger UI (interactive docs)
GET  /openapi.json                  — OpenAPI 3.1 spec
GET  /x402.json                     — x402 payment manifest
GET  /dashboard                     — Usage dashboard (HTML)
GET  /llms.txt                      — Quick-start guide (this chain)
GET  /llms-full.txt                 — Full reference (this document)
GET  /topics                        — Topic documentation index
GET  /topics/:topic                 — Topic sub-docs
GET  /.well-known/agent.json        — A2A agent card
GET  /inference/openrouter/models   — List available OpenRouter models
GET  /inference/cloudflare/models   — List available Cloudflare AI models
\`\`\`

## Inference Endpoints

### OpenRouter LLM (Dynamic Pricing)

**List Models (free)**
\`\`\`
GET /inference/openrouter/models
Response: { models: [{ id, name, description, context_length, pricing }] }
\`\`\`

**Chat Completion (dynamic pricing)**
\`\`\`
POST /inference/openrouter/chat
Content-Type: application/json
payment-signature: <base64-PaymentPayloadV2>
X-PAYMENT-TOKEN-TYPE: STX  (optional, default STX)

Request body:
{
  "model": "anthropic/claude-3-haiku",  // required
  "messages": [                          // required
    { "role": "system", "content": "You are helpful." },
    { "role": "user", "content": "Hello!" }
  ],
  "temperature": 0.7,       // optional, 0-2
  "max_tokens": 1024,        // optional
  "stream": false,           // optional, default false
  "top_p": 1.0,              // optional
  "frequency_penalty": 0,    // optional
  "presence_penalty": 0,     // optional
  "stop": null               // optional, string or array
}

Response (OpenAI-compatible):
{
  "id": "chatcmpl-xxx",
  "model": "anthropic/claude-3-haiku",
  "choices": [{
    "index": 0,
    "message": { "role": "assistant", "content": "Hello! How can I help?" },
    "finish_reason": "stop"
  }],
  "usage": { "prompt_tokens": 20, "completion_tokens": 12, "total_tokens": 32 }
}
\`\`\`

Pricing is estimated before the request. The 402 response includes the quoted amount.
Dynamic models include: openai/gpt-4o, anthropic/claude-3-haiku, google/gemini-pro,
meta-llama/llama-3.1-70b-instruct, mistralai/mistral-7b-instruct, and 100+ more.
See /inference/openrouter/models for the full list.

### Cloudflare AI (Standard Pricing)

**List Models (free)**
\`\`\`
GET /inference/cloudflare/models
Response: { models: [{ id, name, description }] }
\`\`\`

**Chat Completion (0.001 STX)**
\`\`\`
POST /inference/cloudflare/chat
Request: same format as OpenRouter (model must be a @cf/ model id)
Response: OpenAI-compatible chat completion
\`\`\`

Topic doc: https://x402.aibtc.com/topics/inference

## Stacks Endpoints (Standard Pricing: 0.001 STX each)

### Address Convert

\`\`\`
GET /stacks/address/:address
Path param: :address — any Stacks or Bitcoin address

Response:
{
  "ok": true,
  "input": "bc1q...",
  "stxAddress": "SP...",
  "btcAddress": "bc1q...",
  "tokenType": "STX"
}
\`\`\`

### Decode Clarity Value

\`\`\`
POST /stacks/decode/clarity
{
  "hex": "0x0100000000000000000000000000000001"  // Clarity-encoded hex
}
Response:
{
  "ok": true,
  "decoded": { "type": "uint", "value": "1" },
  "tokenType": "STX"
}
\`\`\`

### Decode Transaction

\`\`\`
POST /stacks/decode/transaction
{
  "hex": "0x8080000000040..."  // Raw serialized Stacks transaction hex
}
Response: { "ok": true, "transaction": { ...decoded tx fields }, "tokenType": "STX" }
\`\`\`

### Profile Lookup

\`\`\`
GET /stacks/profile/:address
Path param: :address — Stacks address (SP...)

Response:
{
  "ok": true,
  "address": "SP...",
  "profile": { "name": "...", "description": "..." },
  "tokenType": "STX"
}
\`\`\`

### Verify BIP-137 Message

\`\`\`
POST /stacks/verify/message
{
  "message": "Hello world",
  "signature": "...",    // BIP-137 Bitcoin signature
  "address": "bc1q..."   // Bitcoin address (optional, for verification)
}
Response: { "ok": true, "valid": true, "address": "bc1q...", "tokenType": "STX" }
\`\`\`

### Verify SIP-018 Structured Data

\`\`\`
POST /stacks/verify/sip018
{
  "domain": { "name": "App", "version": "1.0.0", "chainId": 1 },
  "message": { "amount": 100 },
  "signature": "...",
  "publicKey": "02..."
}
Response: { "ok": true, "valid": true, "signer": "SP...", "tokenType": "STX" }
\`\`\`

## Hashing Endpoints (Standard Pricing: 0.001 STX each)

All hashing endpoints use the same request/response format:

\`\`\`
POST /hashing/{algorithm}
{
  "data": "hello world",  // text, or hex with 0x prefix for binary data
  "encoding": "hex"       // optional: "hex" (default) or "base64"
}

Response:
{
  "ok": true,
  "hash": "b94d27b9934d3e08a52e52d7da7dabfac484efe04294e576c4d552b5b03e82a",
  "algorithm": "SHA-256",
  "encoding": "hex",
  "inputLength": 11,
  "tokenType": "STX"
}
\`\`\`

**Available algorithms:**

| Endpoint                | Algorithm  | Output  | Clarity-compatible |
|-------------------------|------------|---------|--------------------|
| POST /hashing/sha256    | SHA-256    | 32 bytes | Yes (hash160 uses this) |
| POST /hashing/sha512    | SHA-512    | 64 bytes | Yes               |
| POST /hashing/sha512-256| SHA-512/256| 32 bytes | Yes (Stacks tx hashing) |
| POST /hashing/keccak256 | Keccak-256 | 32 bytes | Yes               |
| POST /hashing/hash160   | HASH160    | 20 bytes | Yes (Bitcoin address derivation) |
| POST /hashing/ripemd160 | RIPEMD-160 | 20 bytes | Yes               |

HASH160 = RIPEMD-160(SHA-256(input)) — same as Bitcoin's hash160 used in P2PKH addresses.

Topic doc: https://x402.aibtc.com/topics/hashing

## Storage Endpoints (Standard Pricing: 0.001 STX each)

All storage is scoped to the paying agent's Stacks address (derived from payment signature).
Each payer gets isolated storage in a Durable Object keyed by their Stacks address.

### KV Store

\`\`\`
POST   /storage/kv              — Set value
GET    /storage/kv/:key         — Get value
DELETE /storage/kv/:key         — Delete value
GET    /storage/kv              — List keys

POST /storage/kv
{ "key": "my-key", "value": "my-value", "metadata": {}, "ttl": 3600 }
Response: { "ok": true, "key": "my-key", "created": true, "tokenType": "STX" }

GET /storage/kv/:key
Response: { "ok": true, "key": "my-key", "value": "my-value", "metadata": {}, "tokenType": "STX" }

GET /storage/kv
Response: { "ok": true, "keys": [{ "key": "...", "metadata": {} }], "tokenType": "STX" }
\`\`\`

### Paste Bin

\`\`\`
POST   /storage/paste           — Create paste
GET    /storage/paste/:id       — Get paste
DELETE /storage/paste/:id       — Delete paste

POST /storage/paste
{ "content": "...", "title": "optional", "language": "typescript", "ttl": 86400 }
Response: { "ok": true, "id": "paste-uuid", "createdAt": "...", "expiresAt": "...", "tokenType": "STX" }
\`\`\`

### SQL Database

\`\`\`
POST /storage/db/query          — Read-only SQL query
POST /storage/db/execute        — Mutating SQL statement
GET  /storage/db/schema         — Schema introspection

POST /storage/db/query
{ "sql": "SELECT * FROM items WHERE id = ?", "params": [42] }
Response: { "ok": true, "rows": [...], "rowCount": 1, "tokenType": "STX" }

POST /storage/db/execute
{ "sql": "INSERT INTO items (name) VALUES (?)", "params": ["test"] }
Response: { "ok": true, "rowsAffected": 1, "lastInsertRowid": 1, "tokenType": "STX" }
\`\`\`
SQLite-compatible. Each payer has their own isolated SQLite database.

### Distributed Sync / Locks

\`\`\`
POST /storage/sync/lock         — Acquire lock
POST /storage/sync/unlock       — Release lock
POST /storage/sync/extend       — Extend lock TTL
GET  /storage/sync/status/:name — Check lock status
GET  /storage/sync/list         — List active locks

POST /storage/sync/lock
{ "name": "my-resource", "ttl": 60 }  // ttl: 10-300 seconds, default 60
Response: { "ok": true, "acquired": true, "token": "lock-token-uuid", ... }

POST /storage/sync/unlock
{ "name": "my-resource", "token": "lock-token-uuid" }
Response: { "ok": true, "released": true, ... }
\`\`\`
Used to coordinate concurrent agent processes. Lock tokens prevent unauthorized unlocks.

### Job Queue

\`\`\`
POST /storage/queue/push        — Enqueue job
POST /storage/queue/pop         — Dequeue job (removes from queue)
GET  /storage/queue/peek        — View next job (does not remove)
GET  /storage/queue/status      — Queue stats
POST /storage/queue/clear       — Clear all queued jobs

POST /storage/queue/push
{ "data": { "taskId": "abc", "type": "email" }, "priority": 5 }
Response: { "ok": true, "id": "job-uuid", "position": 1, ... }

POST /storage/queue/pop
Response: { "ok": true, "job": { "id": "...", "data": {...} }, ... }
\`\`\`

### Vector Memory (Semantic Search)

\`\`\`
POST /storage/memory/store      — Store items with embeddings
POST /storage/memory/search     — Semantic similarity search
POST /storage/memory/delete     — Delete items by id
GET  /storage/memory/list       — List stored items
POST /storage/memory/clear      — Delete all items

POST /storage/memory/store
{
  "items": [
    { "id": "doc-1", "text": "Paris is the capital of France", "metadata": { "source": "wiki" } }
  ]
}
Response: { "ok": true, "stored": 1, "tokenType": "STX" }

POST /storage/memory/search
{ "query": "What is the capital of France?", "topK": 5 }
Response: { "ok": true, "results": [{ "id": "doc-1", "text": "...", "score": 0.92 }], ... }
\`\`\`
Uses Cloudflare AI (BAAI/bge-base-en-v1.5) for embeddings. Cosine similarity search.

Topic doc: https://x402.aibtc.com/topics/storage

## Payment Flow Deep-Dive

Topic doc: https://x402.aibtc.com/topics/payment-flow

## Topic Documentation

| Topic        | URL                                          | Contents                                    |
|--------------|----------------------------------------------|---------------------------------------------|
| inference    | https://x402.aibtc.com/topics/inference      | OpenRouter + Cloudflare AI, dynamic pricing |
| hashing      | https://x402.aibtc.com/topics/hashing        | All hash endpoints with examples            |
| storage      | https://x402.aibtc.com/topics/storage        | KV, paste, db, sync, queue, memory patterns |
| payment-flow | https://x402.aibtc.com/topics/payment-flow   | x402 v2 challenge/response flow in detail  |

## Error Handling

All endpoints return structured errors:
\`\`\`json
{ "ok": false, "error": "description", "tokenType": "STX" }
\`\`\`

| Status | Meaning                                          |
|--------|--------------------------------------------------|
| 400    | Bad request (missing required fields, etc.)      |
| 402    | Payment required (x402 challenge response)       |
| 404    | Not found (key, paste, job, lock does not exist) |
| 500    | Server error (upstream API, Durable Object, etc) |

## Related

- AIBTC platform hub: https://aibtc.com/llms.txt
- x402 protocol spec: https://www.x402.org/
- x402-stacks npm: https://www.npmjs.com/package/x402-stacks
- Stacks.js: https://docs.stacks.co/stacks.js
`;

// Topic sub-docs

const INFERENCE_DOC = `# x402 Inference Endpoints

Deep-dive reference for /inference/* endpoints at x402.aibtc.com.

Full reference: https://x402.aibtc.com/llms-full.txt
OpenAPI spec: https://x402.aibtc.com/openapi.json

## Overview

Two inference providers are available:

1. **OpenRouter** — 100+ models (GPT-4o, Claude, Gemini, Llama, etc.) with dynamic pricing
2. **Cloudflare AI** — Cloudflare-hosted models with standard fixed pricing

## Pricing

OpenRouter endpoints use **dynamic pricing**:
- Cost = (input_tokens * model_prompt_cost + output_tokens * model_completion_cost) * 1.20
- Minimum payment: $0.001 USD equivalent in your selected token
- Estimate is computed before the request and included in the 402 response

Cloudflare AI endpoints use **standard pricing**: 0.001 STX per request.

## Model Selection (OpenRouter)

GET /inference/openrouter/models   (free, no payment)

Returns list of available models with pricing info. Use model IDs like:
- openai/gpt-4o
- openai/gpt-4o-mini
- anthropic/claude-3-haiku
- anthropic/claude-3.5-sonnet
- google/gemini-pro
- meta-llama/llama-3.1-70b-instruct
- mistralai/mistral-7b-instruct

## Chat Completion Request Schema

Both providers use the same OpenAI-compatible format:

\`\`\`json
{
  "model": "anthropic/claude-3-haiku",
  "messages": [
    { "role": "system", "content": "You are a helpful assistant." },
    { "role": "user", "content": "Summarize the x402 protocol in one sentence." }
  ],
  "temperature": 0.7,
  "max_tokens": 256,
  "stream": false
}
\`\`\`

Optional fields: temperature (0-2), max_tokens, stream (false only for x402),
top_p, frequency_penalty, presence_penalty, stop (string or array).

## Chat Completion Response Schema

\`\`\`json
{
  "id": "chatcmpl-abc123",
  "model": "anthropic/claude-3-haiku",
  "choices": [{
    "index": 0,
    "message": { "role": "assistant", "content": "x402 is an HTTP payment protocol..." },
    "finish_reason": "stop"
  }],
  "usage": {
    "prompt_tokens": 35,
    "completion_tokens": 18,
    "total_tokens": 53
  }
}
\`\`\`

## Example: Paid Chat with OpenRouter

Step 1 — Initial request (returns 402):
\`\`\`bash
curl -X POST https://x402.aibtc.com/inference/openrouter/chat \\
  -H "Content-Type: application/json" \\
  -d '{
    "model": "anthropic/claude-3-haiku",
    "messages": [{"role": "user", "content": "Hello!"}]
  }'
# → 402 with payment-required header
\`\`\`

Step 2 — Sign payment and retry:
\`\`\`bash
curl -X POST https://x402.aibtc.com/inference/openrouter/chat \\
  -H "Content-Type: application/json" \\
  -H "payment-signature: <base64-PaymentPayloadV2>" \\
  -d '{
    "model": "anthropic/claude-3-haiku",
    "messages": [{"role": "user", "content": "Hello!"}]
  }'
\`\`\`

## PnL Tracking

After each OpenRouter completion, the actual token usage from OpenRouter is
compared to the pre-estimated amount. Differences are logged for margin analysis.
The 20% margin covers estimation variance and provides sustainability.

## Token Type Selection

Add header to select payment token (default: STX):
\`\`\`
X-PAYMENT-TOKEN-TYPE: sBTC
\`\`\`

Supported: STX, sBTC, USDCx

## Related

Full reference: https://x402.aibtc.com/llms-full.txt
`;

const HASHING_DOC = `# x402 Hashing Endpoints

Deep-dive reference for /hashing/* endpoints at x402.aibtc.com.

Full reference: https://x402.aibtc.com/llms-full.txt
OpenAPI spec: https://x402.aibtc.com/openapi.json

## Overview

Six Clarity-compatible hashing functions, all with standard pricing (0.001 STX per request).

## Request Format (all endpoints)

\`\`\`
POST /hashing/{algorithm}
Content-Type: application/json
payment-signature: <base64-PaymentPayloadV2>

{
  "data": "hello world",   // required: text or hex with 0x prefix
  "encoding": "hex"        // optional: "hex" (default) or "base64"
}
\`\`\`

**Binary data:** Pass hex with \`0x\` prefix: \`{ "data": "0xdeadbeef" }\`

## Response Format (all endpoints)

\`\`\`json
{
  "ok": true,
  "hash": "b94d27b9934d3e08a52e52d7da7dabfac484efe04294e576c4d552b5b03e82a",
  "algorithm": "SHA-256",
  "encoding": "hex",
  "inputLength": 11,
  "tokenType": "STX"
}
\`\`\`

## Algorithms

### SHA-256
\`\`\`
POST /hashing/sha256
\`\`\`
Standard SHA-256. Uses SubtleCrypto. 32-byte output.
Clarity equivalent: \`(sha256 input)\`

### SHA-512
\`\`\`
POST /hashing/sha512
\`\`\`
SHA-512. 64-byte output.
Clarity equivalent: \`(sha512 input)\`

### SHA-512/256
\`\`\`
POST /hashing/sha512-256
\`\`\`
SHA-512 truncated to 256 bits. 32-byte output.
Used in Stacks transaction hashing.
Clarity equivalent: \`(sha512/256 input)\`

### Keccak-256
\`\`\`
POST /hashing/keccak256
\`\`\`
Ethereum-compatible Keccak-256 (NOT SHA3-256). 32-byte output.
Note: This is Keccak-256, not the NIST SHA3-256 standardized variant.
Clarity equivalent: \`(keccak256 input)\`

### HASH160
\`\`\`
POST /hashing/hash160
\`\`\`
HASH160 = RIPEMD-160(SHA-256(input)). 20-byte output.
Bitcoin P2PKH address derivation uses this on public keys.
Clarity equivalent: \`(hash160 input)\`

### RIPEMD-160
\`\`\`
POST /hashing/ripemd160
\`\`\`
Standalone RIPEMD-160. 20-byte output.
Clarity equivalent: \`(ripemd160 input)\`

## Examples

SHA-256 of "hello world":
\`\`\`bash
curl -X POST https://x402.aibtc.com/hashing/sha256 \\
  -H "Content-Type: application/json" \\
  -H "payment-signature: <base64-PaymentPayloadV2>" \\
  -d '{"data": "hello world"}'
# → {"ok":true,"hash":"b94d27b9934d3e08...","algorithm":"SHA-256",...}
\`\`\`

Hash of binary data (base64 output):
\`\`\`bash
curl -X POST https://x402.aibtc.com/hashing/sha256 \\
  -H "Content-Type: application/json" \\
  -H "payment-signature: <base64-PaymentPayloadV2>" \\
  -d '{"data": "0xdeadbeef", "encoding": "base64"}'
\`\`\`

## Clarity Compatibility

All hash functions produce identical output to Clarity's built-in hash functions.
This allows off-chain pre-computation of hashes that will match on-chain Clarity results.

Use case: Generate a hash off-chain, compare with on-chain hash in a Clarity contract.

## Related

Full reference: https://x402.aibtc.com/llms-full.txt
`;

const STORAGE_DOC = `# x402 Storage Endpoints

Deep-dive reference for /storage/* endpoints at x402.aibtc.com.

Full reference: https://x402.aibtc.com/llms-full.txt
OpenAPI spec: https://x402.aibtc.com/openapi.json

## Overview

Six storage systems, all backed by Cloudflare Durable Objects with SQLite.
All storage is **scoped to the paying agent's Stacks address** — each payer
gets completely isolated storage.

Pricing: 0.001 STX per request (all storage operations).

## Storage Isolation

Storage is keyed by the payer's Stacks address extracted from the payment signature.
Two agents paying with different Stacks addresses cannot access each other's data.
One Durable Object instance per Stacks address — fully isolated SQLite storage.

## KV Store (/storage/kv)

Simple key-value storage with optional metadata and TTL.

\`\`\`
POST   /storage/kv              — Set value
GET    /storage/kv/:key         — Get value
DELETE /storage/kv/:key         — Delete value
GET    /storage/kv              — List all keys
\`\`\`

**Set:**
\`\`\`json
POST /storage/kv
{ "key": "config", "value": "production", "metadata": {"env": "prod"}, "ttl": 3600 }
Response: { "ok": true, "key": "config", "created": true, "tokenType": "STX" }
\`\`\`

**Get:**
\`\`\`json
GET /storage/kv/config
Response: { "ok": true, "key": "config", "value": "production", "metadata": {...}, "tokenType": "STX" }
\`\`\`

**List:**
\`\`\`json
GET /storage/kv
Response: { "ok": true, "keys": [{ "key": "config", "metadata": {...} }], "tokenType": "STX" }
\`\`\`

## Paste Bin (/storage/paste)

Store and retrieve text pastes with optional syntax highlighting metadata.

\`\`\`
POST   /storage/paste           — Create paste → returns UUID
GET    /storage/paste/:id       — Get paste by UUID
DELETE /storage/paste/:id       — Delete paste
\`\`\`

**Create:**
\`\`\`json
POST /storage/paste
{ "content": "const x = 42;", "title": "snippet", "language": "typescript", "ttl": 86400 }
Response: { "ok": true, "id": "550e8400-e29b...", "createdAt": "...", "expiresAt": "...", "tokenType": "STX" }
\`\`\`

## SQL Database (/storage/db)

Per-agent SQLite database accessible via parameterized queries.

\`\`\`
POST /storage/db/query          — SELECT (read-only)
POST /storage/db/execute        — INSERT/UPDATE/DELETE/CREATE TABLE
GET  /storage/db/schema         — List tables and columns
\`\`\`

**Query:**
\`\`\`json
POST /storage/db/query
{ "sql": "SELECT * FROM tasks WHERE done = ?", "params": [false] }
Response: { "ok": true, "rows": [...], "rowCount": 3, "tokenType": "STX" }
\`\`\`

**Execute:**
\`\`\`json
POST /storage/db/execute
{ "sql": "CREATE TABLE IF NOT EXISTS tasks (id INTEGER PRIMARY KEY, name TEXT, done BOOLEAN)" }
Response: { "ok": true, "rowsAffected": 0, "lastInsertRowid": 0, "tokenType": "STX" }
\`\`\`

Lifecycle: CREATE TABLE → INSERT → SELECT → UPDATE → DELETE

## Sync / Distributed Locks (/storage/sync)

Named distributed locks for coordinating concurrent agent processes.

\`\`\`
POST /storage/sync/lock         — Acquire lock → returns token
POST /storage/sync/unlock       — Release lock (requires token)
POST /storage/sync/extend       — Extend lock TTL (requires token)
GET  /storage/sync/status/:name — Check lock status
GET  /storage/sync/list         — List all active locks
\`\`\`

**Lock:**
\`\`\`json
POST /storage/sync/lock
{ "name": "deploy-job", "ttl": 120 }
Response: { "ok": true, "acquired": true, "token": "lock-token-uuid", "expiresAt": "..." }
\`\`\`
If lock is held: \`{ "ok": true, "acquired": false, "holder": "...", "expiresAt": "..." }\`

**Unlock:**
\`\`\`json
POST /storage/sync/unlock
{ "name": "deploy-job", "token": "lock-token-uuid" }
Response: { "ok": true, "released": true }
\`\`\`

TTL range: 10-300 seconds. Default: 60 seconds.

## Queue (/storage/queue)

Persistent FIFO job queue with priority support.

\`\`\`
POST /storage/queue/push        — Enqueue (returns position)
POST /storage/queue/pop         — Dequeue and remove (atomic)
GET  /storage/queue/peek        — View next without removing
GET  /storage/queue/status      — Queue statistics
POST /storage/queue/clear       — Remove all jobs
\`\`\`

**Push:**
\`\`\`json
POST /storage/queue/push
{ "data": { "type": "email", "to": "agent@example.com" }, "priority": 5 }
Response: { "ok": true, "id": "job-uuid", "position": 3, "tokenType": "STX" }
\`\`\`

**Pop:**
\`\`\`json
POST /storage/queue/pop
Response: { "ok": true, "job": { "id": "...", "data": {...}, "priority": 5 }, "remaining": 2, "tokenType": "STX" }
\`\`\`

## Vector Memory (/storage/memory)

Semantic memory with vector embeddings for similarity search.
Embeddings generated by Cloudflare AI: BAAI/bge-base-en-v1.5 (768-dim).

\`\`\`
POST /storage/memory/store      — Store items with auto-generated embeddings
POST /storage/memory/search     — Semantic similarity search (cosine)
POST /storage/memory/delete     — Delete items by ID
GET  /storage/memory/list       — List stored items (no embeddings)
POST /storage/memory/clear      — Delete all items
\`\`\`

**Store:**
\`\`\`json
POST /storage/memory/store
{
  "items": [
    { "id": "fact-1", "text": "The x402 protocol uses HTTP 402 for payment", "metadata": {"topic": "x402"} },
    { "id": "fact-2", "text": "Stacks blockchain settles on Bitcoin L1", "metadata": {"topic": "stacks"} }
  ]
}
Response: { "ok": true, "stored": 2, "tokenType": "STX" }
\`\`\`

**Search:**
\`\`\`json
POST /storage/memory/search
{ "query": "How does x402 payment work?", "topK": 3 }
Response: {
  "ok": true,
  "results": [
    { "id": "fact-1", "text": "...", "score": 0.94, "metadata": {"topic": "x402"} }
  ],
  "tokenType": "STX"
}
\`\`\`

Score is cosine similarity (0-1, higher = more similar).

## Agent Memory Lifecycle Pattern

\`\`\`
1. Store knowledge:  POST /storage/memory/store  (items array)
2. Retrieve memory:  POST /storage/memory/search (semantic query + topK)
3. Check inventory:  GET  /storage/memory/list
4. Remove outdated:  POST /storage/memory/delete (ids array)
5. Full reset:       POST /storage/memory/clear
\`\`\`

## Related

Full reference: https://x402.aibtc.com/llms-full.txt
`;

const PAYMENT_FLOW_DOC = `# x402 Payment Flow

Deep-dive reference for the x402 v2 payment challenge/response flow.

Full reference: https://x402.aibtc.com/llms-full.txt
x402 protocol spec: https://www.x402.org/

## Overview

x402 v2 is a stateless HTTP payment protocol. The server never holds client funds —
payments are Stacks blockchain transactions signed by the client.

The flow is:
1. Client sends request WITHOUT payment → server returns 402
2. Server response includes payment requirements (amount, recipient, token)
3. Client creates and signs a Stacks transaction
4. Client retries request WITH signed transaction → server verifies and processes

## Step 1: Initial Request (No Payment)

\`\`\`http
POST /hashing/sha256 HTTP/1.1
Host: x402.aibtc.com
Content-Type: application/json

{"data": "hello world"}
\`\`\`

Server response:
\`\`\`http
HTTP/1.1 402 Payment Required
payment-required: eyJ2ZXJzaW9uIjoyLCJwYXlUbyI6IlNQMVhYWC4uLiJ9...
Content-Type: application/json

{"error": "payment required"}
\`\`\`

## Step 2: Decode Payment Requirements

The \`payment-required\` header is a base64-encoded JSON object:

\`\`\`json
{
  "version": 2,
  "payTo": "SP1XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX",
  "amount": "1000",
  "asset": null,
  "network": "stacks:1",
  "extra": {
    "tier": "standard",
    "description": "0.001 STX per request",
    "relay": "https://x402-relay.aibtc.com"
  }
}
\`\`\`

Fields:
- \`payTo\`: Stacks address to pay (SP... for mainnet, ST... for testnet)
- \`amount\`: Amount in base units (microSTX for STX, satoshis for sBTC, microUSDCx for USDCx)
- \`asset\`: null for STX, contract principal for sBTC/USDCx
- \`network\`: "stacks:1" (mainnet), "stacks:2147483648" (testnet)
- \`extra.relay\`: URL of the settlement relay that verifies and broadcasts the transaction

## Step 3: Build Payment Payload

For STX payments:
1. Build a Stacks STX transfer transaction: payTo = SP..., amount = 1000 microSTX
2. Sign with your Stacks private key
3. Serialize the signed transaction to hex

For sBTC payments:
1. Build a contract-call to the sBTC contract's \`transfer\` function
2. Sign with your Stacks private key
3. Serialize to hex

Wrap in PaymentPayloadV2:
\`\`\`json
{
  "version": 2,
  "transaction": "0x8080000000040a...",  // hex-encoded signed Stacks tx
  "network": "stacks:1"
}
\`\`\`

Base64-encode this JSON to get the payment-signature value.

## Step 4: Retry With Payment

\`\`\`http
POST /hashing/sha256 HTTP/1.1
Host: x402.aibtc.com
Content-Type: application/json
payment-signature: eyJ2ZXJzaW9uIjoyLCJ0cmFuc2FjdGlvbiI6IjB4ODA4MC4uLiJ9...

{"data": "hello world"}
\`\`\`

## Step 5: Server Verifies and Responds

The server:
1. Decodes the \`payment-signature\` header
2. Validates the transaction (correct payTo, amount, token type)
3. Submits to the settlement relay for on-chain settlement
4. Processes the request
5. Returns result with \`payment-response\` header

\`\`\`http
HTTP/1.1 200 OK
payment-response: eyJ2ZXJzaW9uIjoyLCJ0eElkIjoiMHhhYmMxMjMuLi4ifQ==
Content-Type: application/json

{"ok": true, "hash": "b94d27b9...", "algorithm": "SHA-256", ...}
\`\`\`

Decode \`payment-response\` to get transaction ID:
\`\`\`json
{ "version": 2, "txId": "0xabc123..." }
\`\`\`

## Token Types

### STX (default)
- Amount unit: microSTX (1 STX = 1,000,000 microSTX)
- Standard tier: 1000 microSTX = 0.001 STX
- No asset field needed (native token)

### sBTC
- Amount unit: satoshis (1 BTC = 100,000,000 sats)
- Transaction: contract-call to sBTC contract transfer function
- Specify with: X-PAYMENT-TOKEN-TYPE: sBTC header

### USDCx (Circle USDC via xReserve)
- Amount unit: microUSDCx (1 USDCx = 1,000,000 microUSDCx)
- Standard tier: 1000 microUSDCx = 0.001 USDCx
- Specify with: X-PAYMENT-TOKEN-TYPE: USDCx header

## Using x402-stacks Library

The \`x402-stacks\` npm package handles all signing and verification:

\`\`\`typescript
import { X402Client } from "x402-stacks";

const client = new X402Client({
  privateKey: "your-stacks-private-key",
  network: "mainnet"
});

const response = await client.request({
  url: "https://x402.aibtc.com/hashing/sha256",
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ data: "hello world" }),
  tokenType: "STX"
});
\`\`\`

## Using AIBTC MCP Server

The AIBTC MCP server's \`execute_x402_endpoint\` tool handles the full flow:

\`\`\`
execute_x402_endpoint({
  endpoint: "https://x402.aibtc.com/hashing/sha256",
  method: "POST",
  body: { data: "hello world" },
  tokenType: "STX"
})
\`\`\`

## Settlement Relay

The settlement relay validates and broadcasts transactions:
- Mainnet: https://x402-relay.aibtc.com
- The relay verifies the transaction locally and broadcasts directly to the Stacks network

## x402 Discovery Manifest

\`\`\`
GET /x402.json
\`\`\`

Machine-readable payment configuration. Use this to auto-configure x402-stacks:
\`\`\`json
{
  "version": 2,
  "network": "mainnet",
  "payTo": "SP...",
  "tokens": ["STX", "sBTC", "USDCx"],
  "relay": "https://x402-relay.aibtc.com",
  "endpoints": [...]
}
\`\`\`

## Related

Full reference: https://x402.aibtc.com/llms-full.txt
x402-stacks npm: https://www.npmjs.com/package/x402-stacks
x402 protocol: https://www.x402.org/
`;

// Topic docs map
const TOPIC_DOCS: Record<string, string> = {
  inference: INFERENCE_DOC,
  hashing: HASHING_DOC,
  storage: STORAGE_DOC,
  "payment-flow": PAYMENT_FLOW_DOC,
};

// Agent card
const AGENT_CARD = {
  name: "x402 Stacks API",
  description:
    "Pay-per-use API powered by x402 v2 protocol on Stacks blockchain. " +
    "Agents pay per request via STX, sBTC, or USDCx — no API keys or accounts needed. " +
    "Provides inference (LLM), hashing, Stacks utilities, and agent storage.",
  url: "https://x402.aibtc.com",
  provider: {
    organization: "AIBTC Working Group",
    url: "https://aibtc.com",
  },
  version: "2.0.0",
  documentationUrl: "https://x402.aibtc.com/llms.txt",
  openApiUrl: "https://x402.aibtc.com/openapi.json",
  documentation: {
    quickStart: "https://x402.aibtc.com/llms.txt",
    fullReference: "https://x402.aibtc.com/llms-full.txt",
    openApiSpec: "https://x402.aibtc.com/openapi.json",
    x402Manifest: "https://x402.aibtc.com/x402.json",
    platform: "https://aibtc.com/llms.txt",
    topicDocs: {
      index: "https://x402.aibtc.com/topics",
      inference: "https://x402.aibtc.com/topics/inference",
      hashing: "https://x402.aibtc.com/topics/hashing",
      storage: "https://x402.aibtc.com/topics/storage",
      paymentFlow: "https://x402.aibtc.com/topics/payment-flow",
    },
  },
  capabilities: {
    streaming: false,
    pushNotifications: false,
    stateTransitionHistory: false,
  },
  authentication: {
    schemes: ["x402v2"],
    credentials: null,
  },
  defaultInputModes: ["application/json"],
  defaultOutputModes: ["application/json"],
  payment: {
    protocol: "x402",
    version: 2,
    network: "stacks",
    tokens: ["STX", "sBTC", "USDCx"],
    tiers: {
      free: {
        amount: "0",
        description: "Model listings, health, docs",
        endpoints: [
          "GET /inference/openrouter/models",
          "GET /inference/cloudflare/models",
          "GET /",
          "GET /health",
          "GET /docs",
          "GET /openapi.json",
          "GET /x402.json",
          "GET /dashboard",
          "GET /llms.txt",
          "GET /llms-full.txt",
          "GET /topics",
          "GET /topics/:topic",
          "GET /.well-known/agent.json",
        ],
      },
      standard: {
        amount: "0.001 STX",
        description: "All paid endpoints (hashing, stacks, storage, Cloudflare AI)",
        endpoints: [
          "POST /inference/cloudflare/chat",
          "GET|POST|DELETE /stacks/*",
          "POST /hashing/*",
          "GET|POST|DELETE /storage/*",
        ],
      },
      dynamic: {
        description: "OpenRouter LLM — pass-through cost + 20% margin",
        endpoints: ["POST /inference/openrouter/chat"],
        formula: "(input_tokens * prompt_cost + output_tokens * completion_cost) * 1.20",
        minimum: "$0.001 USD equivalent",
      },
    },
    headers: {
      request: "payment-signature",
      response: "payment-response",
      required: "payment-required",
      tokenType: "X-PAYMENT-TOKEN-TYPE",
    },
  },
  skills: [
    {
      id: "llm-inference",
      name: "LLM Inference (OpenRouter)",
      description:
        "Access 100+ LLM models via OpenRouter with dynamic pricing. " +
        "POST /inference/openrouter/chat with model and messages. " +
        "Pricing is dynamic: model cost + 20% margin. " +
        "First request returns 402 with payment amount. " +
        "Retry with payment-signature header for completion.",
      tags: ["inference", "llm", "openrouter", "chat", "gpt", "claude", "llama"],
      examples: [
        "Generate text with GPT-4o",
        "Chat with Claude via x402 payment",
        "Use Llama 3 with STX payment",
      ],
      inputModes: ["application/json"],
      outputModes: ["application/json"],
    },
    {
      id: "cloudflare-inference",
      name: "LLM Inference (Cloudflare AI)",
      description:
        "Cloudflare-hosted AI models at standard fixed pricing (0.001 STX). " +
        "POST /inference/cloudflare/chat with @cf/ model id and messages.",
      tags: ["inference", "llm", "cloudflare", "ai", "chat"],
      examples: ["Run inference on Cloudflare AI models"],
      inputModes: ["application/json"],
      outputModes: ["application/json"],
    },
    {
      id: "hashing",
      name: "Clarity-Compatible Hashing",
      description:
        "Six Clarity-compatible hash functions: SHA-256, SHA-512, SHA-512/256, " +
        "Keccak-256, HASH160, RIPEMD-160. " +
        "Outputs match Clarity built-in hash functions for on-chain verification. " +
        "POST /hashing/{algorithm} with { data, encoding }. Standard pricing (0.001 STX).",
      tags: ["hashing", "sha256", "sha512", "keccak256", "hash160", "ripemd160", "clarity"],
      examples: [
        "Hash data with SHA-256 (Clarity-compatible)",
        "Compute HASH160 for Bitcoin address derivation",
        "Keccak-256 hash for Ethereum compatibility",
      ],
      inputModes: ["application/json"],
      outputModes: ["application/json"],
    },
    {
      id: "stacks-utilities",
      name: "Stacks Blockchain Utilities",
      description:
        "Stacks/Bitcoin address conversion, Clarity value decoding, " +
        "transaction decoding, profile lookup, BIP-137 message verification, " +
        "and SIP-018 structured data verification. Standard pricing (0.001 STX).",
      tags: ["stacks", "bitcoin", "address", "clarity", "verification", "sip018"],
      examples: [
        "Convert Bitcoin address to Stacks address",
        "Decode Clarity value from hex",
        "Verify a BIP-137 signed message",
        "Verify SIP-018 structured data signature",
      ],
      inputModes: ["application/json"],
      outputModes: ["application/json"],
    },
    {
      id: "kv-storage",
      name: "Agent KV Storage",
      description:
        "Isolated key-value storage scoped to paying agent's Stacks address. " +
        "CRUD operations: GET/POST/DELETE /storage/kv. " +
        "Optional metadata and TTL. Standard pricing (0.001 STX).",
      tags: ["storage", "kv", "key-value", "cache", "durable-object"],
      examples: [
        "Store agent configuration",
        "Cache computation results",
        "Persist agent state across sessions",
      ],
      inputModes: ["application/json"],
      outputModes: ["application/json"],
    },
    {
      id: "paste-storage",
      name: "Agent Paste Bin",
      description:
        "Store and retrieve text pastes with optional syntax metadata and TTL. " +
        "POST /storage/paste → returns UUID for retrieval. Standard pricing (0.001 STX).",
      tags: ["storage", "paste", "text", "share"],
      examples: ["Store a code snippet", "Share text between agent sessions"],
      inputModes: ["application/json"],
      outputModes: ["application/json"],
    },
    {
      id: "sql-database",
      name: "Agent SQL Database",
      description:
        "Per-agent isolated SQLite database. " +
        "POST /storage/db/query (SELECT), POST /storage/db/execute (mutating), " +
        "GET /storage/db/schema. Parameterized queries. Standard pricing (0.001 STX).",
      tags: ["storage", "database", "sql", "sqlite", "query"],
      examples: [
        "Create a table and insert rows",
        "Query stored agent data",
        "Track task history in SQLite",
      ],
      inputModes: ["application/json"],
      outputModes: ["application/json"],
    },
    {
      id: "sync-locks",
      name: "Distributed Sync Locks",
      description:
        "Named distributed locks for coordinating concurrent agent processes. " +
        "POST /storage/sync/lock → returns token. Unlock with token. " +
        "TTL: 10-300 seconds. Standard pricing (0.001 STX).",
      tags: ["storage", "sync", "lock", "mutex", "coordination"],
      examples: [
        "Prevent duplicate job processing",
        "Coordinate concurrent agent actions",
        "Acquire exclusive resource access",
      ],
      inputModes: ["application/json"],
      outputModes: ["application/json"],
    },
    {
      id: "job-queue",
      name: "Agent Job Queue",
      description:
        "Persistent FIFO job queue with priority. " +
        "Push jobs (POST /storage/queue/push), pop atomically (POST /storage/queue/pop), " +
        "peek without removing (GET /storage/queue/peek). Standard pricing (0.001 STX).",
      tags: ["storage", "queue", "jobs", "async", "worker"],
      examples: [
        "Queue tasks for async processing",
        "Implement a work pipeline",
        "Distribute jobs across agent instances",
      ],
      inputModes: ["application/json"],
      outputModes: ["application/json"],
    },
    {
      id: "vector-memory",
      name: "Vector Memory (Semantic Search)",
      description:
        "Semantic memory with vector embeddings (BAAI/bge-base-en-v1.5, 768-dim). " +
        "Store items with POST /storage/memory/store (auto-generates embeddings). " +
        "Semantic search with POST /storage/memory/search. Standard pricing (0.001 STX).",
      tags: ["storage", "memory", "vector", "embeddings", "semantic-search", "rag"],
      examples: [
        "Store knowledge for RAG pipeline",
        "Semantic similarity search over agent memory",
        "Build a knowledge base for an LLM agent",
      ],
      inputModes: ["application/json"],
      outputModes: ["application/json"],
    },
  ],
};

// =============================================================================
// AX Discovery Router
// =============================================================================

export const axDiscoveryRouter = new Hono<{ Bindings: Env; Variables: AppVariables }>();

const PLAIN_TEXT_HEADERS = {
  "Content-Type": "text/plain; charset=utf-8",
  "Cache-Control": "public, max-age=300, s-maxage=3600",
};

axDiscoveryRouter.get("/llms.txt", (c) => {
  return new Response(LLMS_TXT, { headers: PLAIN_TEXT_HEADERS });
});

axDiscoveryRouter.get("/llms-full.txt", (c) => {
  return new Response(LLMS_FULL_TXT, { headers: PLAIN_TEXT_HEADERS });
});

axDiscoveryRouter.get("/topics", (c) => {
  const content = `# x402 Stacks API — Topic Documentation

Deep-dive reference docs for specific API topics. Each doc is self-contained
and covers unique workflow content not found in the quick-start (llms.txt) or
general reference (llms-full.txt).

## Available Topics

- inference: OpenRouter + Cloudflare AI models, dynamic pricing, chat completions
  URL: https://x402.aibtc.com/topics/inference

- hashing: All hash endpoints with examples, Clarity compatibility
  URL: https://x402.aibtc.com/topics/hashing

- storage: KV, paste, db, sync, queue, memory — lifecycle patterns
  URL: https://x402.aibtc.com/topics/storage

- payment-flow: x402 v2 challenge/response flow in detail
  URL: https://x402.aibtc.com/topics/payment-flow

## Usage

Fetch any topic doc directly:
  curl https://x402.aibtc.com/topics/inference
  curl https://x402.aibtc.com/topics/hashing
  curl https://x402.aibtc.com/topics/storage
  curl https://x402.aibtc.com/topics/payment-flow

## When to Use These Docs

These topic docs are for agents that already know which system they need and
want deep reference material without loading the full llms-full.txt.

- Use inference when setting up LLM chat completions or understanding dynamic pricing
- Use hashing when verifying Clarity-compatible hash behavior or hex/base64 encoding
- Use storage when implementing any persistent state: KV, DB, queue, memory, locks
- Use payment-flow when implementing x402 client signing from scratch

## Related

Quick-start: https://x402.aibtc.com/llms.txt
Full reference: https://x402.aibtc.com/llms-full.txt
OpenAPI spec: https://x402.aibtc.com/openapi.json
Agent card: https://x402.aibtc.com/.well-known/agent.json
Platform hub: https://aibtc.com/llms.txt
`;
  return new Response(content, { headers: PLAIN_TEXT_HEADERS });
});

axDiscoveryRouter.get("/topics/:topic", (c) => {
  const topic = c.req.param("topic");
  const content = TOPIC_DOCS[topic];

  if (!content) {
    const available = Object.keys(TOPIC_DOCS).join(", ");
    return new Response(
      `Topic "${topic}" not found.\n\nAvailable topics: ${available}\n\nSee https://x402.aibtc.com/topics for the topic index.\n`,
      {
        status: 404,
        headers: PLAIN_TEXT_HEADERS,
      }
    );
  }

  return new Response(content, { headers: PLAIN_TEXT_HEADERS });
});

axDiscoveryRouter.get("/.well-known/agent.json", (c) => {
  return c.json(AGENT_CARD, 200, {
    "Cache-Control": "public, max-age=3600, s-maxage=86400",
  });
});
