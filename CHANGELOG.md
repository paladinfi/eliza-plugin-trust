# Changelog

All notable changes to `@paladinfi/eliza-plugin-trust` are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.1] - 2026-05-10

Doc-only patch. No code or runtime changes — paired distribution artifact for PaladinFi server v0.11.73 (per Distribution Discipline Gate). v0.1.0 customers see no behavior change beyond what the server-side v0.11.73 contract change already delivers.

### Changed

- **README**: removed stale "lookalike detection" feature claim from 5 spots (lede, "Why this vs..." section, "What it does" table, TS source-union, v0.3.0 roadmap). Lookalike-symbol detection was removed from PaladinFi production in server v0.11.62 (2026-05-04); the README was not updated at that time.
- **README**: paid-mode response semantics now document the v0.11.73 fail-closed contract. When an underlying source (OFAC, anomaly heuristics, scam-intel) is temporarily unreachable, the factor is included with `real: false` and `signal: "unreachable"`, contributing 0 to `risk_score`. If all sources are unreachable, the response returns `recommendation: "warn"` instead of the prior `recommendation: "allow"` (closes a silent-allow vector that existed since server v0.11.50).
- **README**: TS `TrustCheckResponse` factor `source` union widened to include `"paladin.anomaly"` and `"scam_intel"` — paid-mode emits these source strings; the v0.1.0 union under-represented the production response shape (preview emits `"anomaly"` but paid emits `"paladin.anomaly"` for the same factor; `"scam_intel"` wraps GoPlus + Etherscan and appears on paid responses when those upstreams are unreachable).
- **README**: added Security & disclosures bullet documenting server v0.11.73 contract reference + behavior change advisory for clients keying off `recommendation: "allow"`.
- **README**: v0.3.0 roadmap line rewritten to drop the "lookalike action" specificity (replaced with generic "transfer-time risk hook for address-poisoning detection").
- **package.json**: description updated to drop stale "lookalike" reference; `keywords` removed `"lookalike"` entry.

## [0.1.0] - 2026-05-04

First functional release. Closes the v0.0.x scope gap (LLM extraction + paid x402 settlement). Tracking issue [#1](https://github.com/paladinfi/eliza-plugin-trust/issues/1).

Audit trail: plan v1 REJECTED at adversarial review (wallet-drain CRITICAL) → plan v2 REJECTED (deprecated x402 lib version) → plan v3 informed by 30-min `@x402/fetch@2.11.0` empirical spike → plan v3 APPROVED-WITH-MINOR-FIXES (3-of-3 reviewers convergent) → plan v3.1 incorporates polish → implementation. Memory: `eliza_outbound_2026-05-02.md` Lesson 6, `feedback_no_deploy_without_adversarial_review.md`, `feedback_self_audit_before_review_2026-04-30.md`.

### Added

- **Paid x402 settlement** in `PaladinTrustClient.paid()` via `@x402/fetch@2.11.0` + `@x402/evm@2.11.0` + `@x402/core@2.11.0` (all pinned exact, not caret).
- **`onBeforePaymentCreation` pre-sign hook** in the x402 client that runs `validatePaladinContext()` against the actual fields the library is about to sign over. Aborts client-side via `{ abort: true, reason }` BEFORE any viem signing if any field deviates from hard-coded constants.
- **`validatePaladinContext`** in `src/x402/validate.ts` — 6 deterministic checks closing wallet-drain, Permit2 downgrade, x402 v1 downgrade, long-lived-signature (1-yr), EIP-712 domain spoof, scheme/network/asset/payTo/amount equality. Pure function, exported, unit-tested.
- **`createPaladinTrustPlugin({ walletClientAccount, apiBase?, defaultChainId?, mode? })` factory** with TRUE boot-time validation: throws synchronously if (a) paid mode requested without walletClientAccount, (b) walletClientAccount lacks `signTypedData` (rejects JsonRpcAccount/SmartAccount), (c) paid mode + non-HTTPS apiBase. Fails at agent startup, not at first message.
- **LLM prompt-template extraction** for `paladin_trust_check` via `composePromptFromState` + `runtime.useModel(ModelType.TEXT_SMALL)` + `parseKeyValueXml` — same pattern as `@elizaos/plugin-evm/transfer.ts`. Programmatic `options.address` bypass preserved.
- **Validator wallet-readiness gate** — `validate()` returns `false` in paid mode if no walletClientAccount, so the agent doesn't surface the action when it can't deliver.
- **`scrubViemError(e: unknown): string`** in `src/errors.ts` — bounded error summary that never propagates `error.cause`/`error.details` (would leak request init / signed payload via viem's debug chain). Used at every paid-path error site.
- **`tests/x402-validate.test.ts`** (17 assertions: happy path + protocol downgrades + Permit2 + scheme/network/asset/payTo/amount + validity bounds + EIP-712 domain spoofs + boundary cases).
- **`tests/boot-validation.test.ts`** (7 assertions: preview default, paid+wallet, paid-without-wallet throw, signTypedData missing throw, mode inference, non-HTTPS-paid throw, non-HTTPS-preview allowed).
- **vitest** added as devDep + `test` / `test:watch` scripts in package.json. Tests live at project root `tests/` (excluded from tsconfig + tarball).
- **`x402` constants module** (`src/x402/constants.ts`): `PALADIN_TREASURY`, `BASE_USDC`, `BASE_NETWORK`, `MAX_TRUST_CHECK_AMOUNT` (10_000n / $0.01 cap), `X402_VERSION` (2), `USDC_DOMAIN_NAME`/`VERSION`, `MAX_VALIDITY_SECONDS` (600), `PALADIN_API_DEFAULT`. Re-exported from package root.
- **README expanded** to 4 named subsections (Why this vs. other agent-trust plugins / Quick start preview mode / Paid mode wiring / Migration from v0.0.x). Plus pre-sign safety section, library trust + Eliza alpha drift in disclosures.

### Changed

- **`@elizaos/core` peerDep pinned exact `2.0.0-alpha.77`** (was `^2.0.0-alpha.77`). The alpha line drifts between releases; explicit pin protects integration.
- **Paid mode env-only path now degrades to preview with one-time warn** (instead of throwing) when `PALADIN_TRUST_MODE=paid` is set but no walletClientAccount was passed via the factory. Backwards-compatible with v0.0.x users who set the env var without the factory wiring.
- **`PALADIN_TRUST_ALLOW_INSECURE` documented as preview-mode-only.** Paid mode is HTTPS-only regardless of the override.

### Verified

- `tsc --noEmit -p tsconfig.json` — clean
- `npm run build` — clean dist
- `npm run test` — `tests/x402-validate.test.ts` (17/17) + `tests/boot-validation.test.ts` (7/7) pass
- 30-min `@x402/fetch@2.11.0` spike against live `https://swap.paladinfi.com/v1/trust-check` (2026-05-03) verified the API surface, hook context shape, and 402 challenge fields byte-for-byte
- **Manual paid smoke test against live `/v1/trust-check` from permanent test wallet `0x18779E54787320aE9Ab997F2ba3fC6E31D2A0aC1`**: pre-sign hook fired exactly once with PaladinFi's challenge, all 6 `validatePaladinContext` checks passed, EIP-3009 signed via viem, $0.001 USDC settled to PaladinFi treasury `0xeA8C33d018760D034384e92D1B2a7cf0338834b4`. Settled tx: [`0x6c083d0b35e67a9884d4defec92322913276062940bb2559bf57e9193584fc45`](https://basescan.org/tx/0x6c083d0b35e67a9884d4defec92322913276062940bb2559bf57e9193584fc45). Response: `recommendation: allow`, 5 real factors (ofac/paladin.anomaly/goplus/etherscan_source x2). Both `smoke-paid.mjs` (direct x402 stack) and `smoke-paid-via-client.mjs` (PaladinTrustClient.paid() public API) pass.
- Pre-publish 3-adversary review on the implementation (Engineering + Security + Maintainer) — pending before npm publish per `feedback_no_deploy_without_adversarial_review.md`

### Schema fixes empirically caught during smoke (2026-05-04)

- **`request_id` is now optional** on `trustCheckResponseSchema` (was required). Live paid `/v1/trust-check` responses do NOT include `request_id` (preview responses do); previous required schema rejected all paid responses with "schema validation failed."
- **`real` on `trustFactorSchema` defaults to `true`** (was required). Paid responses don't include `real` per factor (it's implicit `true`); preview responses include `real: false` explicitly. Default keeps the action-handler's `f.real ? "" : " (sample)"` rendering correct in both modes.
- Both bugs would have caused 100% paid-mode failure in production. Caught by manual smoke against live API; included in v0.1.0 release.

### Pre-publish 3-adversary review fixes (2026-05-04)

Engineering + Security + Maintainer reviewers all returned APPROVE-WITH-MINOR-FIXES. No HIGH/CRITICAL findings; no REJECT verdicts. All MED-sev findings applied:

**Architectural refactor (Engineering H1):**

- Replaced runtime symbol-slot decoration (`FACTORY_DEFAULTS_KEY`) with action-factory closure (`makeTrustCheckAction(factoryDefaults?)`). Previous approach had a load-order race when both the default `paladinTrustPlugin` and `createPaladinTrustPlugin({ walletClientAccount })` were registered on the same runtime — first action to fire would freeze the slot, silently downgrading the second plugin's mode. New approach: each plugin instance carries its own factoryDefaults via closure; no runtime mutation. `FACTORY_DEFAULTS_KEY` removed from public API; `decorateRuntime` deleted.
- New public export: `makeTrustCheckAction(factoryDefaults?)` — exposes the same closure pattern for callers who want a custom Plugin shell around the bound action.

**Defense-in-depth (Security M1, M2):**

- `PaladinTrustClient` constructor now also enforces HTTPS in paid mode (mirrors the factory's boot-time check). Direct `new PaladinTrustClient({ mode: "paid", apiBase: "http://..." })` now throws.
- `registerExactEvmScheme` is called with an explicit `policies: [(_v, reqs) => reqs.filter(r => r.network === BASE_NETWORK)]` filter. The `networks: [BASE_NETWORK]` argument scopes v2 only — v1 EIP-3009 schemes are auto-registered for all 21 EVM networks regardless. The policy filter ensures no v1 path can sign for a non-Base network, even if the pre-sign hook is regressed in a future change.

**Operational quality (Engineering H2):**

- Hook-abort errors are now surfaced verbatim with a distinct `paladin-trust BLOCKED pre-sign:` prefix so operators can grep / alert on them. Previously the `reason` string from `{ abort: true, reason: ... }` was lost in `scrubViemError`.

**LLM extraction hardening (Engineering M3, M5):**

- `parseKeyValueXml` output is now validated against a Zod schema (`z.object({ address: z.string().optional(), chainId: z.union([z.string(), z.number()]).optional(), taker: z.string().optional() })`) before use. A misbehaving LLM emitting nested tags or non-string values returns `{}` instead of crashing the handler.
- `pickRequest` now THROWS on a malformed `taker` (was silently dropped). The user might be relying on the taker passing through; failing loud is safer than silent semantic drift.

**Other Engineering fixes:**

- `isAddress(v, { strict: false })` for both action `pickRequest` and request schema — accepts lowercase-or-checksummed addresses uniformly (LLM extraction commonly returns lowercase).
- `_paidWarnEmitted` is now a `WeakSet<runtime>` instead of module-global state. Different runtimes get their own warns; doesn't pin runtimes against GC.
- `client.preview()` now uses `safeParse` (was `parse`), matching the paid path. Generic error message; no ZodError leakage.
- Action handler now returns `{ success: false, text: scrubViemError(e) }` on errors instead of throwing — matches Eliza convention.

**Maintainer fixes:**

- README Quick start now notes both `Plugin[]` (object form) and `string[]` (npm-name form) registration patterns, with a clarifying line.
- README Migration includes the alpha-recovery path: `--legacy-peer-deps` + issue link if alpha.78+ peer warnings appear.
- README adds a top-line cost callout in Paid mode wiring (`$0.001/call. Fund $0.10 USDC + $0.50 ETH for ~100 checks.`).
- README Pre-sign safety section calls out the `paladin-trust BLOCKED pre-sign:` log prefix so operators know what to grep.
- README clarifies that paid responses **omit** the `real` field on factors (schema defaults to `true`).
- Action description string trimmed of "$0.001 USDC/call when in paid mode" — the LLM tool catalog no longer surfaces paid-mode pricing in preview-mode contexts.
- Examples array adds a negative case (action shouldn't fire on unrelated messages).
- `peerDependenciesMeta.optional: false` block dropped (redundant — peerDep alone says required).
- New manifest entry `PALADIN_TRUST_ALLOW_INSECURE` declared in `agentConfig.pluginParameters` with explicit "preview-mode-only, no effect on paid" wording.
- `package.json` adds `"engines": { "node": ">=20" }`.
- `viem` pinned exact (was `^2.21.0`); security-critical signing path shouldn't drift on minor.

**Test coverage additions:** `tests/boot-validation.test.ts` adds 2 cases for `PaladinTrustClient` direct-construction HTTPS gate (paid throws / preview allows). 26/26 tests pass.

**Audit trail:** Three reviewer reports captured for the audit record; v0.1.0 ships with all MED-sev fixes applied. Confidence: HIGH on funds-loss (Security audit found no path to drain beyond documented $0.001/call cap or to leak the test wallet key); MEDIUM on Eliza alpha API drift (mitigated by exact peer pin + Migration recovery path).

## [0.0.2] - 2026-05-03

Retrospective adversarial-review patch. Caught by 3-adversary review (Engineering+Security + Maintainer) on the v0.0.1 ship after the deploy-without-review gap was codified (memory: `feedback_no_deploy_without_adversarial_review.md`).

### Fixed

- **`@elizaos/core` moved from `dependencies` to `peerDependencies`.** Plugin frameworks must let the host runtime provide the framework — bundling our own copy of `@elizaos/core` would cause duplicate-install issues where the host's `Plugin` symbol doesn't `===` ours and runtime registration silently fails. Standard third-party plugin convention.
- **`paid` mode now gracefully degrades to `preview` with a one-time `console.warn`.** v0.0.1 threw at handler-time if `PALADIN_TRUST_MODE=paid` was set — but the public docs advertise paid mode as a configuration option. Users following the docs hit the throw on first NL invocation. v0.0.2 silently downgrades + warns once. v0.1.0 wires real paid x402 settlement.
- **HTTPS enforcement on `PALADIN_TRUST_API_BASE`.** v0.0.1 accepted any URL scheme. v0.0.2 rejects non-HTTPS bases unless `PALADIN_TRUST_ALLOW_INSECURE=1` is set (testnet/dev) or the host is `localhost`/`127.0.0.1`. Closes the silent-malicious-base attack vector.
- **`recommendation` Zod schema tightened from `z.string()` to `z.enum(TRUST_RECOMMENDATIONS)`.** v0.0.1 accepted arbitrary strings — a server-side typo (`"alllow"`) would silently pass validation and the agent would branch on it as `verdict === "allow"`. v0.0.2 fails parse on unrecognized values.
- **`CHANGELOG.md` now included in published tarball.** v0.0.1's `files` array omitted it.

### No breaking changes for v0.0.1 consumers

- The peerDep shift requires `@elizaos/core` already installed in the host project — which is the assumption for any Eliza plugin. No code change required for v0.0.1 consumers.
- The `paid` mode degrade is silent (was a throw before); existing callers with `PALADIN_TRUST_MODE=paid` env now succeed instead of fail. Strict regression-safe.
- HTTPS enforcement only fires on misconfigured `PALADIN_TRUST_API_BASE`. Default config is HTTPS already.
- Zod tightening only fails on responses the server should never return. If you observe parse failures in v0.0.2 you found a real server bug.

### Verified

- Adversarial review on v0.0.1 (4 reviewers in parallel: Engineering+Security and Maintainer for each of `eliza-plugin-trust` and the sister `agentkit-actions`).
- All HIGH-sev findings from review applied; no MED-sev findings deferred.
- `tsc --noEmit` clean.
- `npm run build` emits clean dist.
- `node smoke-test.mjs` all checks pass against live API.

## [0.0.1] - 2026-05-02

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

[Unreleased]: https://github.com/paladinfi/eliza-plugin-trust/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/paladinfi/eliza-plugin-trust/releases/tag/v0.1.0
[0.0.2]: https://github.com/paladinfi/eliza-plugin-trust/releases/tag/v0.0.2
[0.0.1]: https://github.com/paladinfi/eliza-plugin-trust/releases/tag/v0.0.1
