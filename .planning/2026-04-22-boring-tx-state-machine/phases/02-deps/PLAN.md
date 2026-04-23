# Phase 2: Branch Setup + Deps

Date: 2026-04-22
Phase: 02-deps

## Goal

Fresh feature branch `feat/boring-tx-state-machine` off latest `origin/main` with
`@aibtc/tx-schemas` bumped to `^1.0.0`. Baseline `npm run check` and
`npm run deploy:dry-run` clean BEFORE any logic changes.

## What Was Done

### Branch Setup

- Local `main` had diverged from `origin/main` (local had Phase 1 planning commit,
  origin/main had 4 newer commits including `e6ba205`, `457e955`, `ed24545`, `46b8693`)
- Stashed `tests/_shared_utils.ts` (Phase 7 staged changes) to keep a clean working tree
- Fetched `origin/main` (latest: `46b8693 chore(main): release 1.6.1`)
- Created `feat/boring-tx-state-machine` off `origin/main`
- Cherry-picked Phase 1 planning commit (`c1b46b5` → `f881569` on feature branch)
- Popped stash to restore `tests/_shared_utils.ts` modification

### Dependency Bump

Phase 1 NOTES.md identified (R1 in Risk List):
- Installed version: `@aibtc/tx-schemas@1.0.0`
- package.json constraint: `^0.3.0` — this does NOT resolve 1.0.0 for 0.x.y semver locking
- Latest published on npm: `1.0.0`
- Action required: bump constraint to `^1.0.0`

Updated `package.json`:
```
"@aibtc/tx-schemas": "^0.3.0"  →  "@aibtc/tx-schemas": "^1.0.0"
```

Ran `npm install` → `@aibtc/tx-schemas@1.0.0` resolved correctly.

### Patch File Removal (Mechanical Cleanup)

During `npm install`, `patch-package` (postinstall hook) errored applying
`patches/x402-stacks+2.0.1.patch`. Investigation showed the patch changes
(bump HTTP client timeout from 30000ms/15000ms to 120000ms) are now incorporated
upstream in x402-stacks itself — both `dist/verifier-v2.js` and `dist/verifier.js`
already have `timeout: 120000`. The patch file was stale.

Removed: `patches/x402-stacks+2.0.1.patch`

This is a mechanical cleanup — no behavioral change (timeout is 120000ms before and
after). The installed package already contains the desired timeout value.

### Import Path Verification

No import-path changes were required. The existing import in
`src/utils/payment-contract.ts` uses `@aibtc/tx-schemas/core` sub-path:
```ts
import { CanonicalDomainBoundary, PAYMENT_STATES } from "@aibtc/tx-schemas/core";
```
This sub-path was present in v0.3.0 and remains available in v1.0.0 — no breakage.

### Baseline Verification

- `npm run check` (tsc --noEmit): exits 0, no errors
- `npm run deploy:dry-run`: builds successfully (1027.76 KiB / gzip: 272.26 KiB)
- `tests/_shared_utils.ts`: still shows as modified, not committed (preserved for Phase 7)

## Files Changed in Phase 2 Commit

| File | Change |
|------|--------|
| `package.json` | `@aibtc/tx-schemas` constraint `^0.3.0` → `^1.0.0` |
| `package-lock.json` | Lockfile update for tx-schemas resolution |
| `patches/x402-stacks+2.0.1.patch` | Deleted (stale patch, fix now upstream) |
| `.planning/…/phases/02-deps/PLAN.md` | This file |

## Not Included in Commit

- `tests/_shared_utils.ts` — preserved for Phase 7 (NonceTracker + signPaymentWithNonce)
