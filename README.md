# x402 Stacks API Host

A Cloudflare Worker that exposes third-party APIs on a pay-per-use basis using the [x402 protocol](https://www.x402.org/) on Stacks.

## Overview

This service acts as an x402-enabled proxy for third-party APIs:

1. Agent requests an API endpoint (e.g., `/openrouter/v1/chat/completions`)
2. Server responds with HTTP 402 and payment requirements
3. Agent signs payment transaction and resends with `X-PAYMENT` header
4. Server verifies payment, proxies request to upstream API
5. Usage is recorded in agent's Durable Object (keyed by Stacks address)
6. Response is returned to agent

## API Endpoints

| Environment | Base URL | Network |
|-------------|----------|---------|
| **Production** | `https://x402.aibtc.com` | mainnet |
| **Staging** | `https://x402.aibtc.dev` | testnet |

### Global Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/` | Service info and available APIs |
| GET | `/health` | Health check |

### OpenRouter (`/openrouter`)

Access 100+ LLM models via [OpenRouter](https://openrouter.ai).

| Method | Path | Description |
|--------|------|-------------|
| GET | `/openrouter/v1/models` | List available models |
| POST | `/openrouter/v1/chat/completions` | Chat completions (x402 paid) |
| GET | `/openrouter/usage` | Usage stats for your address |

## Usage

### 1. Get Payment Requirements

```bash
curl -X POST https://x402.aibtc.com/openrouter/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "openai/gpt-4o-mini",
    "messages": [{"role": "user", "content": "Hello!"}]
  }'
```

Response (HTTP 402):
```json
{
  "maxAmountRequired": "2000",
  "resource": "/openrouter/v1/chat/completions",
  "payTo": "SP...",
  "network": "mainnet",
  "tokenType": "STX",
  "estimate": {
    "model": "openai/gpt-4o-mini",
    "estimatedInputTokens": 10,
    "estimatedOutputTokens": 20,
    "estimatedCostUsd": "0.000018"
  }
}
```

### 2. Sign and Send Payment

Sign the payment transaction with your Stacks wallet and include it in the request:

```bash
curl -X POST https://x402.aibtc.com/openrouter/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "X-PAYMENT: <signed-transaction-hex>" \
  -d '{
    "model": "openai/gpt-4o-mini",
    "messages": [{"role": "user", "content": "Hello!"}]
  }'
```

### 3. Check Usage

```bash
curl https://x402.aibtc.com/openrouter/usage \
  -H "X-Stacks-Address: SP..."
```

## Payment Tokens

Supported payment tokens:
- **STX** - Native Stacks token
- **sBTC** - Bitcoin on Stacks
- **USDCx** - USDC via xReserve on Stacks

Specify token type via `X-PAYMENT-TOKEN-TYPE` header (default: STX).

## Pricing

- **Model-based pricing**: Cost varies by LLM model
- **20% margin**: Added to OpenRouter's base cost
- **Pre-pay**: Estimated cost charged upfront based on input tokens

## Development

```bash
# Install dependencies
npm install

# Local development
npm run dev

# Type check
npm run check

# Dry-run deploy (verify build)
npm run deploy:dry-run
```

### Configuration

Set secrets via wrangler:
```bash
wrangler secret put OPENROUTER_API_KEY -e production
```

Environment variables in `wrangler.jsonc`:
- `X402_SERVER_ADDRESS` - Stacks address to receive payments
- `X402_NETWORK` - `mainnet` or `testnet`
- `X402_FACILITATOR_URL` - x402 facilitator endpoint

## Architecture

- **Cloudflare Workers** - Edge deployment
- **Hono.js** - HTTP routing
- **Durable Objects** - Per-agent state (SQLite-backed)
- **x402-stacks** - Payment verification
- **worker-logs** - Centralized logging

## License

MIT
