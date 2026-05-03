/**
 * @paladinfi/eliza-plugin-trust
 *
 * ElizaOS plugin: pre-trade composed risk gate for evm agents.
 *
 * v0.1.0 wires:
 *   - LLM prompt-template extraction (composePromptFromState + useModel + parseKeyValueXml)
 *   - Paid x402 settlement via @x402/fetch@2.11.0 with onBeforePaymentCreation hook
 *   - Factory pattern `createPaladinTrustPlugin({ walletClientAccount })` for paid mode
 *
 * Live PaladinFi service: https://swap.paladinfi.com (Base mainnet, chainId 8453).
 */

import type { Plugin } from "@elizaos/core";
import type { LocalAccount } from "viem/accounts";
import { makeTrustCheckAction, trustCheckAction } from "./actions/trust-check.js";
import { DEFAULT_CONFIG, type PaladinTrustConfig } from "./types.js";

export { trustCheckAction, makeTrustCheckAction } from "./actions/trust-check.js";
export { PaladinTrustClient } from "./client.js";
export { resolveConfig } from "./config.js";
export {
  PALADIN_TREASURY,
  BASE_USDC,
  BASE_NETWORK,
  MAX_TRUST_CHECK_AMOUNT,
  MAX_VALIDITY_SECONDS,
  X402_VERSION,
  USDC_DOMAIN_NAME,
  USDC_DOMAIN_VERSION,
  PALADIN_API_DEFAULT,
} from "./x402/constants.js";
export { validatePaladinContext, type ValidationResult } from "./x402/validate.js";
export { scrubViemError } from "./errors.js";
export type {
  PaladinTrustConfig,
  TrustBlock,
  TrustCheckRequest,
  TrustCheckResponse,
  TrustFactor,
  TrustFactorSource,
  TrustRecommendation,
} from "./types.js";

export interface CreatePaladinTrustPluginOptions {
  /**
   * viem `LocalAccount` (e.g. from `privateKeyToAccount`). Enables paid mode.
   * Must be a LocalAccount — JsonRpcAccount and SmartAccount are NOT supported
   * in v0.1.0 (they lack a local `signTypedData`).
   */
  walletClientAccount?: LocalAccount;
  /**
   * Override base URL. Default: https://swap.paladinfi.com.
   * Non-HTTPS hosts are rejected in paid mode regardless of any env override.
   */
  apiBase?: string;
  /**
   * Default chainId for trust-check requests when not derived from the message.
   * Default: 8453 (Base). PaladinFi v1 supports Base only.
   */
  defaultChainId?: number;
  /**
   * Explicit mode override. If omitted, inferred from walletClientAccount presence
   * (`paid` if provided, else `preview`).
   */
  mode?: "preview" | "paid";
}

/**
 * Constructs a PaladinFi trust-check plugin instance.
 *
 * Paid mode requires a viem `LocalAccount` — pass it via `walletClientAccount`.
 * Preview mode (default export `paladinTrustPlugin`) needs no config.
 *
 * Boot-time validation throws synchronously on:
 *   - Paid mode requested without walletClientAccount
 *   - walletClientAccount lacking signTypedData
 *   - Paid mode + non-HTTPS apiBase
 *
 * @example Preview mode (free)
 * ```ts
 * import { paladinTrustPlugin } from "@paladinfi/eliza-plugin-trust";
 * export const character = { plugins: [paladinTrustPlugin], ... };
 * ```
 *
 * @example Paid mode ($0.001 USDC/call on Base)
 * ```ts
 * import { privateKeyToAccount } from "viem/accounts";
 * import { createPaladinTrustPlugin } from "@paladinfi/eliza-plugin-trust";
 *
 * const account = privateKeyToAccount(process.env.PALADIN_TRUST_KEY as `0x${string}`);
 * export const character = {
 *   plugins: [createPaladinTrustPlugin({ walletClientAccount: account })],
 *   ...
 * };
 * ```
 */
export function createPaladinTrustPlugin(
  opts: CreatePaladinTrustPluginOptions = {},
): Plugin {
  const intendedMode =
    opts.mode ?? (opts.walletClientAccount ? "paid" : "preview");

  if (intendedMode === "paid") {
    if (!opts.walletClientAccount) {
      throw new Error(
        "[paladin-trust] paid mode requires walletClientAccount. " +
          "Construct via privateKeyToAccount(...) from viem/accounts.",
      );
    }
    if (typeof opts.walletClientAccount.signTypedData !== "function") {
      throw new Error(
        "[paladin-trust] walletClientAccount must be a LocalAccount with signTypedData; " +
          "JsonRpcAccount and SmartAccount are not supported in v0.1.0.",
      );
    }
    const apiBaseToCheck = opts.apiBase ?? DEFAULT_CONFIG.apiBase;
    if (!apiBaseToCheck.startsWith("https://")) {
      throw new Error(
        `[paladin-trust] paid mode requires https:// apiBase (got "${apiBaseToCheck.slice(0, 80)}"). ` +
          "PALADIN_TRUST_ALLOW_INSECURE has no effect on paid mode.",
      );
    }
  }

  // Action carries factoryDefaults via closure (no runtime mutation).
  // Each plugin instance has its own action with its own bound config.
  const factoryDefaults: Partial<PaladinTrustConfig> = {};
  if (opts.apiBase !== undefined) factoryDefaults.apiBase = opts.apiBase;
  if (opts.defaultChainId !== undefined)
    factoryDefaults.defaultChainId = opts.defaultChainId;
  factoryDefaults.mode = intendedMode;
  if (opts.walletClientAccount) {
    factoryDefaults.walletClientAccount = opts.walletClientAccount;
  }

  const action = makeTrustCheckAction(factoryDefaults);

  return {
    name: "paladin-trust",
    description:
      "Pre-trade composed risk gate (OFAC SDN + GoPlus + Etherscan + lookalike) for ElizaOS evm agents. " +
      "Single x402-paid call against PaladinFi on Base. Preview mode free; paid mode $0.001 USDC/call.",
    actions: [action],
    evaluators: [],
    providers: [],
  };
}

/**
 * Default plugin export — preview mode, no wallet required.
 * Equivalent to `createPaladinTrustPlugin({})`. Uses the env-only `trustCheckAction`
 * (no factoryDefaults closure) so multiple plugin instances on one runtime stay
 * independent.
 */
export const paladinTrustPlugin: Plugin = {
  name: "paladin-trust",
  description:
    "Pre-trade composed risk gate (OFAC SDN + GoPlus + Etherscan + lookalike) for ElizaOS evm agents. " +
    "Preview mode (free; sample fixtures). For paid mode, use createPaladinTrustPlugin({ walletClientAccount }).",
  actions: [trustCheckAction],
  evaluators: [],
  providers: [],
};

export default paladinTrustPlugin;
