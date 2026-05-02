# @paladinfi/eliza-plugin-trust

**Pre-trade composed risk gate for ElizaOS evm agents** — OFAC SDN + GoPlus token security + Etherscan source verification + anomaly heuristics + lookalike detection. Single x402-paid call against [PaladinFi](https://swap.paladinfi.com) on Base.

> **v0.0.1 is a skeleton release.** Full functionality (LLM-prompt parameter extraction + paid x402 settlement) lands in **v0.1.0** within ~2 weeks of the public [Eliza Discussion](https://github.com/orgs/elizaOS/discussions/7242) (posted 2026-05-02). The skeleton is published to anchor that public commitment with real, public, MIT-licensed code rather than a design doc.

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Chain](https://img.shields.io/badge/chain-Base%208453-2563eb)](https://basescan.org/)
[![Status](https://img.shields.io/badge/status-skeleton%20v0.0.1-orange)](https://github.com/paladinfi/eliza-plugin-trust)

---

## What it does

When wired into an ElizaOS character's action graph, this plugin gives the agent a single tool call to run a composed risk check on a token contract before swapping into it. The check covers:

| Factor | Source | Cadence |
|---|---|---|
| **OFAC SDN screening** | U.S. Treasury SDN XML feed (cryptocurrency-tagged entries via Feature 345 / Detail 1432) | PaladinFi service refreshes from Treasury every 24 hours |
| **GoPlus token security** | GoPlus trust-list + token-security API (where surfaced) | On-call; recently-deployed contracts may not yet be classified |
| **Etherscan source verification** | Etherscan `getSourceCode` | Cached per `(address, chainId)` |
| **Anomaly heuristics** | Fresh-deploy / low-holder / proxy patterns | On-call |
| **Lookalike detection** | Symbol/name proximity vs known-asset whitelist + recently-active tokens | On-call |

Returns `recommendation: allow | warn | block` plus per-factor breakdown. The intended pattern: the agent abstains from the swap on `block`, surfaces a warning on `warn`, proceeds on `allow`.

## Modes

| Mode | Endpoint | Cost | Returns | v0.0.1 status |
|---|---|---|---|---|
| `preview` (default) | `POST /v1/trust-check/preview` | Free, no API key, no payment | Sample fixture (every factor `real: false`, `recommendation` is `sample-` prefixed) | ✅ Implemented |
| `paid` | `POST /v1/trust-check` | $0.001 USDC/call settled via x402 on Base | Live evaluation (every factor `real: true`, `recommendation` ∈ {allow, warn, block}) | ⏳ v0.1.0 (requires wallet runtime + EIP-3009 signing) |

## Install

```bash
npm install @paladinfi/eliza-plugin-trust
# or
pnpm add @paladinfi/eliza-plugin-trust
# or
bun add @paladinfi/eliza-plugin-trust
```

Peer dependency: `@elizaos/core@^2.0.0-alpha.77`. Tested against the alpha release line; feedback welcome on the [Eliza Discussion](https://github.com/orgs/elizaOS/discussions/7242) if you encounter compatibility issues with newer alphas.

## Use in a character

```ts
import { paladinTrustPlugin } from "@paladinfi/eliza-plugin-trust";

// In your character config / runtime setup:
const runtime = new AgentRuntime({
  // ...
  plugins: [
    paladinTrustPlugin,
    // ...your other plugins
  ],
});
```

## Configuration

Set via runtime settings (`runtime.getSetting`) or environment variables:

| Key | Default | Description |
|---|---|---|
| `PALADIN_TRUST_API_BASE` | `https://swap.paladinfi.com` | Base URL of the PaladinFi service. |
| `PALADIN_TRUST_MODE` | `preview` | `preview` (free; sample fixture) or `paid` (x402-settled, v0.1.0+). |
| `PALADIN_TRUST_DEFAULT_CHAIN_ID` | `8453` | EIP-155 chain id used when not derived from message context. PaladinFi v1 supports Base only (8453); other EVMs return HTTP 400. |

## Calling the action

The action is registered as `PALADIN_TRUST_CHECK` (similes: `CHECK_TOKEN_SAFETY`, `PRE_TRADE_TRUST_CHECK`, `PALADIN_TRUST`, `VERIFY_TOKEN`).

**v0.0.1 calling convention**: pass the buy-token address explicitly via `options.address`:

```ts
import type { Memory } from "@elizaos/core";

const result = await runtime.executeAction(
  "PALADIN_TRUST_CHECK",
  message,
  state,
  {
    address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", // USDC on Base
    chainId: 8453,
  }
);

// result.values.paladinTrustRecommendation: "sample-allow" | "sample-warn" | "sample-block" (preview)
// result.data.response: full TrustCheckResponse
```

In **v0.1.0**, the action will extract `address`, `chainId`, and `taker` from the user's natural-language message via the standard ElizaOS prompt-template flow (see `plugin-evm/transfer.ts` for the canonical pattern). For now, parameter passing is explicit.

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

- **Non-custodial**: PaladinFi never holds, signs, or moves user funds. Every transaction is signed by the calling wallet.
- **Sample fixture defense**: preview responses are explicitly marked (`_preview: true`, `recommendation: "sample-..."`, every factor `real: false`) so they cannot be screenshot-cropped into a misleading "real" assessment.
- **Coverage caveats** (carried into v0.0.1): GoPlus signals are a leading indicator — recently-deployed contracts may not yet be classified. Out-of-scope today: LP-lock status, deployer rug history, pump-dump/wash-trade signals. These are roadmap items; the [Eliza Discussion](https://github.com/orgs/elizaOS/discussions/7242) is open for prioritization input.
- **Chain coverage**: Base (chainId 8453) only at this time. Other EVMs on roadmap as the underlying feeds expand multi-chain.

## Roadmap

- **v0.1.0** (~2 weeks from 2026-05-02 / before 2026-05-16): full LLM-prompt extraction (matches `plugin-evm/transfer.ts` v2-alpha pattern); paid x402 settlement via wallet runtime; `paladin_trust_check` becomes invokable via natural language alongside the explicit-parameter path.
- **v0.2.0**: integration tests against `@elizaos/core` alpha line; CI; toon-format compatibility.
- **v0.3.0**: address-poisoning lookalike action exposed as a separate hook agents can compose into transfer flows (not just swap).
- **v1.0.0**: production stable, multi-chain (as PaladinFi backend expands), v2-alpha conformance complete.

## Contributing

This is a community-feedback skeleton. Open issues / PRs at https://github.com/paladinfi/eliza-plugin-trust or comment on [Eliza Discussion #7242](https://github.com/orgs/elizaOS/discussions/7242).

## Operator

Operated by **Malcontent Games LLC**, doing business as **PaladinFi**.

- Public API: https://swap.paladinfi.com
- Health: https://swap.paladinfi.com/health
- Docs: https://swap.paladinfi.com (REST + MCP)
- MCP Registry: `io.github.paladinfi/paladin-swap`
- Smithery: https://smithery.ai/servers/paladinfi/paladin-swap
- Terms: https://paladinfi.com/terms/
- Privacy: https://paladinfi.com/privacy/

## License

MIT — see [LICENSE](./LICENSE).
