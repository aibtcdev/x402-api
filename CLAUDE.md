# CLAUDE.md

This file provides guidance to Claude Code when working with this repository.

## Project Overview

x402 Stacks API Host - A Cloudflare Worker that exposes third-party APIs on a pay-per-use basis using the x402 protocol. Uses one Durable Object per API service for isolated state and usage tracking.

**Status**: Initial scaffolding complete. See REQUIREMENTS.md for goals and open questions.

**First target**: OpenRouter API for LLM access (100+ models via single endpoint).

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

## Architecture

**Stack:**
- Cloudflare Workers for deployment
- Hono.js for HTTP routing
- Durable Objects with SQLite for per-agent state
- OpenAI SDK (OpenRouter-compatible) for LLM calls
- worker-logs service binding for centralized logging

**Endpoints:**
- `/health` - Health check
- `/v1/chat/completions` - OpenRouter proxy (x402 paid)
- `/v1/models` - List available models
- `/usage` - Agent's usage stats

**Project Structure:**
```
src/
  index.ts          # Worker entry + OpenRouterDO class
  # Planned:
  services/
    openrouter.ts   # OpenRouter proxy logic
  middleware/
    x402.ts         # x402 payment verification
  types.ts          # TypeScript interfaces
```

## Durable Objects

**OpenRouterDO** - Per-agent state for OpenRouter API:
- Usage tracking (tokens, cost per request)
- Daily stats aggregation
- Rate limiting (TODO)
- SQLite-backed storage

DO instance routing: Each agent gets their own DO instance, keyed by agent identifier (TBD: Stacks address, API key, or x402 payment ID).

## Configuration

- `wrangler.jsonc` - Cloudflare Workers config (DOs, service bindings, routes)
- Secrets set via `wrangler secret put`:
  - `OPENROUTER_API_KEY` - API key for OpenRouter

## Service Bindings

**LOGS** - Universal logging service (RPC binding to worker-logs)
```typescript
await env.LOGS.info('x402-api-host', 'Request proxied', { model, tokens })
await env.LOGS.error('x402-api-host', 'OpenRouter error', { error })
```

## Key Decisions Needed

See REQUIREMENTS.md for full list. Key blockers:
1. Pricing model: Pass-through + margin vs flat rate?
2. Payment timing: Pre-pay estimate vs post-pay actual?
3. Agent identification: How to route to agent's DO?
4. Streaming: How to handle SSE with x402?

## Related Projects

**x402 Infrastructure:**
- `../x402Stacks-sponsor-relay/` - Sponsor relay for gasless transactions

**Best Practice References:**
- `~/dev/absorbingchaos/thundermountainbuilders/` - CF Worker patterns
- `~/dev/whoabuddy/worker-logs/` - Universal logging with DOs

**aibtcdev Resources:**
- `../erc-8004-stacks/` - Agent identity contracts
- `../aibtcdev-cache/` - CF Worker with Durable Objects pattern

## Wrangler Setup

Wrangler commands need environment variables from `.env`:

```bash
npm run wrangler -- <command>
```

### Secrets

Set via `wrangler secret put`:
- `OPENROUTER_API_KEY` - OpenRouter API key

## Development Notes

- Follow existing aibtcdev patterns for Cloudflare Workers
- Use `wrangler.jsonc` format with comments (not .toml)
- One DO class per API service (OpenRouterDO, future: ImageGenDO, etc.)
- Use SQLite in DOs for usage tracking (`new_sqlite_classes` in migrations)
- Integrate worker-logs early for debugging
- OpenRouter uses OpenAI-compatible API format
