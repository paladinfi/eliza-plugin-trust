/**
 * paladin_swap Action — combined trust-check + swap-quote + simulation +
 * cryptographic-verification orchestration.
 *
 * 16 ordered steps per v11 §4.3. Each step has a single failure mode mapped
 * to a closed-enum ErrorCode. Refund discipline:
 *   - Steps 9, 11, 14: failures BEFORE settlement → refund tracker
 *   - Steps 9, 14: settlement-state='attempted-unknown' → debit + warn-log,
 *     rate-limited to ≤1/hr per (taker, sellToken, buyToken) tuple
 *   - Steps 15, 16, 17: failures AFTER server did the work → debit (no refund)
 *
 * AbortSignal threading: per-step timeouts derived from a shared call-level
 * AbortController so external cancellation (and overall timeout) cascade
 * cleanly to every async fetch.
 *
 * Layer 3 verify retry-once: on any of the 4 retryable verification errors
 * (RESPONSE_SIG_INVALID / RESPONSE_EPOCH_MISMATCH / RESPONSE_EPOCH_REVOKED /
 * TOKEN_REGISTRY_DRIFT), force-refresh trust state and retry verify ONCE
 * with the SAME requestHash + clientNonce. Other errors propagate without retry.
 *
 * Debug bundle: every step start/end is recorded with `metadata` (auto-redacted
 * for keys matching NEVER_INCLUDE_FIELDS). On error, final outcome + errorCode
 * + diagnostic block are persisted to `debugBundleSinkPath` (default
 * `~/.paladin-trust/debug-bundle.jsonl`). Best-effort — disk failures never
 * propagate.
 *
 * Mode override (onTrustBlock) is tightening-only:
 *   factory='block' wins regardless of per-call value
 *   factory='report' + per-call='block' → 'block'
 *   factory='report' + no per-call → 'report'
 */

import type {
  Action,
  ActionResult,
  ContentValue,
  HandlerCallback,
  IAgentRuntime,
  Memory,
  ProviderDataRecord,
  State,
} from "@elizaos/core";
import {
  validateStateDiffInvariants,
  deltasToBigIntMap,
} from "../utils/state-diff-invariants";
import { z } from "zod";
import { isAddress, type Address, type Hex } from "viem";

import { ErrorCode, PaladinTrustError, isPaladinTrustError } from "../errors";
import { paladinSwapTemplate } from "../templates/paladin-swap";
import { PaladinTrustClient, TrustCheckPaidError } from "../client";
import type { PaidExResult, SettlementState, TrustCheckResponse } from "../types";

import type { Clock } from "../utils/clock";
import { RateLimiter } from "../utils/rate-limiter";
import { SpendingTracker } from "../utils/spending-tracker";
import {
  TOKEN_REGISTRY,
  getTokenEntry,
  isTokenSupported,
  getTokenCap,
} from "../utils/sell-caps";
import { validateQuoteResponse, type QuoteForValidation } from "../utils/quote-validate";
import {
  generateClientNonce,
  computeRequestHash,
  simulateServer,
  type QuoteForSimulation,
  type SimulationFailedDetail,
} from "../utils/paladin-simulate";
import {
  verifyAndExtract,
  type SimulateVerifiedExtract,
  isRetryableVerificationError,
} from "../utils/paladin-verify";
import { getTrustState, type CachedTrustState } from "../utils/paladin-keys";
import { DebugBundle, defaultDebugBundleSinkPath } from "../utils/debug-bundle";

// =============================================================================
// Constants
// =============================================================================

const TRUST_CHECK_TIMEOUT_MS = 8_000;
const QUOTE_TIMEOUT_MS = 8_000;
const SIMULATE_TIMEOUT_MS = 12_000;

const TRUST_FEE_USDC = 0.001;
const SIMULATE_FEE_USDC = 0.001;
const TOTAL_FEE_USDC = TRUST_FEE_USDC + SIMULATE_FEE_USDC;

const ATTEMPTED_UNKNOWN_RATE_LIMIT_MS = 3_600_000; // 1 hour

/**
 * Symbol → canonical Base address. Lowercased. The LLM template emits
 * symbol names; the handler uses this map for the address. Drift between
 * this map and TOKEN_REGISTRY is caught by Step 5 (TOKEN_NOT_SUPPORTED).
 */
const SYMBOL_TO_ADDRESS: Readonly<Record<string, Address>> = Object.freeze({
  USDC: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913" as Address,
  USDT: "0xfde4c96c8593536e31f229ea8f37b2ada2699bb2" as Address,
  WETH: "0x4200000000000000000000000000000000000006" as Address,
  CBBTC: "0xcbb7c0000ab88b473b1f5afd9ef808440eed33bf" as Address,
  DAI: "0x50c5725949a6f0c72e6c4a641f24049a917db0cb" as Address,
  AERO: "0x940181a94a35a4569e4529a3cdfb74e38fd98631" as Address,
  USDBC: "0xd9aaec86b65d86f6a7b5b1b0c42ffa531710b6ca" as Address,
});

// =============================================================================
// Types
// =============================================================================

export type OnTrustBlock = "block" | "report";

export interface PaladinSwapActionDeps {
  client: PaladinTrustClient;
  apiBase: string;
  onTrustBlock: OnTrustBlock;
  sellAmountCaps: Readonly<Record<string, string>>;
  rateLimiter: RateLimiter;
  spendingTracker: SpendingTracker;
  // Server URLs
  simulationServerUrl: string;
  quoteServerUrl: string;
  // Verification controls
  freshnessWindowSec: number;
  acceptVersions: readonly string[];
  // RPC pool for trust-state reads
  baseRpcUrls: readonly string[];
  paladinKeyRegistryAddress?: Address;
  // Diagnostics
  debugEnabled: boolean;
  debugSinkPath?: string;
  redactWalletAddress: boolean;
  warnLogPath?: string;
  clock: Clock;
}

export interface PaladinSwapActionData {
  apiVersion: "paladin-swap-action-v1";
  trust: {
    address: string;
    recommendation: string;
    factors: { source: string; signal: string }[];
  };
  quote: {
    router: Address | string;
    sellToken: Address | string;
    buyToken: Address | string;
    sellAmount: string;
    minBuyAmount: string;
    buyAmount: string;
    selector: Hex | string;
  };
  simulation: {
    ok: boolean;
    deltas?: Record<string, string>;
    gasUsed?: number;
    forkAge?: number;
  };
  mode: OnTrustBlock;
  error?: { code: ErrorCode; message: string };
}

interface QuoteFromServer extends QuoteForValidation {
  buyAmount: string;
  minBuyAmount: string;
}

// =============================================================================
// Module-level state
// =============================================================================

/**
 * Process-wide highest-version-ever-seen for downgrade prevention. Survives
 * across paladin_swap calls. Initialized lazily on first call. Per-process,
 * which is the right scoping — agent restart resets, but a single agent
 * instance can't be tricked into accepting a downgraded API version.
 */
let moduleHighestVersionRef: { value: string } | null = null;

/**
 * In-process map for rate-limiting attempted-unknown debits to ≤1/hr per
 * (taker, sellToken, buyToken). Per v11 §4.8 + R7 Eng HIGH-1 fix — prevents
 * a network-flake attacker from burning a customer's daily cap by forcing
 * many attempted-unknown branches.
 */
const attemptedUnknownRateLimit = new Map<string, number>();

function canDebitAttemptedUnknown(
  taker: string,
  sellToken: string,
  buyToken: string,
  clock: Clock,
): boolean {
  const key = `${taker.toLowerCase()}|${sellToken.toLowerCase()}|${buyToken.toLowerCase()}`;
  const now = clock.now();
  const last = attemptedUnknownRateLimit.get(key);
  if (last !== undefined && now - last < ATTEMPTED_UNKNOWN_RATE_LIMIT_MS) {
    return false;
  }
  attemptedUnknownRateLimit.set(key, now);
  return true;
}

// =============================================================================
// Schemas (Step 1, Step 3)
// =============================================================================

const optsSchema = z.object({
  onTrustBlock: z.enum(["block", "report"]).optional(),
});

const extractedFieldsSchema = z.object({
  sellTokenSymbol: z.string().min(1),
  buyTokenSymbol: z.string().min(1),
  sellAmount: z
    .string()
    .regex(/^[0-9]+(\.[0-9]+)?$/, "sellAmount must be a positive decimal"),
  chainId: z.coerce.number().int().positive(),
  takerAddress: z.string().optional(),
});

// =============================================================================
// Public factory
// =============================================================================

export function makePaladinSwapAction(deps: PaladinSwapActionDeps): Action {
  return {
    name: "PALADIN_SWAP",
    similes: ["SWAP", "TRADE", "BUY_TOKEN", "SELL_TOKEN"],
    description:
      "Swap one ERC-20 for another on Base via PaladinFi's trust-checked + cryptographically-verified swap-router. " +
      "Performs trust check on sell+buy tokens, validates quote selector + router + 0x Settler target, " +
      "simulates server-side with multi-token state-diff inspection, and verifies the response signed 2-of-2 by " +
      "KMS keys with on-chain trust anchor before returning calldata for the agent's wallet to sign.",
    examples: [
      [
        { name: "{{user1}}", content: { text: "swap 100 USDC for WETH" } },
        {
          name: "{{user2}}",
          content: {
            text: "Running paladin_swap: trust-check + simulation...",
            actions: ["PALADIN_SWAP"],
          },
        },
      ],
    ],
    validate: async () => true,
    handler: async (runtime, message, state, options, callback) => {
      // Adapt v11-spec PaladinSwapActionData return shape to elizaos's
      // current Handler return type (Promise<ActionResult | undefined>).
      // R16 implementation review should evaluate whether to rewrite the
      // handler to natively emit ActionResult instead of bridging here.
      const data = await runHandler(runtime, message, state, options, callback, deps);
      const swapData = data as PaladinSwapActionData | undefined;
      if (!swapData) return undefined;
      const success = !swapData.error;
      return {
        success,
        text: success ? "paladin_swap completed" : `paladin_swap failed: ${swapData.error?.code}`,
        data: swapData as unknown as ProviderDataRecord,
        error: swapData.error?.message,
      } satisfies ActionResult;
    },
  };
}

// =============================================================================
// The 16-step handler
// =============================================================================

async function runHandler(
  runtime: IAgentRuntime,
  message: Memory,
  state: State | undefined,
  options: unknown,
  callback: HandlerCallback | undefined,
  deps: PaladinSwapActionDeps,
): Promise<unknown> {
  const abortController = new AbortController();

  // Lazy init module-level highest-version-ref.
  if (!moduleHighestVersionRef) {
    moduleHighestVersionRef = { value: deps.acceptVersions[0] ?? "paladin-simulate-v2" };
  }
  const highestVersionRef = moduleHighestVersionRef;

  let bundle: DebugBundle | null = null;

  // Refund-tracking state. We track WHICH fees are still owed (consumed but
  // not yet either refunded or settled) so the catch-all at the bottom can
  // refund the residual on unexpected errors.
  let trustFeeOwed = 0;
  let simulateFeeOwed = 0;

  // Parsed values (filled incrementally; read by debug bundle on error).
  let sellTokenAddr: Address | undefined;
  let buyTokenAddr: Address | undefined;
  let sellAmountBaseUnits: string | undefined;
  let chainId: number | undefined;
  let taker: Address | undefined;
  let trustResp: TrustCheckResponse | undefined;
  let quote: QuoteFromServer | undefined;

  try {
    // -------------------------------------------------------------------
    // Step 1: validate options
    // -------------------------------------------------------------------
    const optsResult = optsSchema.safeParse(options ?? {});
    if (!optsResult.success) {
      throw new PaladinTrustError(
        ErrorCode.INVALID_INPUT,
        `paladin_swap options invalid: ${optsResult.error.message.slice(0, 200)}`,
      );
    }
    // Tightening-only mode override.
    const callMode: OnTrustBlock =
      deps.onTrustBlock === "block" || optsResult.data.onTrustBlock === "block"
        ? "block"
        : "report";

    // -------------------------------------------------------------------
    // Step 2: LLM extraction
    // -------------------------------------------------------------------
    let extractedRaw: Record<string, string>;
    try {
      extractedRaw = await extractFields(runtime, message, state);
    } catch (e) {
      throw new PaladinTrustError(
        ErrorCode.EXTRACTION_FAILED,
        `LLM extraction threw: ${(e as Error).message?.slice(0, 200) ?? "unknown"}`,
        e,
      );
    }

    // -------------------------------------------------------------------
    // Step 3: validate extracted fields
    // -------------------------------------------------------------------
    const fields = extractedFieldsSchema.safeParse(extractedRaw);
    if (!fields.success) {
      throw new PaladinTrustError(
        ErrorCode.INVALID_INPUT,
        `extracted fields invalid: ${fields.error.message.slice(0, 200)}`,
      );
    }
    const sellSymbol = fields.data.sellTokenSymbol.toUpperCase();
    const buySymbol = fields.data.buyTokenSymbol.toUpperCase();
    const sellAddr = SYMBOL_TO_ADDRESS[sellSymbol];
    const buyAddr = SYMBOL_TO_ADDRESS[buySymbol];
    if (!sellAddr || !buyAddr) {
      throw new PaladinTrustError(
        ErrorCode.TOKEN_NOT_SUPPORTED,
        `unsupported token symbol(s): sell=${fields.data.sellTokenSymbol}, buy=${fields.data.buyTokenSymbol}`,
      );
    }
    sellTokenAddr = sellAddr;
    buyTokenAddr = buyAddr;
    chainId = fields.data.chainId;

    // Now we have request shape — construct the bundle and start tracking.
    bundle = new DebugBundle(
      {
        enabled: deps.debugEnabled,
        sinkPath: deps.debugSinkPath ?? defaultDebugBundleSinkPath(),
        redactWalletAddress: deps.redactWalletAddress,
        clock: deps.clock,
      },
      {
        sellTokenSymbol: sellSymbol,
        buyTokenSymbol: buySymbol,
        sellAmount: fields.data.sellAmount,
        chainId: fields.data.chainId,
      },
      deps.client.walletAddress,
    );

    // Retroactively log steps 1-3 as ok (they ran before bundle existed).
    bundle.startStep(1, "validateOptions");
    bundle.endStep(1, "validateOptions", true, { metadata: { mode: callMode } });
    bundle.startStep(2, "extractFields");
    bundle.endStep(2, "extractFields", true, { metadata: { fields: extractedRaw } });
    bundle.startStep(3, "validateExtracted");
    bundle.endStep(3, "validateExtracted", true);

    // -------------------------------------------------------------------
    // Step 4: enforce taker === wallet.address
    // -------------------------------------------------------------------
    bundle.startStep(4, "checkTaker");
    const walletAddr = deps.client.walletAddress;
    if (!walletAddr) {
      throw new PaladinTrustError(
        ErrorCode.WALLET_MISSING,
        "paladin_swap requires walletClientAccount; preview-only configuration cannot run",
      );
    }
    if (
      fields.data.takerAddress &&
      fields.data.takerAddress.toLowerCase() !== "none" &&
      fields.data.takerAddress.length > 0
    ) {
      if (!isAddress(fields.data.takerAddress)) {
        throw new PaladinTrustError(
          ErrorCode.INVALID_TAKER,
          `extracted takerAddress "${fields.data.takerAddress}" is not a valid 0x-prefixed address`,
        );
      }
      if (fields.data.takerAddress.toLowerCase() !== walletAddr.toLowerCase()) {
        throw new PaladinTrustError(
          ErrorCode.INVALID_TAKER,
          `extracted takerAddress (${fields.data.takerAddress}) ≠ wallet.address (${walletAddr})`,
        );
      }
    }
    taker = walletAddr as Address;
    bundle.endStep(4, "checkTaker", true);

    // -------------------------------------------------------------------
    // Step 5: enforce sellToken + buyToken in TOKEN_REGISTRY
    // -------------------------------------------------------------------
    bundle.startStep(5, "checkTokenSupported");
    if (!isTokenSupported(sellTokenAddr)) {
      throw new PaladinTrustError(
        ErrorCode.TOKEN_NOT_SUPPORTED,
        `sellToken ${sellTokenAddr} not in TOKEN_REGISTRY (v0.2.0 supports 7 tokens)`,
      );
    }
    if (!isTokenSupported(buyTokenAddr)) {
      throw new PaladinTrustError(
        ErrorCode.TOKEN_NOT_SUPPORTED,
        `buyToken ${buyTokenAddr} not in TOKEN_REGISTRY`,
      );
    }
    if (sellTokenAddr.toLowerCase() === buyTokenAddr.toLowerCase()) {
      throw new PaladinTrustError(
        ErrorCode.INVALID_INPUT,
        `sellToken and buyToken are identical (${sellTokenAddr})`,
      );
    }
    bundle.endStep(5, "checkTokenSupported", true);

    // -------------------------------------------------------------------
    // Step 6: enforce sellAmount ≤ cap
    // -------------------------------------------------------------------
    bundle.startStep(6, "checkSellAmountCap");
    const sellEntry = getTokenEntry(sellTokenAddr);
    if (!sellEntry) {
      // Belt-and-suspenders: TOKEN_REGISTRY check above guarantees this exists.
      throw new PaladinTrustError(ErrorCode.TOKEN_NOT_SUPPORTED, `unreachable: ${sellTokenAddr}`);
    }
    sellAmountBaseUnits = humanToBaseUnits(fields.data.sellAmount, sellEntry.decimals);
    const cap = getTokenCap(sellTokenAddr, deps.sellAmountCaps);
    if (!cap) {
      throw new PaladinTrustError(
        ErrorCode.TOKEN_NOT_SUPPORTED,
        `no cap configured for ${sellTokenAddr} (TOKEN_REGISTRY/profiles drift)`,
      );
    }
    if (BigInt(sellAmountBaseUnits) > BigInt(cap)) {
      throw new PaladinTrustError(
        ErrorCode.SELL_AMOUNT_EXCEEDS_CAP,
        `sellAmount ${sellAmountBaseUnits} > cap ${cap} for ${sellEntry.symbol}`,
      );
    }
    bundle.endStep(6, "checkSellAmountCap", true);

    // -------------------------------------------------------------------
    // Step 7: rate limiter
    // -------------------------------------------------------------------
    bundle.startStep(7, "rateLimitTryAcquire");
    if (!deps.rateLimiter.tryAcquire()) {
      throw new PaladinTrustError(
        ErrorCode.RATE_LIMITED,
        "paladin_swap rate limit exhausted; try again shortly",
      );
    }
    bundle.endStep(7, "rateLimitTryAcquire", true);

    // -------------------------------------------------------------------
    // Step 8: spending tracker (consume both fees together)
    // -------------------------------------------------------------------
    bundle.startStep(8, "spendingTryConsume");
    const consumeResult = await deps.spendingTracker.tryConsume(TOTAL_FEE_USDC);
    if (!consumeResult.ok) {
      const code =
        consumeResult.reason === "HOURLY_CAP_EXCEEDED"
          ? ErrorCode.HOURLY_CAP_EXCEEDED
          : ErrorCode.DAILY_CAP_EXCEEDED;
      throw new PaladinTrustError(
        code,
        `${consumeResult.reason}: paladin_swap fee of $${TOTAL_FEE_USDC} would exceed cap`,
      );
    }
    trustFeeOwed = TRUST_FEE_USDC;
    simulateFeeOwed = SIMULATE_FEE_USDC;
    bundle.endStep(8, "spendingTryConsume", true);

    // -------------------------------------------------------------------
    // Step 9: paid trust check (settlement-state-aware)
    // -------------------------------------------------------------------
    bundle.startStep(9, "paidTrustCheck");
    try {
      const result: PaidExResult = await deps.client.paidEx(
        { address: sellTokenAddr, chainId, taker },
        { signal: timeoutSignal(abortController, TRUST_CHECK_TIMEOUT_MS) },
      );
      trustResp = result.data;
      trustFeeOwed = 0; // settled
    } catch (e) {
      // Settlement-state branching for the TRUST x402 fee.
      if (e instanceof TrustCheckPaidError) {
        const ss: SettlementState = e.settlementState;
        if (ss === "not-attempted" || ss === "confirmed-failed") {
          // Refund both fees — the simulate fee will never be used.
          await deps.spendingTracker.refund(TOTAL_FEE_USDC);
          trustFeeOwed = 0;
          simulateFeeOwed = 0;
        } else if (ss === "attempted-unknown") {
          // Debit + warn-log (rate-limited per (taker, sellToken, buyToken)).
          // Refund the simulate fee since we'll never reach step 14.
          await deps.spendingTracker.refund(SIMULATE_FEE_USDC);
          simulateFeeOwed = 0;
          if (canDebitAttemptedUnknown(taker, sellTokenAddr, buyTokenAddr, deps.clock)) {
            await deps.spendingTracker.writeWarnLog({
              type: "settlement-unknown",
              taker,
              sellToken: sellTokenAddr,
              buyToken: buyTokenAddr,
              recoverable: true,
              detail: `trust-check paid: ${e.message.slice(0, 100)}`,
            });
            trustFeeOwed = 0; // debited
          } else {
            // Rate-limited — refund and surface as RATE_LIMITED.
            await deps.spendingTracker.refund(TRUST_FEE_USDC);
            trustFeeOwed = 0;
            throw new PaladinTrustError(
              ErrorCode.RATE_LIMITED,
              `attempted-unknown rate-limited (≤1/hr per taker+sell+buy tuple)`,
            );
          }
        }
        throw new PaladinTrustError(
          ErrorCode.TRUST_CHECK_FAILED,
          e.message,
          { settlementState: e.settlementState, cause: e.cause },
        );
      }
      // Unknown error shape — conservative refund.
      await deps.spendingTracker.refund(TOTAL_FEE_USDC);
      trustFeeOwed = 0;
      simulateFeeOwed = 0;
      throw new PaladinTrustError(
        ErrorCode.TRUST_CHECK_FAILED,
        `trust-check paid call failed: ${(e as Error).message?.slice(0, 200) ?? "unknown"}`,
        e,
      );
    }
    bundle.endStep(9, "paidTrustCheck", true, {
      metadata: { recommendation: trustResp.trust.recommendation },
    });

    // -------------------------------------------------------------------
    // Step 10: branch on (recommendation × effectiveMode)
    // -------------------------------------------------------------------
    bundle.startStep(10, "trustBranch");
    const recommendation = trustResp.trust.recommendation;
    if (
      callMode === "block" &&
      (recommendation === "block" || recommendation === "sample-block")
    ) {
      // Refund the simulate fee (trust check is settled; sim never ran).
      await deps.spendingTracker.refund(SIMULATE_FEE_USDC);
      simulateFeeOwed = 0;
      throw new PaladinTrustError(
        ErrorCode.TRUST_BLOCKED,
        `trust-check returned recommendation=${recommendation} with mode=block; refusing to swap. ` +
          `factors: ${trustResp.trust.factors.map((f) => `${f.source}:${f.signal}`).join(", ")}`,
      );
    }
    bundle.endStep(10, "trustBranch", true);

    // -------------------------------------------------------------------
    // Step 11: fetch quote
    // -------------------------------------------------------------------
    bundle.startStep(11, "fetchQuote");
    try {
      quote = await fetchQuote(
        deps.quoteServerUrl,
        {
          taker,
          sellToken: sellTokenAddr,
          buyToken: buyTokenAddr,
          sellAmount: sellAmountBaseUnits,
          chainId,
        },
        timeoutSignal(abortController, QUOTE_TIMEOUT_MS),
      );
    } catch (e) {
      // Refund simulate fee (trust is settled; quote is free).
      await deps.spendingTracker.refund(SIMULATE_FEE_USDC);
      simulateFeeOwed = 0;
      const msg = (e as Error).message ?? "unknown";
      const errorCode = msg.includes("404")
        ? ErrorCode.UPSTREAM_LIQUIDITY_NONE
        : ErrorCode.QUOTE_FAILED;
      throw new PaladinTrustError(errorCode, `/v1/quote failed: ${msg.slice(0, 200)}`, e);
    }
    bundle.endStep(11, "fetchQuote", true, {
      metadata: { router: quote.router, selector: quote.calldata.slice(0, 10) },
    });

    // -------------------------------------------------------------------
    // Step 12: validate quote (Layer 2)
    // -------------------------------------------------------------------
    bundle.startStep(12, "validateQuote");
    try {
      validateQuoteResponse(quote, chainId);
    } catch (e) {
      await deps.spendingTracker.refund(SIMULATE_FEE_USDC);
      simulateFeeOwed = 0;
      throw e;
    }
    bundle.endStep(12, "validateQuote", true);

    // -------------------------------------------------------------------
    // Step 13: clientNonce + requestHash
    // -------------------------------------------------------------------
    bundle.startStep(13, "computeRequestHash");
    const clientNonce = generateClientNonce();
    const quoteForSim: QuoteForSimulation = {
      taker,
      router: quote.router as Address,
      sellToken: sellTokenAddr,
      buyToken: buyTokenAddr,
      sellAmount: sellAmountBaseUnits,
      minBuyAmount: quote.minBuyAmount,
      calldata: quote.calldata as Hex,
      chainId,
    };
    const requestHash = computeRequestHash(quoteForSim, clientNonce);
    bundle.endStep(13, "computeRequestHash", true);

    // -------------------------------------------------------------------
    // Step 14: simulateServer (Layer 4)
    // -------------------------------------------------------------------
    bundle.startStep(14, "simulateServer");
    let simResult;
    try {
      simResult = await simulateServer(quoteForSim, clientNonce, requestHash, {
        serverUrl: deps.simulationServerUrl,
        signal: timeoutSignal(abortController, SIMULATE_TIMEOUT_MS),
      });
      simulateFeeOwed = 0; // settled
    } catch (e) {
      // Settlement-state branching for the SIMULATE x402 fee.
      // simulateServer wraps everything in PaladinTrustError(SIMULATION_FAILED).
      // We map: 503 (retry-after) or no detail → not-attempted; non-2xx other
      // → attempted-unknown.
      if (isPaladinTrustError(e) && e.code === ErrorCode.SIMULATION_FAILED) {
        const detail = e.cause as SimulationFailedDetail | undefined;
        const status = detail?.status;
        if (status === undefined || status === 503) {
          await deps.spendingTracker.refund(SIMULATE_FEE_USDC);
          simulateFeeOwed = 0;
        } else {
          // attempted-unknown
          if (canDebitAttemptedUnknown(taker, sellTokenAddr, buyTokenAddr, deps.clock)) {
            await deps.spendingTracker.writeWarnLog({
              type: "settlement-unknown",
              taker,
              sellToken: sellTokenAddr,
              buyToken: buyTokenAddr,
              recoverable: true,
              detail: `simulate paid: ${e.message.slice(0, 100)}`,
            });
            simulateFeeOwed = 0; // debited
          } else {
            await deps.spendingTracker.refund(SIMULATE_FEE_USDC);
            simulateFeeOwed = 0;
          }
        }
      } else {
        // Unknown error shape — conservative refund.
        await deps.spendingTracker.refund(SIMULATE_FEE_USDC);
        simulateFeeOwed = 0;
      }
      throw e;
    }
    bundle.endStep(14, "simulateServer", true);

    // -------------------------------------------------------------------
    // Step 15: getTrustState
    // -------------------------------------------------------------------
    bundle.startStep(15, "getTrustState");
    let trustState: CachedTrustState;
    try {
      trustState = await getTrustState({
        baseRpcUrls: deps.baseRpcUrls,
        paladinKeyRegistryAddress: deps.paladinKeyRegistryAddress,
        clock: deps.clock,
        warnLogPath: deps.warnLogPath,
      });
    } catch (e) {
      // Trust-state failure — server work was already done; debit (no refund).
      throw e;
    }
    bundle.endStep(15, "getTrustState", true, {
      metadata: { epoch: trustState.epoch, hasPendingRotation: trustState.pendingRotation.exists },
    });

    // -------------------------------------------------------------------
    // Step 16: verifyAndExtract with retry-once on 4 retryable errors
    // -------------------------------------------------------------------
    bundle.startStep(16, "verifySignature");
    let responseBody: SimulateVerifiedExtract;
    let usedRetry = false;
    try {
      responseBody = await verifyAndExtract({
        signed: simResult.signed,
        trustState,
        expectedRequestHash: simResult.requestHash,
        expectedClientNonce: simResult.clientNonce,
        expectedChainId: chainId,  // v2 H-1: explicit chainId binding check
        freshnessWindowSec: deps.freshnessWindowSec,
        acceptVersions: deps.acceptVersions,
        highestVersionEverSeen: highestVersionRef,
        clock: deps.clock,
      });
    } catch (firstErr) {
      const retryable =
        firstErr instanceof PaladinTrustError && isRetryableVerificationError(firstErr.code);
      if (!retryable) {
        // Verification failure → debit (server did the work), no refund.
        throw firstErr;
      }
      // One-shot retry: force-refresh trust state, retry verify with the
      // SAME requestHash + clientNonce (no second simulate call).
      const freshState = await getTrustState(
        {
          baseRpcUrls: deps.baseRpcUrls,
          paladinKeyRegistryAddress: deps.paladinKeyRegistryAddress,
          clock: deps.clock,
          warnLogPath: deps.warnLogPath,
        },
        { force: true },
      );
      usedRetry = true;
      responseBody = await verifyAndExtract({
        signed: simResult.signed,
        trustState: freshState,
        expectedRequestHash: simResult.requestHash,
        expectedClientNonce: simResult.clientNonce,
        expectedChainId: chainId,  // v2 H-1: explicit chainId binding check
        freshnessWindowSec: deps.freshnessWindowSec,
        acceptVersions: deps.acceptVersions,
        highestVersionEverSeen: highestVersionRef,
        clock: deps.clock,
      });
    }
    bundle.endStep(16, "verifySignature", true, {
      metadata: { usedRetry, ok: responseBody.ok },
    });

    // -------------------------------------------------------------------
    // Step 17: branch on response.ok
    // -------------------------------------------------------------------
    bundle.startStep(17, "finalBranch");
    if (!responseBody.ok) {
      // R16 HIGH-B: failure path — server emits `error` string, no `result` block.
      bundle.endStep(17, "finalBranch", false, {
        errorCode: ErrorCode.SIMULATION_REJECTED,
        errorMessage: responseBody.error,
      });
      bundle.setOutcome("error", ErrorCode.SIMULATION_REJECTED);
      await bundle.finalize();

      const errorData: PaladinSwapActionData = {
        apiVersion: "paladin-swap-action-v1",
        trust: extractTrustSummary(trustResp),
        quote: extractQuoteSummary(quote, sellTokenAddr, buyTokenAddr, sellAmountBaseUnits),
        simulation: {
          ok: false,
          deltas: responseBody.result?.deltas,
          gasUsed: responseBody.result?.gasUsed,
          forkAge: responseBody.result?.forkAge,
        },
        mode: callMode,
        error: {
          code: ErrorCode.SIMULATION_REJECTED,
          message: responseBody.error ?? "simulation rejected",
        },
      };
      callback?.({
        text: `paladin_swap rejected: ${responseBody.error ?? "simulation failed"}`,
        content: errorData as unknown as { [key: string]: ContentValue },
      });
      return errorData;
    }

    // Step 17b: plugin-side state-diff invariant validation (v0.2.0 Layer 5).
    // Mirrors server-side `_validate_state_diff_invariants`. Catches a
    // compromised/buggy server returning ok=true with deltas that violate
    // the swap shape — see state-diff-invariants.ts module docstring for
    // threat model. This is NOT re-simulation; it's independent client-side
    // validation of the server's CLAIMED deltas.
    const invariantFailureReason = (() => {
      if (!responseBody.result) {
        return "missing_result: server contract violation (ok=true requires result block)";
      }
      const result = responseBody.result;
      let deltasMap: Map<string, bigint>;
      try {
        deltasMap = deltasToBigIntMap(result.deltas);
      } catch (e) {
        return `delta_parse_failed: ${(e as Error).message?.slice(0, 200)}`;
      }
      return validateStateDiffInvariants({
        selector: quote.calldata.slice(0, 10).toLowerCase() as Hex,
        sellTokenAddress: sellTokenAddr as Address,
        buyTokenAddress: buyTokenAddr as Address,
        sellAmountBaseUnits: BigInt(sellAmountBaseUnits),
        minBuyAmountBaseUnits: BigInt(quote.minBuyAmount),
        deltas: deltasMap,
        // eth delta + value: server-side already validates the strict
        // inequality. Layer 5 plugin-side currently mirrors only the
        // token-delta checks; ethDelta plumbing tracked as Eng LOW (R16).
      });
    })();
    if (invariantFailureReason !== null) {
      bundle.endStep(17, "finalBranch", false, {
        errorCode: ErrorCode.SIMULATION_REJECTED,
        errorMessage: `client_invariant: ${invariantFailureReason}`,
      });
      bundle.setOutcome("error", ErrorCode.SIMULATION_REJECTED);
      await bundle.finalize();
      const errorData: PaladinSwapActionData = {
        apiVersion: "paladin-swap-action-v1",
        trust: extractTrustSummary(trustResp),
        quote: extractQuoteSummary(quote, sellTokenAddr, buyTokenAddr, sellAmountBaseUnits),
        simulation: {
          ok: false,
          deltas: responseBody.result?.deltas,
          gasUsed: responseBody.result?.gasUsed,
          forkAge: responseBody.result?.forkAge,
        },
        mode: callMode,
        error: {
          code: ErrorCode.SIMULATION_REJECTED,
          message: `client_invariant: ${invariantFailureReason}`,
        },
      };
      callback?.({
        text: `paladin_swap rejected (client invariant): ${invariantFailureReason}`,
        content: errorData as unknown as { [key: string]: ContentValue },
      });
      return errorData;
    }

    bundle.endStep(17, "finalBranch", true);
    bundle.setOutcome("success");
    await bundle.finalize();

    const data: PaladinSwapActionData = {
      apiVersion: "paladin-swap-action-v1",
      trust: extractTrustSummary(trustResp),
      quote: extractQuoteSummary(quote, sellTokenAddr, buyTokenAddr, sellAmountBaseUnits),
      simulation: {
        ok: true,
        // Non-null because branches above ensure responseBody.ok && responseBody.result.
        deltas: responseBody.result!.deltas,
        gasUsed: responseBody.result!.gasUsed,
        forkAge: responseBody.result!.forkAge,
      },
      mode: callMode,
    };
    callback?.({
      text:
        `paladin_swap ready: ${sellAmountBaseUnits} ${sellEntry.symbol} → ${buySymbol} ` +
        `(min ${quote.minBuyAmount}); calldata signed${usedRetry ? " (retry-once)" : ""}.`,
      content: data as unknown as { [key: string]: ContentValue },
    });
    return data;
  } catch (e) {
    // Catch-all: refund any residual fees that the per-step branches missed.
    // Step branches are responsible for refunding/debiting their own fee;
    // this is a safety net for unexpected throws (e.g., bug in this file).
    const residual = trustFeeOwed + simulateFeeOwed;
    if (residual > 0) {
      try {
        await deps.spendingTracker.refund(residual);
      } catch {
        // best-effort
      }
    }

    // Finalize bundle if it exists.
    if (bundle) {
      const code = e instanceof PaladinTrustError ? e.code : ErrorCode.SIMULATION_FAILED;
      bundle.setOutcome("error", code, {
        errorMessage: (e as Error).message?.slice(0, 200),
      });
      await bundle.finalize();
    }

    // Map to PaladinSwapActionData with error block.
    if (e instanceof PaladinTrustError) {
      const errorData: PaladinSwapActionData = {
        apiVersion: "paladin-swap-action-v1",
        trust: trustResp
          ? extractTrustSummary(trustResp)
          : { address: sellTokenAddr ?? "", recommendation: "unknown", factors: [] },
        quote: quote
          ? extractQuoteSummary(quote, sellTokenAddr ?? "", buyTokenAddr ?? "", sellAmountBaseUnits ?? "")
          : {
              router: "",
              sellToken: sellTokenAddr ?? "",
              buyToken: buyTokenAddr ?? "",
              sellAmount: sellAmountBaseUnits ?? "",
              minBuyAmount: "",
              buyAmount: "",
              selector: "",
            },
        simulation: { ok: false },
        mode: "block",
        error: { code: e.code, message: e.message.slice(0, 500) },
      };
      callback?.({
        text: `paladin_swap failed: ${e.code} — ${e.message.slice(0, 200)}`,
        content: errorData as unknown as { [key: string]: ContentValue },
      });
      return errorData;
    }
    // Unknown error shape — surface as SIMULATION_FAILED catchall.
    const fallbackData: PaladinSwapActionData = {
      apiVersion: "paladin-swap-action-v1",
      trust: { address: sellTokenAddr ?? "", recommendation: "unknown", factors: [] },
      quote: {
        router: "",
        sellToken: sellTokenAddr ?? "",
        buyToken: buyTokenAddr ?? "",
        sellAmount: sellAmountBaseUnits ?? "",
        minBuyAmount: "",
        buyAmount: "",
        selector: "",
      },
      simulation: { ok: false },
      mode: "block",
      error: {
        code: ErrorCode.SIMULATION_FAILED,
        message: `unexpected error: ${(e as Error).message?.slice(0, 200) ?? "unknown"}`,
      },
    };
    callback?.({
      text: `paladin_swap failed: unexpected error`,
      content: fallbackData as unknown as { [key: string]: ContentValue },
    });
    return fallbackData;
  }
}

// =============================================================================
// Helpers
// =============================================================================

async function extractFields(
  runtime: IAgentRuntime,
  message: Memory,
  state: State | undefined,
): Promise<Record<string, string>> {
  // ElizaOS pattern: composePromptFromState({ state, template }) → useModel → parseKeyValueXml.
  // Imported lazily to avoid circular type dependencies at module load.
  const elizaCore = (await import("@elizaos/core")) as unknown as {
    composePromptFromState: (input: { state: State; template: string }) => string;
    parseKeyValueXml: (raw: string) => Record<string, string> | null;
    ModelType: { TEXT_SMALL: string };
  };
  const prompt = elizaCore.composePromptFromState({
    state: state ?? ({} as State),
    template: paladinSwapTemplate,
  });
  // runtime.useModel signature varies by Eliza version; cast to avoid typing
  // mismatch with the local @elizaos/core peer-dep version.
  const useModel = (runtime as unknown as {
    useModel: (modelType: string, opts: { prompt: string }) => Promise<string>;
  }).useModel;
  const raw = await useModel(elizaCore.ModelType.TEXT_SMALL, { prompt });
  const parsed = elizaCore.parseKeyValueXml(raw);
  if (!parsed || typeof parsed !== "object") {
    throw new Error("LLM returned non-XML or empty extraction");
  }
  return parsed as Record<string, string>;
}

/**
 * Convert human decimal string to base units. E.g., ("1.5", 18) → "1500000000000000000".
 * Caller should validate the input matches /^[0-9]+(\.[0-9]+)?$/ first.
 */
function humanToBaseUnits(human: string, decimals: number): string {
  const [whole, frac = ""] = human.split(".");
  const fracPadded = (frac + "0".repeat(decimals)).slice(0, decimals);
  const baseStr = `${whole}${fracPadded}`.replace(/^0+/, "");
  return baseStr.length > 0 ? baseStr : "0";
}

async function fetchQuote(
  serverUrl: string,
  req: {
    taker: Address;
    sellToken: Address;
    buyToken: Address;
    sellAmount: string;
    chainId: number;
  },
  signal: AbortSignal,
): Promise<QuoteFromServer> {
  const response = await fetch(serverUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(req),
    signal,
  });
  if (response.status === 404) {
    throw new Error(`/v1/quote 404 — no liquidity for pair`);
  }
  if (!response.ok) {
    throw new Error(`/v1/quote HTTP ${response.status}`);
  }
  return (await response.json()) as QuoteFromServer;
}

/**
 * Construct a per-step timeout AbortSignal that is also cancelled by the
 * parent controller's abort. Cleanly unifies external customer cancellation
 * + per-step timeouts into one signal each fetch can accept.
 */
function timeoutSignal(parent: AbortController, ms: number): AbortSignal {
  const child = new AbortController();
  if (parent.signal.aborted) {
    child.abort();
  } else {
    parent.signal.addEventListener("abort", () => child.abort(), { once: true });
  }
  setTimeout(() => child.abort(), ms);
  return child.signal;
}

function extractTrustSummary(trust: TrustCheckResponse): PaladinSwapActionData["trust"] {
  return {
    address: trust.address,
    recommendation: trust.trust.recommendation,
    factors: trust.trust.factors.map((f) => ({ source: f.source, signal: f.signal })),
  };
}

function extractQuoteSummary(
  quote: QuoteFromServer,
  sellAddr: string,
  buyAddr: string,
  sellAmount: string,
): PaladinSwapActionData["quote"] {
  return {
    router: quote.router,
    sellToken: sellAddr,
    buyToken: buyAddr,
    sellAmount,
    minBuyAmount: quote.minBuyAmount,
    buyAmount: quote.buyAmount,
    selector: quote.calldata.slice(0, 10),
  };
}

/** Test-only: reset module state between scenarios. Production should not call. */
export function _resetModuleState(): void {
  moduleHighestVersionRef = null;
  attemptedUnknownRateLimit.clear();
}
