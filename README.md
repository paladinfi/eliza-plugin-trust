# @paladinfi/eliza-plugin-trust

**Pre-trade composed risk gate for ElizaOS evm agents** — OFAC SDN + GoPlus token security + Etherscan source verification + anomaly heuristics + lookalike detection. Single x402-paid call against [PaladinFi](https://swap.paladinfi.com) on Base.

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Chain](https://img.shields.io/badge/chain-Base%208453-2563eb)](https://basescan.org/)
[![npm](https://img.shields.io/badge/npm-v0.1.0-cb3837)](https://www.npmjs.com/package/@paladinfi/eliza-plugin-trust)

---

## Why this vs. other agent-trust plugins?

Most agent-trust plugins focus on *agent identity* — proving that the entity you're talking to is who they claim. `@paladinfi/eliza-plugin-trust` is different: it grades the **token contract risk** of an asset before your agent transacts it. Given an EVM token address, it returns a recommendation (`allow` / `warn` / `block`) plus structured factors covering OFAC SDN status, ownership/proxy patterns, source verification, and lookalike-symbol risk. Use this plugin alongside agent-identity tooling, not instead of it. Preview mode is free and unauthenticated; paid mode settles $0.001 USDC per check via x402 on Base for higher rate limits and signed responses.

## Quick start (preview mode)

```bash
npm install @paladinfi/eliza-plugin-trust
# or pnpm add / bun add
```

```ts
import { paladinTrustPlugin } from "@paladinfi/eliza-plugin-trust";

export const character = {
  name: "MyAgent",
  plugins: [paladinTrustPlugin], // preview-mode by default; no wallet required
  // ...
};
```

If your character config types `plugins` as `string[]` (npm-name resolution at startup), use `["@paladinfi/eliza-plugin-trust"]` instead and ensure the package is installed. Both shapes are supported by Eliza; pick whichever matches your existing setup.

Then in chat: *"check 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913 on Base"* — the action extracts the address (and optionally chainId, taker) from natural language via the standard Eliza v2-alpha prompt-template flow (`composePromptFromState` + `useModel(ModelType.TEXT_SMALL)` + `parseKeyValueXml`) and returns the trust verdict.

For programmatic invocation, pass `options.address` directly to bypass LLM extraction.

Preview responses are sample fixtures: every factor has `real: false` and the recommendation is `sample-` prefixed (`sample-allow` / `sample-warn` / `sample-block`) so a screenshot cannot be cropped into a misleading "real" assessment. Paid responses **omit** the `real` field on each factor (the schema defaults absent values to `true`) and use plain `allow`/`warn`/`block`.

## Paid mode wiring

**Cost: $0.001 USDC per call. Fund a dedicated wallet with ~$0.10 USDC + ~$0.50 ETH (gas reserve, though x402 EIP-3009 settlement is gasless from the agent's perspective) on Base to start. That covers ~100 trust checks.**

Paid mode settles $0.001 USDC per call on Base via [x402](https://x402.gitbook.io/) for higher rate limits and signed responses (every factor `real: true`, recommendation ∈ `{allow, warn, block}`). Requires a viem `LocalAccount`.

```ts
import { privateKeyToAccount } from "viem/accounts";
import { createPaladinTrustPlugin } from "@paladinfi/eliza-plugin-trust";

// Use a DEDICATED plugin wallet — never your treasury / main signing key.
// Fund with ~$0.10 USDC + dust ETH (~$0.50) on Base for ~100 trust checks.
const account = privateKeyToAccount(
  process.env.PALADIN_TRUST_KEY as `0x${string}`,
);

export const character = {
  name: "MyAgent",
  plugins: [
    createPaladinTrustPlugin({
      walletClientAccount: account, // LocalAccount; presence enables paid mode
      // mode: "paid" is inferred when walletClientAccount is present
    }),
  ],
  // ...
};
```

**Pre-sign safety.** Every paid call validates the server's 402 challenge against hard-coded constants (Base USDC contract, PaladinFi treasury address, $0.01 max amount, EIP-3009 only — no Permit2, 10-min validity window cap) inside an `onBeforePaymentCreation` hook. If any field deviates — wrong asset, redirected `payTo`, downgraded protocol version, spoofed EIP-712 domain — the call aborts client-side **before viem signs anything**, and the resulting error is prefixed `paladin-trust BLOCKED pre-sign:` so operators can grep / alert on it. See [`src/x402/validate.ts`](./src/x402/validate.ts) and [`src/x402/constants.ts`](./src/x402/constants.ts) for the full set of checks.

**Boot-time validation.** `createPaladinTrustPlugin({ mode: "paid" })` without a `walletClientAccount` (or with a JsonRpcAccount/SmartAccount that lacks `signTypedData`) throws synchronously at agent startup, not at first message.

**Do not stringify the plugin or its config.** The `walletClientAccount` is held in a closure and attached non-enumerably to the resolved config to avoid accidental serialization, but defensive logging in your own code should still skip the plugins array.

## Migration from v0.0.x

- **Default export still works** — `import { paladinTrustPlugin }` continues to give you preview mode with no config changes.
- **Paid mode now requires explicit wallet injection.** v0.0.x had a placeholder paid path that silently downgraded with a warn; v0.1.0 makes it real and requires `createPaladinTrustPlugin({ walletClientAccount })`. The plugin does **not** auto-resolve `EVM_PRIVATE_KEY` from `runtime.getSetting()` — that's deferred to v0.2.0 to avoid surprising key reuse with `@elizaos/plugin-evm`. If you've been setting `PALADIN_TRUST_MODE=paid` expecting it to work without a wallet, the env-only path still degrades to preview with the warn `[paladin-trust] PALADIN_TRUST_MODE=paid but plugin was constructed without walletClientAccount. Falling back to preview.` — switch to the factory above to actually enable paid.
- **Action name unchanged** — `PALADIN_TRUST_CHECK` (similes: `CHECK_TOKEN_SAFETY`, `PRE_TRADE_TRUST_CHECK`, `PALADIN_TRUST`, `VERIFY_TOKEN`) still registers; existing character configs that reference it by name still work.
- **`@elizaos/core` is now a peerDep, pinned exact to `2.0.0-alpha.77`.** Match this in your project's deps. On `alpha.78+` you'll see a peerDep mismatch warning until we re-pin; the runtime calls (`composePromptFromState`, `useModel`, `parseKeyValueXml`, `ModelType.TEXT_SMALL`) are unlikely to break across patch alphas — file an issue at https://github.com/paladinfi/eliza-plugin-trust/issues if you observe a runtime symptom, or use `--legacy-peer-deps` while waiting for a re-pin.
- **Action handler now accepts natural-language messages.** Pass `options.address` to bypass extraction (programmatic), or send a message like *"verify 0x... on Base"* to trigger LLM extraction.

---

## What it does

| Factor | Source | Cadence |
|---|---|---|
| **OFAC SDN screening** | U.S. Treasury SDN XML feed (cryptocurrency-tagged entries via Feature 345 / Detail 1432) | PaladinFi service refreshes from Treasury every 24 hours |
| **GoPlus token security** | GoPlus trust-list + token-security API (where surfaced) | On-call; recently-deployed contracts may not yet be classified |
| **Etherscan source verification** | Etherscan `getSourceCode` | Cached per `(address, chainId)` |
| **Anomaly heuristics** | Fresh-deploy / low-holder / proxy patterns | On-call |
| **Lookalike detection** | Symbol/name proximity vs known-asset whitelist + recently-active tokens | On-call |

The intended pattern: agent abstains from the swap on `block`, surfaces a warning on `warn`, proceeds on `allow`.

## Configuration

Set via runtime settings (`runtime.getSetting`) or environment variables:

| Key | Default | Description |
|---|---|---|
| `PALADIN_TRUST_API_BASE` | `https://swap.paladinfi.com` | Base URL of the PaladinFi service. Paid mode requires HTTPS regardless of any override. |
| `PALADIN_TRUST_MODE` | `preview` | `preview` (free; sample fixture) or `paid` (x402-settled). Paid mode also requires constructing the plugin via `createPaladinTrustPlugin({ walletClientAccount })`. |
| `PALADIN_TRUST_DEFAULT_CHAIN_ID` | `8453` | EIP-155 chain id used when not derived from message context. PaladinFi v1 supports Base only (8453); other EVMs return HTTP 400. |
| `PALADIN_TRUST_ALLOW_INSECURE` | (unset) | Set to `1` to allow non-HTTPS `apiBase` for testnet/dev. Has **no effect** on paid mode (paid mode is HTTPS-only). |

## Response shape

```ts
interface TrustCheckResponse {
  address: string;
  chainId: number;
  taker?: string | null;
  request_id: string;
  trust: {
    recommendation: "allow" | "warn" | "block" | "sample-allow" | "sample-warn" | "sample-block";
    factors: Array<{
      source: "ofac" | "goplus" | "etherscan_source" | "anomaly" | "lookalike";
      signal: string;
      details?: string;
      real: boolean; // false on preview, true on paid
    }>;
    risk_score?: number | null;
    risk_score_scale?: string;
    _preview?: boolean;
    _request_id?: string;
    _message?: string;
  };
}
```

## Sample preview response (verified live 2026-05-02)

```bash
curl -sS -X POST https://swap.paladinfi.com/v1/trust-check/preview \
  -H 'content-type: application/json' \
  -d '{"chainId":8453,"address":"0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"}'
```

```json
{
  "address": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  "chainId": 8453,
  "request_id": "499895ca-92f6-4b3d-a146-9f902dc34a45",
  "trust": {
    "recommendation": "sample-allow",
    "factors": [
      { "source": "ofac", "signal": "not_listed", "real": false },
      { "source": "etherscan_source", "signal": "verified", "real": false },
      { "source": "goplus", "signal": "ok", "real": false },
      { "source": "anomaly", "signal": "ok", "real": false }
    ],
    "_preview": true,
    "_message": "Preview response — SAMPLE FIXTURE. POST /v1/trust-check (x402-paid, $0.001/call) for live evaluation."
  }
}
```

## Security & disclosures

- **Non-custodial**: PaladinFi never holds, signs, or moves user funds. Every paid trust-check is settled by the calling wallet's own EIP-3009 signature against the published USDC contract on Base.
- **Pre-sign hard constants**: paid mode signs only against `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` (Base USDC) → `0xeA8C33d018760D034384e92D1B2a7cf0338834b4` (PaladinFi treasury), max $0.01/call, EIP-3009 only. A compromised PaladinFi server cannot redirect a signed authorization to a different recipient/asset/chain. Validation logic is deterministic and auditable: see [`src/x402/validate.ts`](./src/x402/validate.ts).
- **Sample fixture defense**: preview responses are explicitly marked (`_preview: true`, `recommendation: "sample-..."`, every factor `real: false`) so they cannot be screenshot-cropped into a misleading "real" assessment.
- **Coverage caveats**: GoPlus signals are a leading indicator — recently-deployed contracts may not yet be classified. Out-of-scope today: LP-lock status, deployer rug history, pump-dump/wash-trade signals. The [Eliza Discussion](https://github.com/orgs/elizaOS/discussions/7242) is open for prioritization input.
- **Chain coverage**: Base (chainId 8453) only at this time. Other EVMs on roadmap as the underlying feeds expand multi-chain.
- **Library trust**: x402 settlement uses [`@x402/fetch@2.11.0`](https://www.npmjs.com/package/@x402/fetch), Apache-2.0, maintained by the x402 Foundation. Pinned exact; recommend `npm audit signatures` in CI.
- **Eliza alpha drift**: tested against `@elizaos/core@2.0.0-alpha.77`. Newer alphas may shift `composePromptFromState` / `parseKeyValueXml` / `ModelType` semantics; if you hit issues on a different alpha, please file at the issues link below.

## Roadmap

- **v0.2.0**: optional `EVM_PRIVATE_KEY` runtime auto-resolve (matching `@elizaos/plugin-evm`); broader integration tests against the `@elizaos/core` alpha line; toon-format compatibility.
- **v0.3.0**: address-poisoning lookalike action exposed as a separate hook agents can compose into transfer flows (not just swap).
- **v1.0.0**: production stable, multi-chain as PaladinFi backend expands.

## Contributing

Open issues / PRs at https://github.com/paladinfi/eliza-plugin-trust or comment on [Eliza Discussion #7242](https://github.com/orgs/elizaOS/discussions/7242).

## Operator

Operated by **Malcontent Games LLC**, doing business as **PaladinFi**.

- Public API: https://swap.paladinfi.com
- Health: https://swap.paladinfi.com/health
- Terms: https://paladinfi.com/terms/
- Privacy: https://paladinfi.com/privacy/

## License

MIT — see [LICENSE](./LICENSE).
