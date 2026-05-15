/**
 * @paladinfi/eliza-plugin-trust
 *
 * ElizaOS plugin: pre-trade composed risk gate + (v0.2.0) paladin_swap action.
 *
 * v0.1.0 (UNCHANGED):
 *   - paladin_trust_check Action (LLM extraction → x402-paid trust check)
 *   - createPaladinTrustPlugin({ walletClientAccount }) factory
 *
 * v0.2.0 (NEW, opt-in via paladinSwapEnabled):
 *   - paladin_swap Action (combined: trust + simulation + cryptographic verification)
 *   - 5-layer defense: server-side allowlist + client-side allowlist + Layer 3
 *     2-of-2 KMS-signed /v1/simulate response + Layer 4 server-side Anvil sim +
 *     spending discipline (per-token cap + rate limit + $5/day default)
 *   - Mandatory acknowledgeRisks=true gate + clockOverride production guardrail
 *   - .catch()-wrapped pre-warm of trust-state cache (no boot crash on RPC down)
 *
 * Live PaladinFi service: https://swap.paladinfi.com (Base mainnet, chainId 8453).
 */

import type { Action, Plugin } from "@elizaos/core";
import type { LocalAccount } from "viem/accounts";
import type { Address, Hex } from "viem";

import { makeTrustCheckAction, trustCheckAction } from "./actions/trust-check.js";
import { makePaladinSwapAction, type OnTrustBlock } from "./actions/paladin-swap.js";
import { PaladinTrustClient } from "./client.js";
import { DEFAULT_CONFIG, type PaladinTrustConfig } from "./types.js";

import { realClock, type Clock } from "./utils/clock.js";
import { RateLimiter } from "./utils/rate-limiter.js";
import { SpendingTracker } from "./utils/spending-tracker.js";
import {
  SPENDING_PROFILES,
  getProfile,
  type ProfileName,
  type KeyTrustMode,
} from "./utils/profiles.js";
import { DEFAULT_BASE_RPC_POOL, getTrustState } from "./utils/paladin-keys.js";
import {
  DEFAULT_FRESHNESS_WINDOW_SEC,
  DEFAULT_ACCEPT_VERSIONS,
} from "./utils/paladin-verify.js";
import { verifyAccountChecksum, type TenderlyConfig } from "./utils/tenderly-simulate.js";
import { defaultDebugBundleSinkPath } from "./utils/debug-bundle.js";

import * as path from "node:path";
import * as os from "node:os";

// =============================================================================
// Re-exports (v0.1.0 UNCHANGED + v0.2.0 additions)
// =============================================================================

export { trustCheckAction, makeTrustCheckAction } from "./actions/trust-check.js";
export { PaladinTrustClient, TrustCheckPaidError } from "./client.js";
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
export { scrubViemError, ErrorCode, PaladinTrustError, isPaladinTrustError } from "./errors.js";
export type {
  PaladinTrustConfig,
  TrustBlock,
  TrustCheckRequest,
  TrustCheckResponse,
  TrustFactor,
  TrustFactorSource,
  TrustRecommendation,
  SettlementState,
  PaidExResult,
} from "./types.js";

// v0.2.0 paladin_swap exports
export { makePaladinSwapAction, type PaladinSwapActionData } from "./actions/paladin-swap.js";
export { TOKEN_REGISTRY, TOKEN_REGISTRY_HASH } from "./utils/sell-caps.js";
export { DEFAULT_BASE_RPC_POOL } from "./utils/paladin-keys.js";
export type { Clock } from "./utils/clock.js";
export type { ProfileName, KeyTrustMode } from "./utils/profiles.js";
export type { TenderlyConfig } from "./utils/tenderly-simulate.js";

// =============================================================================
// Factory options
// =============================================================================

export interface CreatePaladinTrustPluginOptions {
  // -- v0.1.0 (unchanged) ---------------------------------------------------
  walletClientAccount?: LocalAccount;
  apiBase?: string;
  defaultChainId?: number;
  mode?: "preview" | "paid";

  // -- v0.2.0: paladin_swap action opt-in -----------------------------------
  /**
   * Enable the v0.2.0 paladin_swap action. Default false.
   *
   * Hard requirements when true:
   *   - walletClientAccount (else WALLET_MISSING)
   *   - acknowledgeRisks: true (else RESIDUAL_NOT_ACKNOWLEDGED)
   *
   * Opting in unlocks combined trust-check + swap-quote + simulation +
   * cryptographic verification with $0.002 USDC/call (trust + simulate).
   */
  paladinSwapEnabled?: boolean;

  /**
   * Required when paladinSwapEnabled=true. Customer's explicit ack of
   * documented residual: block-divergence between simulate-time and
   * execute-time. minBuyAmount + on-chain slippage protection enforces
   * the floor. See README §"Documented residual".
   */
  acknowledgeRisks?: boolean;

  /** Per-call mode for handler step 10. Tightening-only. Default 'block'. */
  onTrustBlock?: OnTrustBlock;

  /** Spending profile. Default 'default' (~$5/day cap). */
  paladinSwapProfile?: ProfileName;

  // -- Per-knob overrides (override profile defaults) -----------------------
  maxSellAmountByTokenAddress?: Record<string, string>;
  paladinSwapRateLimit?: { maxCalls: number; windowMs: number };
  maxHourlyUsdc?: number;
  maxDailyUsdc?: number;
  spendingCounterPath?: string;
  warnLogPath?: string;

  /** Default: https://swap.paladinfi.com/v1/simulate */
  simulationServerUrl?: string;
  /** Default: https://swap.paladinfi.com/v1/quote */
  quoteServerUrl?: string;

  // -- Verification controls ------------------------------------------------
  simulationVerifier?: "paladin-multikey" | "tenderly" | "both";
  tenderlyConfig?: TenderlyConfig;
  keyTrustMode?: KeyTrustMode;
  pinnedPair?: { aws: Address; gcp: Address };
  pinnedEpoch?: number;
  freshnessWindowSec?: number;
  registryStaleGraceSec?: number;
  tenderlySpkiAdvisoryPath?: string;

  // -- Diagnostics ----------------------------------------------------------
  paladinSwapDebug?: boolean;
  debugBundleSinkPath?: string;
  debugRedactWalletAddress?: boolean;
  acceptVersions?: string[];

  // -- RPC pool for on-chain reads ------------------------------------------
  baseRpcUrls?: readonly string[];
  paladinKeyRegistryAddress?: Hex;

  /**
   * Test-only clock injection. THROWS at factory construction if set when
   * NODE_ENV=production (R11 Sec MED-1 supply-chain replay defense).
   *
   * If a malicious dependency injects a frozen clock, freshness checks +
   * rate limiting + spending caps + retryToken expiry all break. Production
   * MUST use the system clock.
   */
  clockOverride?: Clock;
}

// =============================================================================
// Public factory
// =============================================================================

/**
 * Construct a PaladinFi trust-check plugin instance.
 *
 * v0.1.0 (default): just paladin_trust_check action + preview/paid HTTP client.
 * v0.2.0 (paladinSwapEnabled=true): adds paladin_swap action with combined
 * trust + swap-quote + simulation + cryptographic-verification orchestration.
 *
 * Boot-time validation throws synchronously on:
 *   - Paid mode requested without walletClientAccount
 *   - walletClientAccount lacking signTypedData
 *   - Paid mode + non-HTTPS apiBase
 *   - paladinSwapEnabled=true without walletClientAccount → WALLET_MISSING
 *   - paladinSwapEnabled=true without acknowledgeRisks=true → RESIDUAL_NOT_ACKNOWLEDGED
 *   - simulationVerifier='tenderly'|'both' without tenderlyConfig
 *   - tenderlyConfig.accountChecksum mismatch (typosquatting defense)
 *   - keyTrustMode='pinned' without pinnedPair
 *   - clockOverride set when NODE_ENV=production (supply-chain defense)
 *
 * Pre-warm: when paladinSwapEnabled=true, factory kicks off a non-blocking
 * `getTrustState()` so the first paladin_swap call doesn't pay cold-start
 * latency. Wrapped in `.catch()` — agent does NOT crash on boot if Base RPC
 * is unreachable; the first paladin_swap call refetches lazily.
 */
export function createPaladinTrustPlugin(
  opts: CreatePaladinTrustPluginOptions = {},
): Plugin {
  // -------------------------------------------------------------------------
  // R11 Sec MED-1: clockOverride production guardrail
  // -------------------------------------------------------------------------
  if (opts.clockOverride && process.env.NODE_ENV === "production") {
    throw new Error(
      "[paladin-trust] clockOverride is TEST-ONLY; production refuses to start with clockOverride set. " +
        "If you see this error in production, a malicious dependency may be injecting a frozen clock to bypass " +
        "freshness/rate-limit/spending-cap/retryToken checks. Investigate the supply chain.",
    );
  }

  // -------------------------------------------------------------------------
  // v0.1.0 paid-mode validation (unchanged)
  // -------------------------------------------------------------------------
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
          "JsonRpcAccount and SmartAccount are not supported.",
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

  // -------------------------------------------------------------------------
  // v0.2.0 paladin_swap construction-time gates
  // -------------------------------------------------------------------------
  if (opts.paladinSwapEnabled) {
    if (!opts.walletClientAccount) {
      throw new Error(
        "[paladin-trust] paladinSwapEnabled=true requires walletClientAccount.",
      );
    }
    if (opts.acknowledgeRisks !== true) {
      throw new Error(
        "[paladin-trust] paladinSwapEnabled=true requires acknowledgeRisks=true. " +
          "paladin_swap returns swap calldata after a 5-layer defense pipeline. The remaining narrow " +
          "residual is block-divergence: simulation runs against state up to ~1 hour old; the actual swap " +
          "executes minutes later, so pool prices may have moved. minBuyAmount + on-chain slippage " +
          "protection enforces the floor. See README §'Documented residual'.",
      );
    }
    if (
      (opts.simulationVerifier === "tenderly" || opts.simulationVerifier === "both") &&
      !opts.tenderlyConfig
    ) {
      throw new Error(
        "[paladin-trust] simulationVerifier='tenderly'|'both' requires tenderlyConfig.",
      );
    }
    if (opts.tenderlyConfig) {
      // Throws on accountChecksum mismatch (typosquatting defense).
      verifyAccountChecksum(opts.tenderlyConfig);
    }
    if (opts.keyTrustMode === "pinned" && !opts.pinnedPair) {
      throw new Error(
        "[paladin-trust] keyTrustMode='pinned' requires pinnedPair.",
      );
    }
  }

  // -------------------------------------------------------------------------
  // v0.1.0 client + trust-check action (unchanged)
  // -------------------------------------------------------------------------
  const factoryDefaults: Partial<PaladinTrustConfig> = {};
  if (opts.apiBase !== undefined) factoryDefaults.apiBase = opts.apiBase;
  if (opts.defaultChainId !== undefined) factoryDefaults.defaultChainId = opts.defaultChainId;
  factoryDefaults.mode = intendedMode;
  if (opts.walletClientAccount) {
    factoryDefaults.walletClientAccount = opts.walletClientAccount;
  }

  const trustCheckActionInstance = makeTrustCheckAction(factoryDefaults);
  const actions: Action[] = [trustCheckActionInstance];

  // -------------------------------------------------------------------------
  // v0.2.0 paladin_swap action wiring (only if enabled)
  // -------------------------------------------------------------------------
  if (opts.paladinSwapEnabled && opts.walletClientAccount) {
    const profileName: ProfileName = opts.paladinSwapProfile ?? "default";
    const profile = getProfile(profileName);
    const clock = opts.clockOverride ?? realClock;

    // Construct the v0.2.0 client (uses the same PaladinTrustClient as v0.1.0
    // but configured for paid mode; paidEx() exposes settlement-state).
    const swapClient = new PaladinTrustClient({
      apiBase: opts.apiBase ?? DEFAULT_CONFIG.apiBase,
      mode: "paid",
      defaultChainId: opts.defaultChainId ?? DEFAULT_CONFIG.defaultChainId,
      walletClientAccount: opts.walletClientAccount,
    });

    const rateLimiter = new RateLimiter(
      opts.paladinSwapRateLimit ?? profile.rateLimit,
      clock,
    );
    const spendingCounterPath =
      opts.spendingCounterPath ??
      path.join(os.homedir(), ".paladin-trust", "spending-counter.json");
    const spendingTracker = new SpendingTracker({
      filePath: spendingCounterPath,
      maxHourlyUsdc: opts.maxHourlyUsdc ?? profile.maxHourlyUsdc,
      maxDailyUsdc: opts.maxDailyUsdc ?? profile.maxDailyUsdc,
      warnLogPath: opts.warnLogPath,
      clock,
    });

    const apiBase = opts.apiBase ?? DEFAULT_CONFIG.apiBase;
    const simulationServerUrl =
      opts.simulationServerUrl ?? `${apiBase.replace(/\/$/, "")}/v1/simulate`;
    const quoteServerUrl =
      opts.quoteServerUrl ?? `${apiBase.replace(/\/$/, "")}/v1/quote`;

    const swapAction = makePaladinSwapAction({
      client: swapClient,
      apiBase,
      onTrustBlock: opts.onTrustBlock ?? "block",
      sellAmountCaps: opts.maxSellAmountByTokenAddress ?? profile.sellAmountCaps,
      rateLimiter,
      spendingTracker,
      simulationServerUrl,
      quoteServerUrl,
      freshnessWindowSec: opts.freshnessWindowSec ?? DEFAULT_FRESHNESS_WINDOW_SEC,
      acceptVersions: opts.acceptVersions ?? DEFAULT_ACCEPT_VERSIONS,
      baseRpcUrls: opts.baseRpcUrls ?? DEFAULT_BASE_RPC_POOL,
      paladinKeyRegistryAddress: opts.paladinKeyRegistryAddress as Address | undefined,
      debugEnabled: opts.paladinSwapDebug ?? false,
      debugSinkPath: opts.debugBundleSinkPath ?? defaultDebugBundleSinkPath(),
      redactWalletAddress: opts.debugRedactWalletAddress ?? true,
      warnLogPath: opts.warnLogPath,
      clock,
    });

    actions.push(swapAction);

    // -----------------------------------------------------------------------
    // R9 Eng HIGH-3: pre-warm wrapped in .catch() — never crashes the agent
    // -----------------------------------------------------------------------
    void getTrustState({
      baseRpcUrls: opts.baseRpcUrls ?? DEFAULT_BASE_RPC_POOL,
      paladinKeyRegistryAddress: opts.paladinKeyRegistryAddress as Address | undefined,
      clock,
      warnLogPath: opts.warnLogPath,
    }).catch((err: unknown) => {
      const msg = (err as Error)?.message ?? "unknown";
      // eslint-disable-next-line no-console
      console.warn(
        `[paladin-trust] trust-state pre-warm failed: ${msg}; first paladin_swap call will refetch lazily`,
      );
    });
  }

  return {
    name: "paladin-trust",
    description: opts.paladinSwapEnabled
      ? "Pre-trade composed risk gate + paladin_swap (combined trust-check + swap-quote + cryptographically-verified " +
        "Anvil simulation). 2-of-2 KMS-signed responses with on-chain trust anchor + 7-day rotation timelock. $0.002 USDC/call."
      : "Pre-trade composed risk gate (OFAC SDN + GoPlus + Etherscan + lookalike) for ElizaOS evm agents. " +
        "Single x402-paid call against PaladinFi on Base. Preview mode free; paid mode $0.001 USDC/call.",
    actions,
    evaluators: [],
    providers: [],
  };
}

/**
 * Default plugin export — preview mode, no wallet required, no paladin_swap.
 * Equivalent to `createPaladinTrustPlugin({})`. Uses the env-only
 * `trustCheckAction` (no factoryDefaults closure).
 */
export const paladinTrustPlugin: Plugin = {
  name: "paladin-trust",
  description:
    "Pre-trade composed risk gate (OFAC SDN + GoPlus + Etherscan + lookalike) for ElizaOS evm agents. " +
    "Preview mode (free; sample fixtures). For paid mode, use createPaladinTrustPlugin({ walletClientAccount }). " +
    "For paladin_swap (combined trust + simulation), additionally pass paladinSwapEnabled: true + acknowledgeRisks: true.",
  actions: [trustCheckAction],
  evaluators: [],
  providers: [],
};

export default paladinTrustPlugin;

// =============================================================================
// Re-export profile constants (so customers can introspect defaults without importing utils/)
// =============================================================================

export { SPENDING_PROFILES };
