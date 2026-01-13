# x402 Stacks API Host

A Cloudflare Worker that exposes APIs on a pay-per-use basis using the x402 protocol. Agents pay per request via Stacks blockchain payments (STX, sBTC, USDCx).

## Domains

| Environment    | Domain           | Network |
| -------------- | ---------------- | ------- |
| **Production** | `x402.aibtc.com` | mainnet |
| **Staging**    | `x402.aibtc.dev` | testnet |

> **Pattern**: All aibtc hosted projects follow `{service}.aibtc.com` (prod) / `{service}.aibtc.dev` (staging)

---

## Overview

| Aspect           | Value                                     |
| ---------------- | ----------------------------------------- |
| **Framework**    | Chanfana + Hono                           |
| **Architecture** | Class-based endpoints                     |
| **Pricing**      | Hybrid (fixed tiers + dynamic estimation) |
| **TypeScript**   | Strict mode                               |
| **Endpoints**    | ~41 across 5 categories                   |

### Payment Flow

1. Agent requests an API endpoint (e.g., `/inference/openrouter/chat`)
2. If unpaid, server responds with HTTP 402 and payment requirements
3. Agent signs payment and resends with `X-PAYMENT` header
4. Middleware verifies payment via x402 facilitator
5. Request is processed, usage recorded in Durable Object (keyed by Stacks address)
6. Response returned to agent

---

## Architectural Decisions

### Confirmed

- **Cloudflare AI**: Include binding for native CF models
- **Logging**: `worker-logs` service binding (RPC to wbd.host)
- **KV Storage**: Add METRICS and STORAGE namespaces
- **OpenAPI Docs**: Scalar UI at `/docs` (not root)
- **TypeScript**: Strict mode
- **Endpoint Organization**: Category directories (`/inference/*`, `/stacks/*`, etc.)
- **Storage Structure**: Subdirectories (`/storage/kv/*`, `/storage/paste/*`, etc.)
- **Vector Embeddings**: Keep memory endpoints, uses CF AI for embeddings
- **Inference Providers**: Separate by subdirectory (`/openrouter/*`, `/cloudflare/*`)
- **External APIs**: Hiro API (with API key) + Tenero API for Stacks data

### Payment & Pricing (from MVP)

| Decision           | Value                                              |
| ------------------ | -------------------------------------------------- |
| **Pricing model**  | Fixed tiers OR dynamic (pass-through + 20% margin) |
| **Payment timing** | Pre-pay based on estimate                          |
| **Payment tokens** | STX, sBTC, USDCx (all supported)                   |
| **Agent identity** | Stacks address from x402 payment                   |
| **DO routing**     | `idFromName(stacksAddress)`                        |

### Pricing Strategy

- **Fixed pricing**: Simple compute endpoints (hashing, address conversion)
- **Dynamic pricing**: LLM endpoints (estimate based on model + tokens)
- Per-endpoint or per-category configuration

### Fixed Tiers

| Tier                  | STX Amount | Use Case                            |
| --------------------- | ---------- | ----------------------------------- |
| `simple`              | 0.001      | Basic compute (hashing, conversion) |
| `ai`                  | 0.003      | AI-enhanced operations              |
| `heavy_ai`            | 0.01       | Heavy AI workloads                  |
| `storage_read`        | 0.001      | Read from storage                   |
| `storage_write`       | 0.002      | Write to storage                    |
| `storage_write_large` | 0.005      | Large writes (paste, memory)        |

### Dynamic Pricing (LLM)

```typescript
interface PriceEstimate {
  amount: string; // In smallest unit (microSTX)
  token: "STX" | "sBTC" | "USDCx";
  breakdown?: {
    inputTokens: number;
    outputTokens: number;
    modelRate: number;
    margin: number; // 20%
  };
}
```

---

## External API Dependencies

| API            | Use Case                               | Auth             | Rate Limits                                                                |
| -------------- | -------------------------------------- | ---------------- | -------------------------------------------------------------------------- |
| **Hiro API**   | Stacks data (balances, BNS, tx decode) | API key required | Headers: `X-RateLimit-Limit`, `X-RateLimit-Remaining`, `X-RateLimit-Reset` |
| **Tenero API** | Token data, market info                | None (public)    | Fair use                                                                   |
| **OpenRouter** | LLM inference                          | API key required | Per-model limits                                                           |

### Reference Patterns (from stacks-tracker)

Code patterns to reference when implementing `/stacks` endpoints. Rewrite for x402-api (strict TS, conventions) rather than copy directly.

| Pattern                 | Reference File                                                  | Use In x402-api                  |
| ----------------------- | --------------------------------------------------------------- | -------------------------------- |
| **Hiro API Client**     | `~/dev/whoabuddy/stacks-tracker/src/api/hiro-client.ts`         | `src/services/hiro.ts`           |
| **Address Validation**  | `~/dev/whoabuddy/stacks-tracker/src/crypto/key-derivation.ts`   | Address conversion endpoint      |
| **BNS Detection**       | `isBnsName()` in key-derivation.ts                              | Profile endpoint (resolve names) |
| **Clarity Value Types** | `~/dev/whoabuddy/stacks-tracker/src/types/clarity-args.ts`      | Decode endpoints                 |
| **Clarity Converter**   | `~/dev/whoabuddy/stacks-tracker/src/utils/clarity-converter.ts` | Decode Clarity hex               |
| **Rate Limit Tracking** | `~/dev/whoabuddy/stacks-tracker/src/api/rate-limiter.ts`        | Track Hiro limits (simplified)   |

**Key Hiro API Endpoints Used:**

```
GET  /extended/v1/address/{principal}/stx     - STX balance
GET  /extended/v1/address/{principal}/nonces  - Account nonces
GET  /extended/v1/tx/{tx_id}                  - Transaction details
GET  /v1/names/{name}                         - BNS resolution
POST /v2/transactions                         - Broadcast (if needed)
```

**Clarity Type System (JSON-serializable):**

```typescript
type ClarityArgument =
  | { type: "uint" | "int"; value: string }
  | { type: "bool"; value: boolean }
  | { type: "principal"; value: string }
  | { type: "string-ascii" | "string-utf8"; value: string }
  | { type: "buffer"; value: string } // hex-encoded
  | { type: "none" }
  | { type: "some" | "ok" | "err"; value: ClarityArgument }
  | { type: "list"; value: ClarityArgument[] }
  | { type: "tuple"; value: Record<string, ClarityArgument> };
```

**Implementation Notes:**

- Single Hiro API key (no rotation needed initially)
- Track rate limit headers for client awareness
- No Chainhooks integration needed (request/response only)
- Use `@stacks/transactions` v7 for transaction decoding

---

## API Categories

### 1. `/inference` - AI/LLM Endpoints

Multi-provider inference with OpenRouter and Cloudflare AI, organized by provider subdirectory.

#### OpenRouter (`/inference/openrouter`)

| Endpoint                            | Method | Pricing                  | Source   |
| ----------------------------------- | ------ | ------------------------ | -------- |
| `/inference/openrouter/list-models` | GET    | Free                     | x402-api |
| `/inference/openrouter/chat`        | POST   | Dynamic (model + tokens) | x402-api |

#### Cloudflare AI (`/inference/cloudflare`)

| Endpoint                            | Method | Pricing         | Source |
| ----------------------------------- | ------ | --------------- | ------ |
| `/inference/cloudflare/list-models` | GET    | Free            | New    |
| `/inference/cloudflare/chat`        | POST   | Fixed (ai tier) | New    |

**OpenRouter Dynamic Pricing** estimates cost based on:

- Model pricing (per 1K input/output tokens)
- Input token count from messages
- Output estimate (2x input or max_tokens)
- 20% margin + minimum floor

**Cloudflare AI Fixed Pricing**:

- Uses `ai` tier (0.003 STX) - CF AI costs are absorbed/amortized
- Simpler pricing since CF AI is billed to our account monthly

### 2. `/stacks` - Stacks Blockchain Utilities

Useful for agents and apps working with Stacks data.

| Endpoint                       | Method | Pricing        | Source |
| ------------------------------ | ------ | -------------- | ------ |
| `/stacks/address/convert`      | POST   | Fixed (simple) | stx402 |
| `/stacks/decode/clarity-value` | POST   | Fixed (simple) | stx402 |
| `/stacks/decode/transaction`   | POST   | Fixed (simple) | stx402 |
| `/stacks/profile/{address}`    | GET    | Fixed (simple) | stx402 |
| `/stacks/verify/message`       | POST   | Fixed (simple) | New    |
| `/stacks/verify/sip018`        | POST   | Fixed (simple) | New    |

**Notes:**

- Verify endpoints support simple signed messages and SIP-018 structured data
- Address input accepts: STX address (SP.../ST...) or BNS name (user.btc)

**Profile Endpoint Response Structure:**

```typescript
interface StacksProfile {
  // Input resolution
  input: string; // Original input (address or BNS)
  address: string; // Resolved STX address
  bnsName?: string; // BNS name if registered

  // Chain state (Hiro API)
  blockHeight: number; // Current block height
  stxBalance: {
    balance: string; // microSTX
    locked: string; // Stacking locked
    unlockHeight?: number;
  };
  nonce: number; // Next expected nonce

  // Token balances (Hiro + Tenero)
  fungibleTokens: Array<{
    contractId: string;
    symbol?: string;
    balance: string;
    decimals?: number;
    usdValue?: number; // From Tenero if available
  }>;

  nonFungibleTokens: Array<{
    contractId: string;
    count: number;
  }>;
}
```

**Data Sources:**

- `blockHeight`, `stxBalance`, `nonce`: Hiro API `/extended/v1/address/{addr}/stx`
- `bnsName`: Hiro API `/v1/addresses/stacks/{addr}` or reverse lookup
- `fungibleTokens`: Hiro API `/extended/v1/address/{addr}/balances`
- `usdValue`: Tenero API token pricing

### 3. `/hashing` - Clarity-Compatible Hashing

Compute-as-a-service for hash functions available in Clarity.

| Endpoint              | Method | Pricing        | Source |
| --------------------- | ------ | -------------- | ------ |
| `/hashing/sha256`     | POST   | Fixed (simple) | stx402 |
| `/hashing/sha512`     | POST   | Fixed (simple) | stx402 |
| `/hashing/sha512-256` | POST   | Fixed (simple) | stx402 |
| `/hashing/keccak256`  | POST   | Fixed (simple) | stx402 |
| `/hashing/hash160`    | POST   | Fixed (simple) | stx402 |
| `/hashing/ripemd160`  | POST   | Fixed (simple) | stx402 |

**Notes:**

- All return hex-encoded hash output
- Input can be hex string or raw bytes
- Matches Clarity's built-in hash functions exactly

### 4. `/storage` - Stateful Storage Endpoints

All stateful/persistent operations organized by subdirectory.

```
/storage/kv/*        - Key/value store
/storage/paste/*     - Paste bin
/storage/db/*        - SQL database
/storage/sync/*      - Locks/synchronization
/storage/queue/*     - Job queue
/storage/memory/*    - Vector memory/embeddings (uses CF AI for embeddings)
```

| Subcategory | Endpoints                          | Pricing                    | Source |
| ----------- | ---------------------------------- | -------------------------- | ------ |
| **kv**      | get, set, delete, list             | Fixed (storage_read/write) | stx402 |
| **paste**   | create, get, delete                | Fixed (storage_write/read) | stx402 |
| **db**      | query, execute, schema             | Fixed (storage_read/write) | stx402 |
| **sync**    | lock, unlock, extend, status, list | Fixed (simple)             | stx402 |
| **queue**   | push, pop, peek, status, clear     | Fixed (simple)             | stx402 |
| **memory**  | store, search, delete, list, clear | Fixed (ai)                 | stx402 |

**Total: 25 storage endpoints**

**Notes:**

- Memory endpoints use CF AI binding for embedding generation
- All storage is per-payer (isolated by Stacks address via Durable Object)

---

## Project Structure

```
src/
├── index.ts                    # Hono app, Chanfana registry, Scalar at /docs
├── endpoints/
│   ├── base.ts                 # BaseEndpoint class with pricing strategy
│   ├── inference/
│   │   ├── openrouter/
│   │   │   ├── list-models.ts
│   │   │   ├── chat.ts
│   │   │   └── index.ts
│   │   ├── cloudflare/
│   │   │   ├── list-models.ts
│   │   │   ├── chat.ts
│   │   │   └── index.ts
│   │   └── index.ts            # Category exports
│   ├── stacks/
│   │   ├── address-convert.ts
│   │   ├── decode-clarity.ts
│   │   ├── decode-transaction.ts
│   │   ├── profile.ts
│   │   ├── verify-message.ts
│   │   ├── verify-sip018.ts
│   │   └── index.ts
│   ├── hashing/
│   │   ├── sha256.ts
│   │   ├── sha512.ts
│   │   ├── sha512-256.ts
│   │   ├── keccak256.ts
│   │   ├── hash160.ts
│   │   ├── ripemd160.ts
│   │   └── index.ts
│   └── storage/
│       ├── kv/
│       ├── paste/
│       ├── db/
│       ├── sync/
│       ├── queue/
│       ├── memory/
│       └── index.ts
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
│   ├── hiro.ts                 # Hiro API client (with rate limit tracking)
│   └── tenero.ts               # Tenero API client
├── utils/
│   └── ...
└── types.ts
```

---

## Usage Tracking (Dashboard-Ready)

### UsageDO Schema

```sql
-- Per-request usage records
CREATE TABLE usage (
  request_id TEXT PRIMARY KEY,
  endpoint TEXT NOT NULL,
  category TEXT NOT NULL,
  payer_address TEXT NOT NULL,
  pricing_type TEXT NOT NULL,      -- 'fixed' | 'dynamic'
  tier TEXT,                        -- For fixed pricing
  amount_charged INTEGER NOT NULL,  -- microSTX
  token TEXT NOT NULL,
  -- Dynamic pricing details (nullable)
  model TEXT,
  input_tokens INTEGER,
  output_tokens INTEGER,
  -- Metadata
  timestamp INTEGER NOT NULL,
  duration_ms INTEGER
);

-- Daily aggregates for dashboard
CREATE TABLE daily_stats (
  date TEXT NOT NULL,
  category TEXT NOT NULL,
  endpoint TEXT NOT NULL,
  total_requests INTEGER DEFAULT 0,
  total_revenue INTEGER DEFAULT 0,
  unique_payers INTEGER DEFAULT 0,
  PRIMARY KEY (date, category, endpoint)
);
```

### Dashboard Queries

- Revenue by category/endpoint (daily, weekly, monthly)
- Top payers by volume
- Endpoint popularity
- Token distribution (STX vs sBTC vs USDCx)
- Average request duration by endpoint

---

## Infrastructure

### wrangler.jsonc

```jsonc
{
  "name": "x402-api",
  "compatibility_date": "2025-01-08",
  "observability": { "enabled": true },

  "services": [{ "binding": "LOGS", "service": "worker-logs" }],

  "kv_namespaces": [
    { "binding": "METRICS", "id": "TBD" },
    { "binding": "STORAGE", "id": "TBD" }
  ],

  "ai": { "binding": "AI" },

  "durable_objects": {
    "bindings": [
      { "name": "USAGE_DO", "class_name": "UsageDO" },
      { "name": "STORAGE_DO", "class_name": "StorageDO" }
    ],
    "migrations": [{ "tag": "v1", "new_classes": ["UsageDO", "StorageDO"] }]
  },

  "vars": {
    "X402_FACILITATOR_URL": "https://facilitator.stacksx402.com",
    "X402_NETWORK": "mainnet"
  },

  "env": {
    "staging": {
      "routes": [{ "pattern": "x402.aibtc.dev", "custom_domain": true }],
      "vars": {
        "X402_NETWORK": "testnet"
      }
    },
    "production": {
      "routes": [{ "pattern": "x402.aibtc.com", "custom_domain": true }]
    }
  }
}
```

### Secrets (via `wrangler secret put`)

| Secret               | Purpose                              | Required For              |
| -------------------- | ------------------------------------ | ------------------------- |
| `OPENROUTER_API_KEY` | OpenRouter API access                | `/inference/openrouter/*` |
| `HIRO_API_KEY`       | Hiro API access (better rate limits) | `/stacks/*`               |

**Hiro API Key Setup:**

1. Register at https://platform.hiro.so/
2. Create API key in dashboard
3. Set via `wrangler secret put HIRO_API_KEY`

**Rate Limit Headers (Hiro):**

- `X-RateLimit-Limit` - Max requests per window
- `X-RateLimit-Remaining` - Requests left in window
- `X-RateLimit-Reset` - Unix timestamp when window resets

Consider caching these values and returning them in response headers for client awareness.

### package.json

```json
{
  "dependencies": {
    "@stacks/transactions": "^7.3.1",
    "chanfana": "^3.0.0",
    "hono": "^4.11.3",
    "openai": "^6.15.0",
    "qrcode": "^1.5.4",
    "x402-stacks": "^1.1.1",
    "zod": "^4.3.5"
  },
  "devDependencies": {
    "@cloudflare/workers-types": "^4.20260109.0",
    "typescript": "^5.9.3",
    "wrangler": "^4.58.0"
  }
}
```

### tsconfig.json

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ES2022",
    "strict": true,
    "skipLibCheck": true,
    "types": ["@cloudflare/workers-types"]
  }
}
```

---

## Implementation Phases

### Phase 1: Core Infrastructure

- [ ] Update `wrangler.jsonc` (KV, AI, DOs, domains)
- [ ] Add dependencies (chanfana, zod)
- [ ] Create `src/endpoints/base.ts` with pricing strategy
- [ ] Update `src/middleware/x402.ts` for hybrid pricing
- [ ] Create `src/services/pricing.ts`
- [ ] Set up Scalar docs at `/docs`

### Phase 2: Durable Objects

- [ ] Create `UsageDO` with schema and RPC methods
- [ ] Create `StorageDO` (or adapt from stx402's UserDurableObject)
- [ ] Add metrics middleware for usage tracking

### Phase 3: Inference Endpoints

- [ ] Create `/inference/openrouter/` directory structure
- [ ] Migrate OpenRouter list-models (free) from x402-api
- [ ] Migrate OpenRouter chat (dynamic pricing) from x402-api
- [ ] Create `/inference/cloudflare/` directory structure
- [ ] Create Cloudflare AI list-models endpoint (free)
- [ ] Create Cloudflare AI chat endpoint (fixed `ai` tier)
- [ ] Test payment flows (dynamic + fixed)

### Phase 4: Stacks Endpoints

- [ ] Create `src/services/hiro.ts` (API client with rate limit tracking)
- [ ] Create `src/services/tenero.ts` (API client)
- [ ] Set up HIRO_API_KEY secret
- [ ] Migrate address conversion from stx402
- [ ] Migrate decode endpoints from stx402
- [ ] Create profile aggregation endpoint (Hiro + Tenero)
- [ ] Create signature verification endpoints (message + SIP-018)

### Phase 5: Hashing Endpoints

- [ ] Migrate all 6 hash endpoints from stx402
- [ ] Verify Clarity compatibility

### Phase 6: Storage Endpoints

- [ ] Set up storage subdirectory structure
- [ ] Migrate KV endpoints (4)
- [ ] Migrate paste endpoints (3)
- [ ] Migrate database endpoints (3)
- [ ] Migrate sync/lock endpoints (5)
- [ ] Migrate queue endpoints (5)
- [ ] Migrate memory endpoints (5)

### Phase 7: Testing & Documentation

- [ ] End-to-end payment tests (fixed + dynamic)
- [ ] Usage tracking verification
- [ ] OpenAPI documentation review
- [ ] Deploy to staging (x402.aibtc.dev)

---

## Resolved Decisions

| Question                        | Decision                                                                |
| ------------------------------- | ----------------------------------------------------------------------- |
| Storage subdirectories?         | ✅ Yes - `/storage/kv/*`, `/storage/paste/*`, etc.                      |
| Keep vector embeddings?         | ✅ Yes - uses CF AI for embedding generation                            |
| Inference provider separation?  | ✅ Subdirectories: `/inference/openrouter/*`, `/inference/cloudflare/*` |
| Stacks profile APIs?            | ✅ Hiro API (with API key) + Tenero API                                 |
| Code reuse from stacks-tracker? | ✅ Reference patterns, rewrite fresh                                    |
| Hiro API key rotation?          | ✅ Single key (no rotation initially)                                   |
| Chainhooks integration?         | ✅ Not needed (request/response only)                                   |

---

## Open Questions

1. **Free endpoints**: Which endpoints should be free (no payment)?

   - Confirmed free: `/inference/openrouter/list-models`, `/inference/cloudflare/list-models`
   - Consider: `/health`, `/docs`, OpenAPI spec endpoint
   - **Decision needed**: Any others?

2. **Rate limiting**: Add per-payer rate limits beyond payment?

   - Could use UsageDO to track request counts
   - Prevent abuse even with valid payments
   - **Decision needed**: Implement now or defer?

3. **Stacks profile data sources**: Final list of what to aggregate?
   - Block height: Hiro API
   - BNS name: Hiro API
   - STX balance: Hiro API
   - FT balances: Hiro API + Tenero (for pricing)
   - NFT balances: Hiro API
   - **Decision needed**: Include wallet activity/history?

---

## Potential Blockers

### Must Have Before Launch

| Blocker             | Status     | Owner | Notes                                     |
| ------------------- | ---------- | ----- | ----------------------------------------- |
| Hiro API key        | ⏳ Pending | -     | Register at platform.hiro.so              |
| KV namespace IDs    | ⏳ Pending | -     | Create via `wrangler kv:namespace create` |
| Domain DNS setup    | ⏳ Pending | -     | x402.aibtc.com, x402.aibtc.dev            |
| worker-logs service | ✅ Exists  | -     | Already deployed at wbd.host              |

### Should Verify

| Item                       | Risk   | Mitigation                            |
| -------------------------- | ------ | ------------------------------------- |
| Chanfana + strict TS       | Medium | May need type adjustments from stx402 |
| DO migration from x402-api | Low    | OpenRouterDO → UsageDO schema change  |
| OpenRouter streaming       | Low    | Already working in x402-api           |
| CF AI model availability   | Low    | Check available models match needs    |

### Nice to Have (Can Defer)

- Dashboard UI for usage stats
- Rate limiting implementation
- Webhook notifications for high usage
- Multi-currency price display in 402 responses

---

## Endpoint Count Summary

| Category  | Count  | Pricing                 | Free            |
| --------- | ------ | ----------------------- | --------------- |
| inference | 4      | Mixed (dynamic + fixed) | 2 (list-models) |
| stacks    | 6      | Fixed                   | 0               |
| hashing   | 6      | Fixed                   | 0               |
| storage   | 25     | Fixed                   | 0               |
| **Total** | **41** | Mixed                   | **2**           |

Plus system endpoints (always free):

- `GET /` - Service info
- `GET /health` - Health check
- `GET /docs` - Scalar OpenAPI UI

---

## Resources

### x402 Protocol

- [x402 Protocol](https://www.x402.org/)
- [x402 GitHub](https://github.com/coinbase/x402)
- [x402-stacks npm](https://www.npmjs.com/package/x402-stacks)

### Cloudflare

- [Durable Objects](https://developers.cloudflare.com/durable-objects/)
- [SQLite in DOs](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/)
- [Service Bindings](https://developers.cloudflare.com/workers/runtime-apis/bindings/service-bindings/)
- [Workers AI](https://developers.cloudflare.com/workers-ai/)

### OpenRouter

- [API Reference](https://openrouter.ai/docs/api/reference/overview)
- [Streaming](https://openrouter.ai/docs/api/reference/streaming)
- [Usage Accounting](https://openrouter.ai/docs/use-cases/usage-accounting)

### Stacks

- [Hiro API](https://docs.hiro.so/stacks/api)
- [Tenero API](https://docs.tenero.io/)
- [@stacks/transactions](https://github.com/hirosystems/stacks.js/tree/main/packages/transactions)

### Local References

- `~/dev/whoabuddy/stacks-tracker/` - Hiro client, Clarity types, rate limiting patterns
- `~/dev/whoabuddy/stx402/` - Production endpoints to migrate
- `~/dev/whoabuddy/worker-logs/` - Universal logging service
