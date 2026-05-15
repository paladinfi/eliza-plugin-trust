# @paladinfi/eliza-plugin-trust

**Pre-trade trust gate + cryptographically-verified swap routing for ElizaOS evm agents** on Base. Single x402-paid call against [PaladinFi](https://swap.paladinfi.com).

[![CI](https://github.com/paladinfi/eliza-plugin-trust/actions/workflows/ci.yml/badge.svg)](https://github.com/paladinfi/eliza-plugin-trust/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Chain](https://img.shields.io/badge/chain-Base%208453-2563eb)](https://basescan.org/)
[![npm](https://img.shields.io/badge/npm-v0.2.0-cb3837)](https://www.npmjs.com/package/@paladinfi/eliza-plugin-trust)

---

## What's new in v0.2.0

`paladin_swap` — a combined Action that owns the full swap sequence: **trust-check + swap-quote + cryptographically-verified server-side simulation + signed calldata return**. Your agent's wallet signs the resulting transaction; PaladinFi never holds funds. Designed for indie hackers + Eliza developers + small-team agent builders. v0.3.0+ adds fintech-treasury / 50-person-fleet features (audits, multi-region, SLA).

The v0.1.0 `paladin_trust_check` action is unchanged and continues to work without any config change.

> **⚠ MUST READ before setting `paladinSwapEnabled: true`:** v0.2.0 introduces a new trust model. Read [§Cryptographic verification](#cryptographic-verification-layer-3) and [§Threat model](#threat-model) before enabling. The `paladin_swap` action verifies signatures against a 2-of-2 KMS pair using software-key custody at v0.2.0; v0.1.0 customers using `paladin_trust_check` only are unaffected.

---

## Quick start

### Preview-mode trust-check (free, no wallet, v0.1.0 unchanged)

```bash
npm install @paladinfi/eliza-plugin-trust
```

```ts
import { paladinTrustPlugin } from "@paladinfi/eliza-plugin-trust";

export const character = {
  name: "MyAgent",
  plugins: [paladinTrustPlugin],
};
```

Then in chat: *"check 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913 on Base"* — the LLM extracts the address, calls the preview endpoint, returns a sample-fixture verdict.

### Paid trust-check ($0.001 USDC/call, v0.1.0 unchanged)

```ts
import { privateKeyToAccount } from "viem/accounts";
import { createPaladinTrustPlugin } from "@paladinfi/eliza-plugin-trust";

const account = privateKeyToAccount(process.env.PALADIN_TRUST_KEY as `0x${string}`);

export const character = {
  plugins: [createPaladinTrustPlugin({ walletClientAccount: account })],
};
```

### NEW v0.2.0: paladin_swap ($0.002 USDC/call — trust + simulation)

```ts
import { privateKeyToAccount } from "viem/accounts";
import { createPaladinTrustPlugin } from "@paladinfi/eliza-plugin-trust";

const account = privateKeyToAccount(process.env.PALADIN_TRUST_KEY as `0x${string}`);

export const character = {
  plugins: [
    createPaladinTrustPlugin({
      walletClientAccount: account,
      paladinSwapEnabled: true,        // opt-in
      acknowledgeRisks: true,          // required — see §Threat model
      paladinSwapProfile: "default",   // 'paper-test' | 'default' | 'pro'
      onTrustBlock: "block",           // 'block' | 'report' (default 'block')
    }),
  ],
};
```

Then in chat: *"swap 100 USDC for WETH"* — the action runs trust-check, fetches a quote, validates router/selector/Settler-target, runs server-side Anvil simulation, verifies the signed response, and returns calldata for your wallet to submit.

If `acknowledgeRisks: true` is missing, the factory throws synchronously at agent startup (NOT at first message) — you'll know immediately if you forgot it.

---

## Cost model

| Plugin call | Per-call cost | What you get |
|---|---|---|
| `paladin_trust_check` (preview) | $0 | Sample-fixture verdict; rate-limited |
| `paladin_trust_check` (paid) | $0.001 USDC | Live OFAC + GoPlus + Etherscan + heuristics |
| **`paladin_swap`** | **$0.002 USDC** | **Trust check + signed simulation + verified calldata** |
| Plus the swap itself | 10 bps on swap volume | Integrator fee deducted from buy amount |

**Default profile budget:** $5/day cap = **2,500 paladin_swap calls/day**. Larger budgets via the `pro` profile or per-knob overrides.

**Compared to going direct to 0x or Velora:**
- Direct: free quote + 0 bps integrator fee, but no trust-check, no simulation, no signed verification
- paladin_swap: $0.002 + 10 bps, but you get pre-trade safety + post-quote verification that the quote came from us (not a MITM)

For agents handling treasury or human-impersonating funds, the $0.002 + 10 bps is cheap insurance against scam tokens, replay attacks, and quote-spoofing MITMs.

---

## Choosing your profile

Three pre-set profiles bundle sensible per-token caps + rate limits + spending caps:

| Profile | Sell-amount cap (USDC) | Rate limit | Hourly cap | Daily cap | Default `keyTrustMode` |
|---|---|---|---|---|---|
| `paper-test` | $1 per swap | 1/min | $0.01/hr | $0.10/day | `auto-rotate` |
| **`default`** | $100 per swap | 3/10s | $1/hr | $5/day | `auto-rotate` |
| `pro` | $1000 per swap | 10/10s | $5/hr | $25/day | `pinned` |

`default` is the recommended starting point — caps are conservative enough to make a misconfigured agent affordable to debug, generous enough to handle real swap traffic.

`pro` defaults to `keyTrustMode: 'pinned'` because higher-volume swap workloads imply you want manual control over key rotations rather than auto-following our 30-day rotation cadence. See [§Cryptographic verification](#cryptographic-verification-layer-3).

Override any single knob without picking a different profile:

```ts
createPaladinTrustPlugin({
  paladinSwapProfile: "default",
  maxDailyUsdc: 10,                              // override the $5/day default
  paladinSwapRateLimit: { maxCalls: 5, windowMs: 10_000 },
});
```

---

## Mode: block vs report

`onTrustBlock` decides what happens when the trust-check returns `block`:

- `'block'` (default): the action throws `TRUST_BLOCKED`; agent does not get calldata. Right for production.
- `'report'`: the action proceeds despite the block recommendation; the trust verdict is included in the returned `data.trust` so the agent can branch on it. Right for human-in-the-loop testing where you want to see *why* something would have been blocked.

Per-call override is **tightening-only** — `factory='block'` always wins over `perCall='report'`. The LLM template explicitly does NOT extract this field, so a user can't talk the agent out of blocking via prompt injection.

---

## Customer override matrix

Every factory option, with default + when to change:

| Option | Default | When to override |
|---|---|---|
| `paladinSwapEnabled` | `false` | Set `true` to enable the v0.2.0 action |
| `acknowledgeRisks` | undefined | **MUST be `true`** if `paladinSwapEnabled` |
| `onTrustBlock` | `'block'` | `'report'` for HITL testing |
| `paladinSwapProfile` | `'default'` | `'paper-test'` for CI; `'pro'` for treasury |
| `maxSellAmountByTokenAddress` | from profile | per-token override (lowercased addresses) |
| `paladinSwapRateLimit` | from profile | tighter for low-trust environments |
| `maxHourlyUsdc` | from profile | tighter on shared infra |
| `maxDailyUsdc` | from profile | tighter on shared infra |
| `simulationVerifier` | `'paladin-multikey'` | `'tenderly'` for self-trust customers; `'both'` for AND-of-both |
| `tenderlyConfig` | undefined | Required if `simulationVerifier='tenderly'` or `'both'` |
| `keyTrustMode` | `'auto-rotate'` (default profile) / `'pinned'` (pro profile) | `'pinned'` for treasury-tier customers wanting manual rotation review |
| `pinnedPair` | undefined | Required if `keyTrustMode='pinned'` |
| `freshnessWindowSec` | 600 | Tighter for low-latency agents |
| `paladinSwapDebug` | `false` | `true` for self-triage on errors; see §Debug bundle |
| `debugRedactWalletAddress` | `true` | `false` if compliance allows wallet addresses in logs |
| `acceptVersions` | `['paladin-simulate-v1']` | Add `'paladin-simulate-v2'` during cutover windows |
| `baseRpcUrls` | `DEFAULT_BASE_RPC_POOL` | Override with your own RPC providers (≥2 distinct operators) |
| `clockOverride` | undefined | **TEST-ONLY** — throws if `NODE_ENV=production` |

---

## Error code reference

`paladin_swap` returns one of 27 closed-enum codes via `data.error.code`. First thing to check for the most common:

| Code | First thing to check |
|---|---|
| `INVALID_INPUT` | Zod validation error message in `data.error.message` |
| `TOKEN_NOT_SUPPORTED` | Is the token in `TOKEN_REGISTRY`? v0.2.0 supports 7 tokens on Base |
| `SELL_AMOUNT_EXCEEDS_CAP` | Compare your sellAmount to the active profile's per-token cap |
| `RATE_LIMITED` | Token-bucket exhausted; wait for the window to refresh |
| `HOURLY_CAP_EXCEEDED` / `DAILY_CAP_EXCEEDED` | Spending tracker — wait for the bucket to roll, or raise the cap |
| `WALLET_MISSING` | Pass `walletClientAccount: privateKeyToAccount(...)` to the factory |
| `RESIDUAL_NOT_ACKNOWLEDGED` | Add `acknowledgeRisks: true` to factory options |
| `TRUST_CHECK_FAILED` | Network error to /v1/trust-check; check x402 wallet has USDC + ETH |
| `TRUST_BLOCKED` | Trust-check returned `block`; either accept the block or set `onTrustBlock: 'report'` |
| `QUOTE_FAILED` / `UPSTREAM_LIQUIDITY_NONE` | No liquidity for this pair right now; check Velora / 0x directly |
| `ROUTER_NOT_ALLOWED` | Quote returned a router/selector NOT on our allowlist; usually a server bug — file an issue |
| `SIMULATION_FAILED` | /v1/simulate network error; transient |
| `SIMULATION_REJECTED` | Server-side state-diff caught a third-token drain or revert; the swap WOULD have failed on-chain |
| `RESPONSE_SIG_INVALID` | One of the 2-of-2 KMS signatures didn't recover; check `paladinKeyRegistryAddress` not stale |
| `RESPONSE_STALE` | Customer clock skew; verify `Date.now()` is correct |
| `RESPONSE_VERSION_UNSUPPORTED` | Server is on a newer apiVersion; add to `acceptVersions` or update plugin |
| `RESPONSE_BINDING_MISMATCH` | requestHash or clientNonce mismatch — possible MITM (rare) or canonical-JSON drift |
| `RESPONSE_EPOCH_MISMATCH` / `RESPONSE_EPOCH_REVOKED` | Likely a rotation race; the handler retries once with fresh state |
| `TOKEN_REGISTRY_DRIFT` | Bundled hash ≠ on-chain hash; new token was added server-side; update plugin |
| `PALADIN_REGISTRY_UNREACHABLE` | All Base RPCs failed AND on-disk cache exhausted; check network connectivity |
| `PALADIN_REGISTRY_QUORUM_FAILED` | <2 RPCs agreed; specify a different `baseRpcUrls` pool with distinct operators |
| `SETTLEMENT_UNKNOWN` | x402 settlement state unknowable; reconciled within 5 min via on-chain check |

Set `paladinSwapDebug: true` to get a structured diagnostic blob written to `~/.paladin-trust/debug-bundle.jsonl` with step-by-step timing and metadata.

---

## Debug bundle

`paladinSwapDebug: true` enables JSONL diagnostic output at `debugBundleSinkPath` (default `~/.paladin-trust/debug-bundle.jsonl`). Each `paladin_swap` call appends one entry:

```json
{
  "apiVersion": "paladin-debug-v1",
  "timestamp": 1717000000000,
  "request": {
    "sellTokenSymbol": "USDC",
    "buyTokenSymbol": "WETH",
    "sellAmount": "100",
    "chainId": 8453,
    "selector": "0xe3ead59e"
  },
  "events": [
    { "step": 1, "name": "validateOptions", "ok": true, "durationMs": 0 },
    { "step": 9, "name": "paidTrustCheck", "ok": true, "durationMs": 312, "metadata": {"recommendation": "allow"} },
    { "step": 16, "name": "verifySignature", "ok": true, "durationMs": 28, "metadata": {"usedRetry": false, "ok": true} }
  ],
  "outcome": "success"
}
```

What's NEVER in the bundle (categorical redaction):
- Private keys, mnemonics, seed phrases
- `tenderlyConfig.accessKey`, x402 X-PAYMENT auth headers
- `server_secret`, HMAC integrity keys
- Raw calldata bytes (only the 4-byte selector is logged)
- Signed payload bytes
- Any 32-byte hex string anywhere in metadata (auto-redacted as private-key-shape)

`taker` (wallet address) is **redacted by default**. Set `debugRedactWalletAddress: false` if compliance allows wallet addresses in logs.

The bundle file is size-capped at 50 MB and auto-rotates (truncate-oldest) when it exceeds the cap. Best-effort persistence — disk failures are warned to console.warn but never thrown to the caller.

---

## x402 settlement semantics

Each `paladin_swap` call settles two separate x402 invoices: $0.001 for trust-check + $0.001 for simulation. Both settle async to the underlying agent action — meaning the `paladin_swap` action awaits settlement before returning data.

If the trust-check settles but simulation doesn't, the spending tracker refunds $0.001 (the simulation portion). If simulation succeeds but the trust-check's settlement state is `attempted-unknown` (network flake mid-settlement), the tracker debits + writes a warn-log entry; the customer reconciles within 5 minutes via on-chain x402 settlement event poll.

**Idempotency.** v0.2.0 does NOT cache simulation results across `paladin_swap` invocations. Each call pays anew. If you don't want to pay twice for the same logical swap, your agent should not re-invoke `paladin_swap` with identical inputs unless you actually want to refresh the verdict.

---

## Migrating from v0.1.0

**No changes required for v0.1.0 users.** The `paladin_trust_check` action and the default `paladinTrustPlugin` export are unchanged. v0.2.0 is a semver MINOR bump.

To opt into the new v0.2.0 paladin_swap action:

1. Add `paladinSwapEnabled: true` to your factory options
2. Add `acknowledgeRisks: true` (factory throws synchronously without it)
3. Choose a profile (`paper-test` / `default` / `pro`) or accept the `default`
4. Read [§Threat model](#threat-model) and [THREAT_MODEL.md](./THREAT_MODEL.md) for the full disclosure

The `paladin_swap` action coexists with `paladin_trust_check` in the same plugin instance — the agent picks based on prompt context.

---

## 5-layer defense explanation

The `paladin_swap` action runs through 5 layers before returning calldata. For an attacker to extract funds, ALL layers must be bypassed:

1. **Server-side router/selector/Settler-target whitelist** — only known-good DEX routers (Velora AugustusSwapper v6.2 + 0x AllowanceHolder + 0x Settler) can appear in the quote. Hard deny-list of 7 selectors (ERC20 transferFrom/transfer/approve, Permit2 permitTransferFrom + AllowanceTransfer + permit single/batch) is unconditional.
2. **Client-side mirror** of layer 1 — the plugin runs the same allowlist locally, so a compromised PaladinFi server can't redirect to an attacker's router.
3. **Cryptographic verification of the simulation response.** Server signs each /v1/simulate response with a 2-of-2 KMS pair (AWS Key #1 + GCP Key #2). Plugin verifies signatures + on-chain trust anchor on Base + 7-day rotation timelock + per-response request binding (requestHash + clientNonce + serverObservedTokenRegistryHash).
4. **Server-side Anvil simulation** with multi-token state-diff inspection. The simulator runs the actual calldata against a Base mainnet fork; if any token *other than* sellToken/buyToken changes balance (third-token drain), or if native ETH is drained beyond gas cost, the simulation rejects.
5. **Spending discipline** — per-token sellAmount cap + rate limit + hourly + daily $-cap. Caps blast radius if all other layers somehow fail.

**Documented narrow residual:** block-divergence between simulate-time and execute-time. The simulation runs against state up to ~1 hour old; the actual swap executes minutes later, so pool prices may have moved. minBuyAmount + on-chain slippage protection enforces the floor. This is the residual class `acknowledgeRisks: true` accepts.

---

## Cryptographic verification (Layer 3)

v0.2.0 ships with cryptographic verification of every `/v1/simulate` response. This is the load-bearing security property for `paladin_swap`. Read this section before opting in.

**The signing setup:**
- 2 KMS keys at 2 different cloud providers — AWS KMS (us-east-2) + GCP Cloud KMS (us-east1) — both must sign every response (2-of-2 threshold)
- 1 separate KMS key at a *third* AWS account (us-west-2) signs the public events.json transparency mirror — separate from the /v1/simulate signing pair so events forgery requires a third compromise
- Software-key custody at v0.2.0 (FIPS 140-2 L1; provider-managed). HSM-backed (FIPS 140-2 L3) is a v0.3.0 traction-gated upgrade.

**The trust anchor on Base:**
- A Solidity contract called `PaladinKeyRegistry` on Base mainnet holds the current 2-of-2 trust pair + the indexer attestation key + the canonical TOKEN_REGISTRY hash
- Plugin reads this contract via multi-RPC quorum (≥2 distinct operators)
- All state changes (rotation, token-registry-hash update, indexer-key change, ownership transfer) go through a 7-day timelock
- The owner is a Gnosis Safe 2-of-3 multisig (PaladinFi-controlled in v0.2.0; independent third-party signer joins at v0.3.0 traction gate)

**Customer-side options:**
- `simulationVerifier: 'paladin-multikey'` (default) — verify against our KMS pair
- `simulationVerifier: 'tenderly'` — bypass our verification entirely; use customer's own Tenderly account for simulation
- `simulationVerifier: 'both'` — AND-of-both; rejects if either fails or they disagree on delta direction
- `keyTrustMode: 'pinned'` — manually approve every rotation via npm version bump; no auto-update
- `keyTrustMode: 'auto-rotate'` (default) — plugin reads on-chain registry every 6h + 2h stale-grace

**The customer's defense against PaladinFi insider compromise** is the **7-day rotation timelock** — every malicious rotation is publicly visible on Base for 7 days before it can take effect. Independent observers can detect via block explorer or Tenderly Alerts. v0.2.0's multisig signer set is operationally controlled by PaladinFi; the timelock IS the defense, not the multisig threshold.

For full disclosure: [THREAT_MODEL.md](./THREAT_MODEL.md).

---

## If PaladinFi is unavailable

`paladin_swap` has external dependencies. What happens when each is down:

| Dependency | What breaks | Recovery |
|---|---|---|
| `swap.paladinfi.com` simulator | `SIMULATION_FAILED`; refund | Wait + retry; or use `simulationVerifier: 'tenderly'` |
| Base RPC | `PALADIN_REGISTRY_UNREACHABLE` after 2h grace | Configure additional RPCs in `baseRpcUrls`; or `keyTrustMode: 'pinned'` for offline-resilient |
| 0x or Velora upstreams | `UPSTREAM_LIQUIDITY_NONE` or `QUOTE_FAILED` | Try a different pair; aggregator-side issue |
| Tenderly (only if you opted into `'tenderly'`) | `SIMULATION_FAILED` | Switch to `'paladin-multikey'` |
| Cloudflare Worker (events feed) | Monitoring blind, but plugin still verifies via on-chain | Plugin works regardless |

**Critical 1: cloud-provider account suspension.** If AWS or GCP suspends our account at any of the 3 providers (rare but documented for similar fintech accounts), the auto-rotate path may go dark for **7-10 days** while we provision a replacement. Pinned-mode customers + Tenderly-fallback customers continue working. We're working toward v0.3.0 hot-spare to compress this window.

**Critical 2: PaladinFi disappears.** Customers running `auto-rotate` mode depend on Base RPC + the simulator service. If both are unavailable >2h (the stale-grace window), the plugin fails closed. Customers with `simulationVerifier: 'tenderly'` configured fall back automatically. Customers in `keyTrustMode: 'pinned'` continue working as long as their pinned-pair signature is current. We do **not** have a customer email list at v0.2.0 — updates publish to GitHub Discussions, X (@paladin_fi), and the public events feed.

---

## Pre-publish gate

Before npm publish, the maintainer runs:

```bash
LIVE_DRIFT_CHECK=1 npm test
```

Which validates:
- 27 error codes in enum match README §Error code reference
- TOKEN_REGISTRY hash matches on-chain
- `PALADIN_KEY_REGISTRY_BASE_DEFAULT` matches `paladinfi/contracts/deployments.json` at the pinned commit
- No `Date.now()` outside `clock.ts` (drift-CI grep)
- Profiles have caps for every TOKEN_REGISTRY entry
- DEFAULT_BASE_RPC_POOL satisfies operator-distinctness (≥2 distinct operators)
- 50-fixture cross-language canonical-JSON parity (TS + Python pyjcs)

Customer-side: this is the maintainer's pre-publish gate. You don't run it.

---

## Source visibility + license

- **Plugin code (this repo):** MIT licensed, public on GitHub
- **MCP server source:** MIT licensed, public at https://github.com/paladinfi/paladin-swap-mcp
- **Backend service code:** proprietary (the actual `/v1/quote`, `/v1/trust-check`, `/v1/simulate` server)
- **Solidity contract:** MIT licensed, public at https://github.com/paladinfi/contracts (deployed once + non-upgradable per v0.2.0 design)

We're transparent about what's open vs proprietary so you can assess what you can verify.

---

## Target audience

**Built for indie hackers + Eliza developers + small-team agent builders.** The defaults assume you're operating a single agent or a small fleet at indie scale; the threat model accepts a single-person multisig + software-key KMS custody as honest tradeoffs at this scale.

**Fintech-treasury / 50-person-fleet use cases** are explicitly out-of-scope for v0.2.0. We target these in v0.3.0+ with: SOC 2, multi-region simulator deploy, MSB / MTL clarity (where applicable), 24/7 on-call SLA, audit-firm assessment of the on-chain contract, vendor onboarding paperwork, and an independent third-party signer on the multisig.

If you're at fintech-treasury scale and want to evaluate, we'd love to hear from you (email below) — your inbound is part of the v0.3.0 traction gate.

---

## Threat model

**Brief executive summary — full disclosure in [THREAT_MODEL.md](./THREAT_MODEL.md).**

🔍 **FULL THREAT MODEL: see [./THREAT_MODEL.md](./THREAT_MODEL.md)** ([GitHub](https://github.com/paladinfi/eliza-plugin-trust/blob/main/THREAT_MODEL.md))

v0.2.0's signing setup is **2-of-2** (AWS KMS + GCP Cloud KMS) for `/v1/simulate` responses + a separate single key for the events.json transparency mirror. All keys use **software-key custody** at v0.2.0 (FIPS 140-2 L1 — provider-managed); HSM-backed (FIPS 140-2 L3) is a v0.3.0 traction-gated upgrade. All providers are US-based (different AWS organization for the attestation key vs the signing-pair key).

**The multisig owner is PaladinFi-controlled in v0.2.0** — operationally a single-person trust root despite being a Gnosis Safe 2-of-3, because all 3 signers are operated by the PaladinFi maintainer. The customer's defense against PaladinFi insider compromise is the **7-day rotation timelock**, not the multisig threshold. v0.3.0 adds an independent third-party signer at the same traction gate as HSM upgrade.

**For separation-of-duties customers**, two escape hatches: `keyTrustMode: 'pinned'` (manually approve every rotation via npm version bump; treasury-tier defense) or `simulationVerifier: 'tenderly'` (bypass our verification entirely; use your own Tenderly account). Both are pre-supported v0.2.0 customer options.

**Cloud-account suspension** at any of the 3 providers triggers a 7-10 day fail-closed window for `auto-rotate` customers. v0.3.0 adds a 4th hot-spare KMS provider to eliminate this.

---

## Roadmap

### v0.2.X
- Patch fixes (storage-slot drift on USDC/USDT proxy upgrades; Velora selector additions)
- Optional Velora `swapOnAugustusRFQTryBatchFill` (deferred unless customer-requested)

### v0.3.0 (multichain + scale + trust hardening) — TIGHTENED TRACTION GATE
**Gate (AND-of-2):** ≥10 paying customers each ≥$50/mo for 2 consecutive months **AND** (≥$500/mo total recurring **OR** enterprise binding LOI ≥ $10K with documented signing authority).

When gate fires:
- Multi-chain expansion (Optimism, Arbitrum first)
- Ethereum-mainnet-anchored trust registry variant
- **Independent third-party multisig signer** (4th signer; 3-of-4)
- HSM-backed KMS keys (FIPS 140-2 L3) across all providers
- Multi-admin separation-of-duties on KMS providers
- Hot-spare 4th KMS provider
- Real-time fork refresh < 60s (multi-region)
- Customer email list + status page
- Fee-on-transfer support
- ERC-7683 cross-chain intents

### v0.4.0+ (enterprise)
- SOC 2 / MSB / MTL / vendor onboarding
- `enterprise` profile + multi-region
- 24/7 on-call SLA

---

## Contributing

Open issues / PRs at https://github.com/paladinfi/eliza-plugin-trust or comment on [Eliza Discussion #7242](https://github.com/orgs/elizaOS/discussions/7242).

---

## Operator

Operated by **Malcontent Games LLC**, doing business as **PaladinFi**.

- Public API: https://swap.paladinfi.com
- Health: https://swap.paladinfi.com/health
- Terms: https://paladinfi.com/terms/
- Privacy: https://paladinfi.com/privacy/
- Contact: dev@paladinfi.com

## License

MIT — see [LICENSE](./LICENSE).
