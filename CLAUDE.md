# CLAUDE.md

This file provides guidance to Claude Code when working with this repository.

## Project Overview

x402 Stacks API Host - A Cloudflare Worker that exposes APIs on a pay-per-use basis using the x402 protocol. Agents pay per request via Stacks blockchain payments (STX, sBTC, USDCx).

**Status**: Multi-category API implemented. See REQUIREMENTS.md for architecture decisions.

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
| `/inference/openrouter/*` | models, chat | Dynamic |
| `/inference/cloudflare/*` | models, chat | Fixed (ai tier) |
| `/stacks/*` | address, decode, profile, verify | Fixed (simple) |
| `/hashing/*` | sha256, sha512, sha512-256, keccak256, hash160, ripemd160 | Fixed (simple) |
| `/storage/*` | kv, paste, db, sync, queue, memory | Fixed (storage tiers) |

See `/docs` endpoint for full OpenAPI specification.

## Architecture

**Stack:**
- Cloudflare Workers + Chanfana (OpenAPI) + Hono.js
- Durable Objects with SQLite for per-agent state
- x402-stacks for payment verification
- worker-logs service binding (RPC to wbd.host)
- Cloudflare AI binding for embeddings

**Project Structure:**
```
src/
├── index.ts                    # Hono app, Chanfana registry, Scalar at /docs
├── types.ts                    # Shared types and Env interface
├── endpoints/
│   ├── base.ts                 # BaseEndpoint classes with pricing tiers
│   ├── inference/              # OpenRouter + Cloudflare AI
│   ├── stacks/                 # Blockchain utilities
│   ├── hashing/                # Clarity-compatible hashing
│   └── storage/                # Stateful operations (kv, paste, db, sync, queue, memory)
├── middleware/
│   └── x402.ts                 # Payment middleware (fixed + dynamic)
├── durable-objects/
│   ├── UsageDO.ts              # Per-payer usage tracking
│   ├── StorageDO.ts            # Per-payer stateful storage
│   └── MetricsDO.ts            # Global metrics tracking
├── services/
│   ├── pricing.ts              # Tier definitions + dynamic estimators
│   ├── openrouter.ts           # OpenRouter client
│   ├── hiro.ts                 # Hiro API client
│   └── tenero.ts               # Tenero API client
└── utils/
    ├── logger.ts               # Logging utilities
    ├── pricing.ts              # Pricing helpers
    └── wallet.ts               # Wallet derivation for tests

tests/
├── _shared_utils.ts            # Colors, env vars, test logger
├── _test_generator.ts          # TestConfig interface, X402 payment flow
├── _run_all_tests.ts           # Main CLI runner with modes, filtering
├── endpoint-registry.ts        # All endpoint configs with validation
└── kv-lifecycle.test.ts        # KV storage lifecycle test

scripts/
└── run-tests-cron.sh           # Cron wrapper for automated test runs
```

## Pricing Strategy

**Fixed Tiers:**
| Tier | STX Amount | Use Case |
|------|------------|----------|
| `simple` | 0.001 | Basic compute (hashing, conversion) |
| `ai` | 0.003 | AI-enhanced operations |
| `storage_read` | 0.001 | Read from storage |
| `storage_write` | 0.002 | Write to storage |
| `storage_write_large` | 0.005 | Large writes (embeddings) |

**Dynamic Pricing (LLM):**
- Pass-through OpenRouter costs + 20% margin
- Estimate based on model + input tokens

## x402 Payment Flow

1. Client requests endpoint without payment
2. Middleware returns 402 with payment requirements
3. Client signs transaction and resends with `X-PAYMENT` header
4. Middleware verifies payment via facilitator
5. Request processed, usage recorded in Durable Object
6. Response returned to agent

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

## Reference Patterns

When implementing `/stacks` endpoints, reference patterns from:
- `~/dev/whoabuddy/stacks-tracker/src/api/hiro-client.ts` - Hiro API client
- `~/dev/whoabuddy/stacks-tracker/src/crypto/key-derivation.ts` - Address validation
- `~/dev/whoabuddy/stacks-tracker/src/utils/clarity-converter.ts` - Clarity types

When migrating endpoints, reference:
- `~/dev/whoabuddy/stx402/` - Production endpoints to migrate

## Important: Consult Documentation

**ALWAYS check official docs before implementing features:**

### Cloudflare Workers & Durable Objects
- [Rules of Durable Objects](https://developers.cloudflare.com/durable-objects/best-practices/rules-of-durable-objects/)
- [SQLite in DOs](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/)
- [Workers AI](https://developers.cloudflare.com/workers-ai/)

### APIs
- [OpenRouter API](https://openrouter.ai/docs/api/reference/overview)
- [Hiro API](https://docs.hiro.so/stacks/api)
- [Tenero API](https://docs.tenero.io/)

### x402 Protocol
- [x402 Protocol](https://www.x402.org/)
- [x402-stacks npm](https://www.npmjs.com/package/x402-stacks)

## Related Projects

- `~/dev/whoabuddy/worker-logs/` - Universal logging service
- `~/dev/whoabuddy/stacks-tracker/` - Stacks blockchain tracker (reference patterns)
- `~/dev/whoabuddy/stx402/` - Production x402 API (source for migration)
