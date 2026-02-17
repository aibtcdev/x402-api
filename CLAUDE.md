# CLAUDE.md

This file provides guidance to Claude Code when working with this repository.

## Project Overview

x402 Stacks API Host - A Cloudflare Worker that exposes APIs on a pay-per-use basis using the x402 protocol. Agents pay per request via Stacks blockchain payments (STX, sBTC, USDCx).

**Status**: Multi-category API implemented.

## Commands

```bash
# Install dependencies
npm install

# Local development
npm run dev

# Type check
npm run check

# Dry-run deploy (verify build)
npm run deploy:dry-run

# DO NOT run npm run deploy - commit and push for automatic deployment

# Testing (requires X402_CLIENT_PK env var with testnet mnemonic)
npm test              # Quick mode - stateless endpoints, STX only
npm run test:full     # Full mode - includes lifecycle tests
npm run test:verbose  # With debug output
npm run test:kv       # Just KV lifecycle test

# Filter tests
bun run tests/_run_all_tests.ts --category=hashing
bun run tests/_run_all_tests.ts --filter=sha256 --all-tokens

# Randomized tests (for cron variance)
bun run tests/_run_all_tests.ts --sample=5                      # 5 random stateless
bun run tests/_run_all_tests.ts --random-lifecycle=2            # 2 random lifecycle
bun run tests/_run_all_tests.ts --random-token                  # Random STX/sBTC/USDCx
bun run tests/_run_all_tests.ts --mode=full --sample=3 --random-lifecycle=2 --random-token
```

## Domains

| Environment | Domain | Network |
|-------------|--------|---------|
| Production | `x402.aibtc.com` | mainnet |
| Staging | `x402.aibtc.dev` | testnet |

> **Pattern**: All aibtc hosted projects follow `{service}.aibtc.com` (prod) / `{service}.aibtc.dev` (staging)

## API Categories

| Category | Endpoints | Pricing |
|----------|-----------|---------|
| `/inference/openrouter/*` | models (free), chat (dynamic) | Dynamic |
| `/inference/cloudflare/*` | models (free), chat (standard) | Standard |
| `/stacks/*` | address, decode, profile, verify | Standard |
| `/hashing/*` | sha256, sha512, sha512-256, keccak256, hash160, ripemd160 | Standard |
| `/storage/*` | kv, paste, db, sync, queue, memory | Standard |

See `/docs` endpoint for full OpenAPI specification.

## Architecture

**Stack:**
- Cloudflare Workers + Chanfana (OpenAPI) + Hono.js
- Durable Objects with SQLite for per-agent state
- x402-stacks for payment verification
- worker-logs service binding (RPC to wbd.host)
- Cloudflare AI binding for embeddings

**Layout:** `src/` has `endpoints/`, `middleware/`, `durable-objects/`, `services/`, `utils/`, and `bazaar/`. Tests are in `tests/`, cron scripts in `scripts/`.

## Pricing Strategy

The API uses a simplified three-tier pricing model:

| Tier | STX Amount | Description |
|------|------------|-------------|
| `free` | 0 | Model listing endpoints (no payment required) |
| `standard` | 0.001 | All paid endpoints (hashing, stacks, storage, Cloudflare AI) |
| `dynamic` | varies | OpenRouter LLM endpoints (pass-through cost + 20% margin) |

**Note:** Endpoint classes use semantic aliases (`SimpleEndpoint`, `StorageReadEndpoint`, etc.) for code clarity, but all map to the same `standard` tier pricing.

**Dynamic Pricing (LLM):**
- Pass-through OpenRouter costs + 20% margin
- Estimate based on model + input tokens
- Minimum payment: $0.001 USD equivalent

## x402 Payment Flow

1. Client requests endpoint without payment
2. Middleware returns 402 with `payment-required` header (base64 JSON)
3. Client signs transaction and resends with `payment-signature` header (base64 JSON)
4. Middleware verifies payment via facilitator
5. Request processed, usage recorded in Durable Object
6. Response includes `payment-response` header (base64 JSON)

## Configuration

**Secrets** (set via `wrangler secret put`):
- `OPENROUTER_API_KEY` - OpenRouter API access
- `HIRO_API_KEY` - Hiro API access (better rate limits)

**Environment Variables:**
- `X402_SERVER_ADDRESS` - Stacks address to receive payments
- `X402_NETWORK` - `mainnet` or `testnet`
- `X402_FACILITATOR_URL` - x402 facilitator endpoint

**Test Environment Variables:**
- `X402_CLIENT_PK` - Testnet mnemonic for payment signing (required)
- `X402_WORKER_URL` - Target URL (default: http://localhost:8787)
- `VERBOSE` - Enable debug output (1 = enabled)
- `TEST_DELAY_MS` - Delay between tests (default: 500)
- `TEST_MAX_RETRIES` - Retries for rate limits (default: 3)

## Testing

E2E tests that execute the full x402 payment flow against live endpoints.

**Test Categories:**
| Category | Endpoints | Type |
|----------|-----------|------|
| hashing | 6 | Stateless |
| stacks | 6 | Stateless |
| inference | 2 (free) | Stateless |
| kv | 4 | Stateful (lifecycle) |
| paste | 3 | Stateful (lifecycle) |
| db | 3 | Stateful (lifecycle) |
| sync | 5 | Stateful (lifecycle) |
| queue | 5 | Stateful (lifecycle) |
| memory | 5 | Stateful (lifecycle) |

**Adding Lifecycle Tests:**
1. Copy `tests/kv-lifecycle.test.ts` as template
2. Implement CRUD operations for the category
3. Export `run{Category}Lifecycle` function
4. Import and add to `LIFECYCLE_RUNNERS` in `_run_all_tests.ts`

**Test Pattern:**
```typescript
// Stateless: single request/response validation
const config: TestConfig = {
  name: "sha256",
  endpoint: "/hashing/sha256",
  method: "POST",
  body: { data: "test" },
  validateResponse: (data, tokenType) =>
    data.ok && data.hash && data.tokenType === tokenType,
};

// Lifecycle: full CRUD cycle with cleanup
export async function runKvLifecycle(verbose = false) {
  // 1. Create resource
  // 2. Read back and verify
  // 3. List and find
  // 4. Delete
  // 5. Verify deletion
}
```

## AX Discovery Chain

Agent Experience (AX) discovery routes — all free, no payment required.

Agents discover this service through a progressive disclosure chain:

| Route                          | Format    | Purpose                                          |
|--------------------------------|-----------|--------------------------------------------------|
| `GET /.well-known/agent.json`  | JSON      | A2A agent card: skills, pricing, capabilities    |
| `GET /llms.txt`                | plaintext | Quick-start: what x402 is, tiers, payment flow   |
| `GET /llms-full.txt`           | plaintext | Full reference: all endpoints, schemas, examples |
| `GET /docs`                    | plaintext | Topic documentation index                        |
| `GET /docs/inference`          | plaintext | OpenRouter + Cloudflare AI, dynamic pricing      |
| `GET /docs/hashing`            | plaintext | All hash endpoints with examples                 |
| `GET /docs/storage`            | plaintext | KV, paste, db, sync, queue, memory patterns      |
| `GET /docs/payment-flow`       | plaintext | x402 v2 challenge/response flow in detail        |

**Implementation:** `src/endpoints/ax-discovery.ts` — single Hono sub-router
mounted at root via `app.route("/", axDiscoveryRouter)` in `src/index.ts`.

**Update together:** When adding endpoints, update `llms.txt`, `llms-full.txt`,
and the relevant topic doc. Content reflects REAL endpoints and behavior.

**References aibtc.com:** All docs point agents to `https://aibtc.com/llms.txt`
as the upstream platform hub for registration, messaging, and identity.

## Reference Documentation

- [Cloudflare Durable Objects](https://developers.cloudflare.com/durable-objects/best-practices/rules-of-durable-objects/) | [SQLite in DOs](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/) | [Workers AI](https://developers.cloudflare.com/workers-ai/)
- [OpenRouter API](https://openrouter.ai/docs/api/reference/overview) | [Hiro API](https://docs.hiro.so/stacks/api)
- [x402 Protocol](https://www.x402.org/) | [x402-stacks npm](https://www.npmjs.com/package/x402-stacks)

## Related Projects

- `~/dev/whoabuddy/worker-logs/` - Universal logging service
- `~/dev/whoabuddy/stacks-tracker/` - Stacks blockchain tracker (reference patterns)
