# x402 Stacks API Host

A Cloudflare Worker that exposes APIs on a pay-per-use basis using the [x402 protocol](https://www.x402.org/) on Stacks.

## Environments

| Environment | Base URL | Network | Docs |
|-------------|----------|---------|------|
| **Production** | `https://x402.aibtc.com` | mainnet | [/docs](https://x402.aibtc.com/docs) |
| **Staging** | `https://x402.aibtc.dev` | testnet | [/docs](https://x402.aibtc.dev/docs) |

## API Categories

- `/inference/*` - LLM chat completions (OpenRouter, Cloudflare AI)
- `/stacks/*` - Blockchain utilities (address, decode, profile, verify)
- `/hashing/*` - Clarity-compatible hashing functions
- `/storage/*` - Stateful operations (KV, paste, DB, sync, queue, memory)

Full endpoint documentation available at `/docs`.

## Payment

All paid endpoints require an `X-PAYMENT` header with a signed Stacks transaction.

**Supported tokens:** STX, sBTC, USDCx (via `X-PAYMENT-TOKEN-TYPE` header)

**Flow:**
1. Request endpoint without payment → receive HTTP 402 with requirements
2. Sign transaction and resend with `X-PAYMENT` header
3. Payment verified, request processed

## Development

```bash
npm install      # Install dependencies
npm run dev      # Local development
npm run check    # Type check
```

> **Note**: Do not run `npm run deploy` directly. Commit and push for automatic deployment.

## Testing

E2E payment tests against live endpoints using the x402 protocol.

### Setup

```bash
# Copy and configure environment
cp .env.example .env

# Set your testnet mnemonic (NEVER use mainnet funds!)
export X402_CLIENT_PK="your twelve word testnet mnemonic"

# Optional: target staging instead of localhost
export X402_WORKER_URL=https://x402.aibtc.dev
```

### Run Tests

```bash
npm test              # Quick mode - stateless endpoints, STX only
npm run test:full     # Full mode - includes lifecycle tests
npm run test:verbose  # With debug output
npm run test:kv       # Just KV lifecycle test

# Filter by category or name
bun run tests/_run_all_tests.ts --category=hashing
bun run tests/_run_all_tests.ts --filter=sha256 --all-tokens
```

### Test Modes

| Mode | Description |
|------|-------------|
| `quick` | Stateless endpoints only (hashing, stacks, inference) |
| `full` | Stateless + lifecycle tests for stateful endpoints |

### Automated Testing

```bash
# Cron job (runs hourly, logs only on failure)
0 * * * * /path/to/x402-api/scripts/run-tests-cron.sh
```

## License

MIT
