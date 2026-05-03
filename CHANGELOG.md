# Changelog

All notable changes to `@paladinfi/eliza-plugin-trust` are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

Tracking issue: [#1](https://github.com/paladinfi/eliza-plugin-trust/issues/1)

### Planned for v0.1.0 (target ≤ 2026-05-16)

- **LLM prompt-template extraction** — wire the v2-alpha pattern (`composePromptFromState` + `runtime.useModel(ModelType.TEXT_SMALL)` + `parseKeyValueXml`). Action accepts buy-token address from natural-language messages instead of explicit `options.address`.
- **Paid x402 settlement** in `PaladinTrustClient.paid()`. Wire EIP-3009 signing via the agent's wallet runtime. Resolve the 402 challenge issued by `/v1/trust-check`. Settle in USDC on Base (chainId 8453) at $0.001/call.
- **Validator factory** — replace v0.0.1 keyword regex validator with a structured `createTrustCheckActionValidator()` factory matching the `createEvmActionValidator()` pattern in `plugin-evm/typescript/actions/helpers.ts`.
- **Confirmation flow** — adopt the `confirmationRequired` / `isConfirmed` pattern from `transfer.ts` so paid trust-checks surface a preview before settling.
- **Vitest unit + integration tests**, gated live test, smoke-test reproducibility line.
- **Default mode flip** to `paid` once paid path is wired (`preview` remains override-able).

## [0.0.1] - 2026-05-02

Initial **skeleton release**. Anchors the public commitment in [Eliza Discussion #7242](https://github.com/orgs/elizaOS/discussions/7242) with a real public artifact.

### Added

- TypeScript ESM package targeting `@elizaos/core@^2.0.0-alpha.77`.
- `paladinTrustPlugin` exported from `index.ts` — a v2-alpha-shaped `Plugin` object with `actions: [trustCheckAction]`, empty `evaluators`/`providers`.
- `paladin_trust_check` action with:
  - Keyword-based validator (matches `trust-check`, `risk-gate`, `honeypot`, `ofac`, `sanctioned`, `verify-token`, `pre-trade` in message text).
  - Handler that parses `options.address` (explicit, no LLM extraction) and calls `/v1/trust-check/preview` via `PaladinTrustClient`.
  - `examples` array with one happy-path interaction.
  - `similes` for alternate invocation.
- `PaladinTrustClient` class with:
  - `preview()` — POSTs to `/v1/trust-check/preview` and Zod-validates the response shape.
  - `paid()` — currently throws (lands in v0.1.0).
- Zod schemas for `TrustCheckRequest`, `TrustCheckResponse`, `TrustBlock`, `TrustFactor`.
- Runtime config resolver pulling from `runtime.getSetting()` → `process.env` (`PALADIN_TRUST_API_BASE`, `PALADIN_TRUST_MODE`, `PALADIN_TRUST_DEFAULT_CHAIN_ID`).
- `agentConfig.pluginType: "elizaos:plugin:1.0.0"` manifest in `package.json` with `pluginParameters` declarations.
- `smoke-test.mjs` that hits the live preview endpoint and verifies the response shape.
- README, MIT LICENSE, CHANGELOG.

### Intentional v0.0.1 simplifications (vs full v2-alpha pattern in `elizaos-plugins/plugin-evm/transfer.ts`)

- **No LLM prompt-template extraction.** `paladin_trust_check` accepts the buy-token address explicitly via `options.address`. The v2-alpha pattern (`composePromptFromState` + `parseKeyValueXml`) lands in v0.1.0.
- **Preview endpoint only.** v0.0.1 calls `/v1/trust-check/preview` (free, sample fixture). Paid x402 settlement against `/v1/trust-check` requires wallet-runtime EIP-3009 signing, which lands in v0.1.0.

### Verified

- `tsc --noEmit -p tsconfig.json` — zero errors.
- `npm run build` — emits clean `dist/` (`.js` + `.d.ts` + sourcemaps for every src file).
- `npm pack --dry-run` — 17.0 kB tarball, 28 files, no junk.
- `node smoke-test.mjs` — hits live `swap.paladinfi.com/v1/trust-check/preview`, returns `recommendation: "sample-allow"` with 4 factors and `_preview: true`. Round-trip Zod parse passes.

[Unreleased]: https://github.com/paladinfi/eliza-plugin-trust/compare/v0.0.1...HEAD
[0.0.1]: https://github.com/paladinfi/eliza-plugin-trust/releases/tag/v0.0.1
