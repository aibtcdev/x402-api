# Changelog

## [1.1.0](https://github.com/aibtcdev/x402-api/compare/v1.0.0...v1.1.0) (2026-02-17)


### Features

* **x402:** implement V2 discovery manifest ([#43](https://github.com/aibtcdev/x402-api/issues/43)) ([6012668](https://github.com/aibtcdev/x402-api/commit/6012668bc040d6a81768b2b14bed022aa9e6e46e))


### Bug Fixes

* code hardening - dead code, error safety, deps, and minification ([#46](https://github.com/aibtcdev/x402-api/issues/46)) ([a93c600](https://github.com/aibtcdev/x402-api/commit/a93c6002dc3fcee670d32701fe6ba734d4dcaff5))
* increase x402-stacks verifier timeout to 2 minutes ([#45](https://github.com/aibtcdev/x402-api/issues/45)) ([4a9c1d4](https://github.com/aibtcdev/x402-api/commit/4a9c1d49936cd30b178f187426b5a679fac44819))

## 1.0.0 (2026-02-12)


### Features

* add Bazaar discovery metadata for x402 endpoints ([#35](https://github.com/aibtcdev/x402-api/issues/35)) ([b8ef7ad](https://github.com/aibtcdev/x402-api/commit/b8ef7ad7b3ed566f745d1ba659568b871d0da44e))
* add E2E test infrastructure with x402 payment flow ([#6](https://github.com/aibtcdev/x402-api/issues/6)) ([f579ea0](https://github.com/aibtcdev/x402-api/commit/f579ea08693fbd197c86e2764c24919580442a01))
* add global metrics tracking and dashboard ([#4](https://github.com/aibtcdev/x402-api/issues/4)) ([157eb20](https://github.com/aibtcdev/x402-api/commit/157eb201c3792058d349aa6b6d28124d0b1462e0))
* add lifecycle tests for all storage categories ([#10](https://github.com/aibtcdev/x402-api/issues/10)) ([120d07e](https://github.com/aibtcdev/x402-api/commit/120d07e14b621c061b1dd607e6c626f55d09e17a))
* add LOGS service binding for centralized logging ([#17](https://github.com/aibtcdev/x402-api/issues/17)) ([ae780f2](https://github.com/aibtcdev/x402-api/commit/ae780f26cb320d4ce0f6db906b2b0ea792132001))
* add streaming usage tracking and improve usage endpoint ([83920a8](https://github.com/aibtcdev/x402-api/commit/83920a82cceb8059a1ea8644d82b0d33f7e13af1))
* add x402.json discovery endpoint and simplify dashboard ([#15](https://github.com/aibtcdev/x402-api/issues/15)) ([504ffe6](https://github.com/aibtcdev/x402-api/commit/504ffe64f8de69d7938342b544cf218a231777f5))
* **dashboard:** apply AIBTC branding ([#18](https://github.com/aibtcdev/x402-api/issues/18)) ([9b98ed4](https://github.com/aibtcdev/x402-api/commit/9b98ed43de0009db784258215173bf36853470cc))
* implement full multi-category API per REQUIREMENTS.md ([#3](https://github.com/aibtcdev/x402-api/issues/3)) ([93e8175](https://github.com/aibtcdev/x402-api/commit/93e8175e11ce89dd1b092a58cc0fb20f9780d982))
* implement OpenRouter proxy with usage tracking ([c9e8b48](https://github.com/aibtcdev/x402-api/commit/c9e8b486685707658343e12859e4076698a6206c))
* initial scaffolding for x402 API host ([8de93a0](https://github.com/aibtcdev/x402-api/commit/8de93a09e88d10178b753d0170d2c4c4d1726b3a))
* integrate x402 payment verification for chat completions ([30a8592](https://github.com/aibtcdev/x402-api/commit/30a85921947946907ce75080a494987b340fda0e))
* **x402:** migrate to v2 protocol with Coinbase-compatible format ([#24](https://github.com/aibtcdev/x402-api/issues/24)) ([cec2680](https://github.com/aibtcdev/x402-api/commit/cec26800f1b3a330ef75591449e8c5d1fe179680))


### Bug Fixes

* add BigInt.toJSON polyfill for x402 payment serialization ([#7](https://github.com/aibtcdev/x402-api/issues/7)) ([aaee49e](https://github.com/aibtcdev/x402-api/commit/aaee49e7f339934d803bf437cc773c5dfb99cd0c))
* add retry logic to lifecycle tests for network errors ([#9](https://github.com/aibtcdev/x402-api/issues/9)) ([704188f](https://github.com/aibtcdev/x402-api/commit/704188f1e76b3f3d9c5e42a1736b09e83394a594))
* **cron:** write success marker instead of deleting logs ([#34](https://github.com/aibtcdev/x402-api/issues/34)) ([2c7b45b](https://github.com/aibtcdev/x402-api/commit/2c7b45b39d683ff93c514a1c687ee9eeb5d32482))
* **dashboard:** update columns and fix category persistence ([#16](https://github.com/aibtcdev/x402-api/issues/16)) ([dbf2373](https://github.com/aibtcdev/x402-api/commit/dbf2373ef6d1269df7103eacd8ef084d8b6c2e1c))
* **middleware:** correct endpoint config lookup for dynamic pricing ([#14](https://github.com/aibtcdev/x402-api/issues/14)) ([bb69902](https://github.com/aibtcdev/x402-api/commit/bb69902874fa588fa57c61f6df26ed74f5577e5c))
* resolve stacks endpoint test failures ([#8](https://github.com/aibtcdev/x402-api/issues/8)) ([ac5d6c8](https://github.com/aibtcdev/x402-api/commit/ac5d6c8fbfdfec432b415635f639667380ac9130))
* **tests:** add network flag and per-network log dirs to cron script ([#29](https://github.com/aibtcdev/x402-api/issues/29)) ([16c99c6](https://github.com/aibtcdev/x402-api/commit/16c99c6f63a9a35241cc0b3dfeff32f1ebcf7b36))
* **tests:** add retry logic for nonce conflict errors ([#23](https://github.com/aibtcdev/x402-api/issues/23)) ([0aeb63f](https://github.com/aibtcdev/x402-api/commit/0aeb63f06c3b2dda139db6202bf91da9cc33164d))
* **tests:** correct mainnet USDCx token identifier and add fee tracking ([#19](https://github.com/aibtcdev/x402-api/issues/19)) ([1c12280](https://github.com/aibtcdev/x402-api/commit/1c12280b1e0135bb6dd9edf9ecdc664f8462f25a))
* **tests:** update test runner to use x402 v2 protocol ([8261e37](https://github.com/aibtcdev/x402-api/commit/8261e37f9ab8ccf5dc35a53852b5ce34b201c17a))
* **tests:** update test runner to use x402 v2 protocol ([#25](https://github.com/aibtcdev/x402-api/issues/25)) ([8261e37](https://github.com/aibtcdev/x402-api/commit/8261e37f9ab8ccf5dc35a53852b5ce34b201c17a))
* token contract handling and test validation ([#33](https://github.com/aibtcdev/x402-api/issues/33)) ([2dcc755](https://github.com/aibtcdev/x402-api/commit/2dcc7552aeca165451c336664f4a912a1aeaf32c))
* update facilitator URL to stacksx402.com ([#5](https://github.com/aibtcdev/x402-api/issues/5)) ([7546848](https://github.com/aibtcdev/x402-api/commit/7546848e1525227c0ea1f50de5a3feade5cab563))
