# CLAUDE.md

This file provides guidance to Claude Code when working with this repository.

## Project Overview

x402 Stacks API Host - A Cloudflare Worker that exposes APIs on a pay-per-use basis using the x402 protocol. Agents pay per request via Stacks blockchain payments (STX, sBTC, USDCx).

**Status**: Expanding from MVP to full multi-category API. See REQUIREMENTS.md for migration plan.

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
```

## Domains

| Environment | Domain | Network |
|-------------|--------|---------|
| Production | `x402.aibtc.com` | mainnet |
| Staging | `x402.aibtc.dev` | testnet |

> **Pattern**: All aibtc hosted projects follow `{service}.aibtc.com` (prod) / `{service}.aibtc.dev` (staging)

## API Categories (Target)

| Category | Endpoints | Pricing |
|----------|-----------|---------|
| `/inference/openrouter/*` | list-models, chat | Dynamic |
| `/inference/cloudflare/*` | list-models, chat | Fixed (ai tier) |
| `/stacks/*` | address, decode, profile, verify | Fixed (simple) |
| `/hashing/*` | sha256, sha512, keccak256, etc. | Fixed (simple) |
| `/storage/*` | kv, paste, db, sync, queue, memory | Fixed (storage tiers) |

See REQUIREMENTS.md for full endpoint specifications.

## Architecture

**Stack:**
- Cloudflare Workers + Chanfana (OpenAPI) + Hono.js
- Durable Objects with SQLite for per-agent state
- x402-stacks for payment verification
- worker-logs service binding (RPC to wbd.host)
- Cloudflare AI binding for embeddings

**Project Structure (Target):**
```
src/
├── index.ts                    # Hono app, Chanfana registry, Scalar at /docs
├── endpoints/
│   ├── base.ts                 # BaseEndpoint class with pricing strategy
│   ├── inference/              # OpenRouter + Cloudflare AI
│   ├── stacks/                 # Blockchain utilities
│   ├── hashing/                # Clarity-compatible hashing
│   └── storage/                # Stateful operations (kv, paste, db, etc.)
├── middleware/
│   ├── x402.ts                 # Unified payment (fixed + dynamic)
│   ├── metrics.ts              # Usage tracking
│   └── logger.ts               # RPC to wbd.host
├── durable-objects/
│   ├── UsageDO.ts              # Per-payer usage for dashboard
│   └── StorageDO.ts            # Stateful operations
├── services/
│   ├── pricing.ts              # Tier definitions + dynamic estimators
│   ├── openrouter.ts           # OpenRouter client
│   ├── hiro.ts                 # Hiro API client
│   └── tenero.ts               # Tenero API client
└── types.ts
```

## Pricing Strategy

**Fixed Tiers:**
| Tier | STX Amount | Use Case |
|------|------------|----------|
| `simple` | 0.001 | Basic compute (hashing, conversion) |
| `ai` | 0.003 | AI-enhanced operations |
| `storage_read` | 0.001 | Read from storage |
| `storage_write` | 0.002 | Write to storage |

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
