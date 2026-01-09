# x402 Stacks API Host

A Cloudflare Worker that exposes third-party APIs on a pay-per-use basis using the x402 protocol. Each API service gets its own Durable Object for isolated state, usage tracking, and rate limiting.

## Overview

This service acts as an x402-enabled proxy for third-party APIs:

1. Agent requests an API endpoint (e.g., `/v1/chat/completions`)
2. If unpaid, server responds with HTTP 402 and payment requirements
3. Agent pays via x402 (Stacks-based payment)
4. Request is proxied to the upstream API using our API key
5. Usage is recorded in agent-specific Durable Object
6. Response is returned to agent

**First target**: [OpenRouter API](https://openrouter.ai/docs) - unified access to 100+ LLM models.

## Goals

### Primary Goals

- [ ] **Pay-per-use API access**: Agents pay per request/token via x402
- [ ] **One DO per service**: Isolated state for each API service (OpenRouter, etc.)
- [ ] **Usage tracking**: Per-agent token counts, costs, request history
- [ ] **OpenRouter integration**: Proxy `/v1/chat/completions` and related endpoints

### Secondary Goals

- [ ] **Rate limiting**: Per-agent rate limits to prevent abuse
- [ ] **Spending caps**: Optional per-agent spending limits
- [ ] **Multi-service**: Extensible pattern for adding more API services
- [ ] **Streaming support**: Handle SSE streaming responses from LLMs

## Architecture

### Durable Object Pattern

Each API service gets its own DO class:

```
┌─────────────┐     ┌──────────────────────┐     ┌─────────────────┐
│   Agent     │────▶│  API Host Worker     │────▶│  OpenRouter API │
│             │     │                      │     │                 │
└─────────────┘     │  ┌────────────────┐  │     └─────────────────┘
                    │  │ OpenRouterDO   │  │
                    │  │ (per agent)    │  │
                    │  │ - usage stats  │  │
                    │  │ - rate limits  │  │
                    │  └────────────────┘  │
                    └──────────────────────┘
```

Each agent gets their own DO instance (by agent ID), providing:
- Isolated SQLite storage for usage tracking
- Per-agent rate limiting
- Request history and audit trail

### API Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/health` | GET | Health check |
| `/v1/chat/completions` | POST | OpenRouter chat completions (x402 paid) |
| `/v1/models` | GET | List available models |
| `/usage` | GET | Agent's usage stats (authenticated) |

## OpenRouter Integration

### API Reference

- [API Overview](https://openrouter.ai/docs/api/reference/overview)
- [Chat Completions](https://openrouter.ai/docs/quickstart)
- [Authentication](https://openrouter.ai/docs/api/reference/authentication)
- [Generation Stats](https://openrouter.ai/docs/api-reference/generation-stats)

### Key Features

- OpenAI-compatible API (`/v1/chat/completions`)
- Access to 100+ models (GPT-4, Claude, Llama, etc.)
- Automatic fallback routing
- Usage stats via `/api/v1/generation` endpoint

### Pricing Considerations

OpenRouter charges per token based on the model. We need to:
1. Pass through OpenRouter costs
2. Add our margin for x402 infrastructure
3. Handle different pricing per model

## Open Questions

### Payment & Pricing

1. **Pricing model**: How to price requests?
   - Pass-through OpenRouter costs + fixed margin?
   - Flat rate per request regardless of model?
   - Token-based pricing matching upstream?

2. **Payment timing**: When does payment happen?
   - Pre-pay before request (estimate tokens)?
   - Post-pay after response (actual tokens)?
   - Hybrid with deposits?

3. **Payment token**: What token for payments?
   - STX native?
   - aBTC?
   - USDC on Stacks?

### Agent Identity

4. **Agent identification**: How to identify agents?
   - x402 payment includes agent identity?
   - Separate API key per agent?
   - ERC-8004 identity registry lookup?

5. **DO routing**: How to route to agent's DO?
   - Hash of agent's Stacks address?
   - Agent ID from x402 payment?
   - API key maps to DO ID?

### API Design

6. **Streaming**: How to handle SSE streaming?
   - Pass through stream with x402 header?
   - Buffer and charge after completion?
   - Different pricing for streaming?

7. **Model selection**: How to handle model routing?
   - Allow any OpenRouter model?
   - Whitelist specific models?
   - Different pricing tiers?

8. **Error handling**: What if OpenRouter fails?
   - Refund x402 payment?
   - Retry with different provider?
   - Partial refund for partial responses?

### Operations

9. **Rate limits**: What limits are appropriate?
   - Requests per minute/hour?
   - Tokens per day?
   - Concurrent requests?

10. **Cost tracking**: How to track our costs?
    - OpenRouter provides usage stats
    - Store in DO for reconciliation
    - Dashboard for monitoring?

### Future Services

11. **Service extensibility**: How to add more APIs?
    - One DO class per service?
    - Shared base class with service-specific logic?
    - Plugin architecture?

12. **Other APIs to add**:
    - Image generation (DALL-E, Midjourney)?
    - Voice/TTS (ElevenLabs)?
    - Search APIs?
    - Database services?

## Context

### Related Projects

**x402 Infrastructure:**
- `../x402Stacks-sponsor-relay/` - Sponsor relay for gasless transactions

**Best Practice References:**
- `~/dev/absorbingchaos/thundermountainbuilders/` - CF Worker patterns
- `~/dev/whoabuddy/worker-logs/` - Universal logging with DOs

**aibtcdev Resources:**
- `../erc-8004-stacks/` - Agent identity contracts
- `../aibtcdev-cache/` - CF Worker with Durable Objects pattern

## Next Steps

1. Implement basic OpenRouter proxy (no x402 yet)
2. Add usage tracking in DO
3. Integrate x402 payment verification
4. Add streaming support
5. Build usage dashboard

## Resources

### OpenRouter
- [API Reference](https://openrouter.ai/docs/api/reference/overview)
- [Quickstart](https://openrouter.ai/docs/quickstart)
- [TypeScript SDK](https://openrouter.ai/docs/sdks/typescript/endpoints)
- [Authentication](https://openrouter.ai/docs/api/reference/authentication)

### x402 Protocol
- [x402 Protocol](https://www.x402.org/)
- [x402 GitHub](https://github.com/coinbase/x402)
- [x402 Documentation](https://docs.cdp.coinbase.com/x402/welcome)

### Cloudflare
- [Durable Objects](https://developers.cloudflare.com/durable-objects/)
- [SQLite in DOs](https://developers.cloudflare.com/durable-objects/api/storage-api/#sql-api)
- [Service Bindings](https://developers.cloudflare.com/workers/runtime-apis/bindings/service-bindings/)

### Local Resources
- [CF Best Practices - Thunder Mountain](~/dev/absorbingchaos/thundermountainbuilders/)
- [Universal Logger](~/dev/whoabuddy/worker-logs/) - https://logs.wbd.host
- [x402 Sponsor Relay](../x402Stacks-sponsor-relay/)
