# x402 Stacks API

**Pay-per-use APIs for AI agents, secured by blockchain payments.**

## The Problem

AI agents need diverse APIs (LLMs, storage, blockchain utilities) but face:

- **Fragmented billing** across multiple vendors
- **API key management** and rotation overhead
- **Subscription minimums** that don't fit bursty workloads
- **No native micropayment support** for sub-cent transactions

## The Solution

x402 Stacks API provides 40+ endpoints under one roof. Agents pay per request via Stacks blockchain transactions-no subscriptions, no API keys, no vendor lock-in.

```
1. Agent requests endpoint → Receives HTTP 402 with exact cost
2. Agent signs Stacks transaction → Sends X-PAYMENT header
3. Server verifies on-chain → Processes request
4. Response returned → Usage tracked by payer address
```

**Payment tokens:** STX, sBTC, or USDCx (stablecoin)

## What You Get

| Category             | Endpoints | Description                                             |
| -------------------- | --------- | ------------------------------------------------------- |
| **LLM Inference**    | 4         | OpenRouter (100+ models) + Cloudflare AI                |
| **Stacks Utilities** | 6         | Address conversion, tx decoding, signature verification |
| **Hashing**          | 6         | SHA256, Keccak, RIPEMD160-Clarity-compatible            |
| **Storage**          | 25        | KV store, SQL database, job queues, vector memory       |

### Storage: Per-Agent Isolation

Each payer gets their own isolated namespace:

- **KV Store** - Key-value with TTL support
- **Paste Bin** - Ephemeral content storage
- **SQL Database** - Full relational queries
- **Distributed Locks** - Multi-agent coordination
- **Job Queue** - Priority-based async tasks
- **Vector Memory** - Embeddings for long-term context

> [!NOTE]
> Storage is keyed to the Stacks address and verified by the transaction signature

## Pricing

| Tier         | Cost                 | Endpoints                            |
| ------------ | -------------------- | ------------------------------------ |
| **Free**     | 0                    | Model listings, health checks        |
| **Standard** | 0.001 STX (~$0.0005) | Hashing, Stacks utils, all storage   |
| **Dynamic**  | Varies               | LLM chat (pass-through + 20% margin) |

**No subscriptions. No minimums. True micropayments.**

## Environments

| Environment | URL              | Network |
| ----------- | ---------------- | ------- |
| Production  | `x402.aibtc.com` | Mainnet |
| Staging     | `x402.aibtc.dev` | Testnet |

## Quick Start

```bash
# 1. Call any endpoint without payment
curl https://x402.aibtc.dev/inference/openrouter/models
# → 200 OK (free endpoint)

curl https://x402.aibtc.dev/hashing/sha256 -X POST -d '{"data":"test"}'
# → 402 Payment Required (includes exact cost)

# 2. Sign the transaction with your Stacks wallet
# 3. Retry with X-PAYMENT header
# 4. Process response
```

Full OpenAPI spec: `https://x402.aibtc.com/docs`

## Architecture

- **Cloudflare Workers** - Serverless edge compute
- **Durable Objects** - Strongly consistent, per-payer storage
- **SQLite** - Full SQL support in each storage namespace
- **x402-stacks** - Payment verification library

## Summary

| Traditional APIs      | x402 API              |
| --------------------- | --------------------- |
| Monthly subscriptions | Pay per request       |
| API keys to manage    | Blockchain payments   |
| Separate vendors      | One platform          |
| Minimum spend         | Sub-cent transactions |
| Shared infrastructure | Per-payer isolation   |

**x402 Stacks API: Infrastructure for autonomous agents, priced for reality.**

_Built by [AIBTC](https://aibtc.com) • Protocol: [x402Stacks](https://stacksx402.com)_
