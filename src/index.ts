/**
 * @paladinfi/eliza-plugin-trust
 *
 * ElizaOS plugin: pre-trade composed risk gate for evm agents.
 *
 * v0.0.1 is a SKELETON release. See src/actions/trust-check.ts for scoped
 * limitations vs the full v2-alpha pattern. Functional (LLM-prompt extraction
 * + paid x402 settlement) lands in v0.1.0 within ~2 weeks of the public
 * Eliza Discussion #7242 (2026-05-02).
 *
 * Live PaladinFi service: https://swap.paladinfi.com (Base mainnet, chainId 8453).
 * Free preview endpoint at POST /v1/trust-check/preview returns sample-fixture
 * trust block for request-shape validation without payment or API key.
 */

import type { Plugin } from "@elizaos/core";
import { trustCheckAction } from "./actions/trust-check.js";

export { trustCheckAction } from "./actions/trust-check.js";
export { PaladinTrustClient } from "./client.js";
export { resolveConfig } from "./config.js";
export type {
  PaladinTrustConfig,
  TrustBlock,
  TrustCheckRequest,
  TrustCheckResponse,
  TrustFactor,
  TrustFactorSource,
  TrustRecommendation,
} from "./types.js";

export const paladinTrustPlugin: Plugin = {
  name: "paladin-trust",
  description:
    "Pre-trade composed risk gate (OFAC SDN + GoPlus + Etherscan + lookalike) for ElizaOS evm agents. " +
    "Single x402-paid call against PaladinFi on Base. v0.0.1 skeleton — see GitHub for scope.",
  actions: [trustCheckAction],
  evaluators: [],
  providers: [],
};

export default paladinTrustPlugin;
