/**
 * Plugin-side state-diff invariant validator (v0.2.0 Layer 5).
 *
 * Independent client-side validation of the deltas the server-side simulator
 * (Layer 4) returns. Provides defense-in-depth: if the server's invariant
 * check at `paladin_simulator_service._validate_state_diff_invariants`
 * is bypassed (bug or compromise even with valid 2-of-2 KMS sigs), the
 * plugin still catches the violation here and refuses to surface the calldata
 * to the agent.
 *
 * Mirrors the server-side Python implementation function-for-function. The
 * two implementations are intentionally redundant — they are NOT a single
 * shared module by design (different language, different process, different
 * trust boundary). Drift between the two is detected by the cross-language
 * fixture suite (see tests/canonical-jcs.test.ts when implemented).
 *
 * ## Why this is not "true client-side simulation"
 *
 * v3.4 R6 HIGH-4 originally specified additive Layer 4 (server-side Anvil
 * sim) + Layer 5 (client-side viem sim) defense — both required to pass.
 * Empirically (2026-05-07 viability diagnostic), client-side `eth_call +
 * stateOverride` cannot generalize across aggregator paths: Velora's
 * `swapOnUniswapV3` reverts with `CallbackTransferFailed()` because the
 * actual transferFrom spender is the V3 *pool* (different per quote),
 * not any of the fixed addresses we can mock. Generic state engineering
 * for every possible (executor, pool, gauge) is impractical.
 *
 * This module is the practical alternative: independent validation of the
 * server's CLAIMED deltas. It catches:
 *   - Server-side invariant logic bug (T19's logic isn't applied for some path)
 *   - Compromised server (with valid KMS sigs) returning forged deltas that
 *     happen to lie about a third-token drain or sell/buy delta bounds
 *   - Drift between server and plugin invariant logic (this file IS the
 *     plugin's claim about what's safe; if it diverges from server's claim,
 *     plugin refuses to sign)
 *
 * It does NOT catch:
 *   - Server simulating correctly but signing different calldata (defended
 *     by signed-payload requestHash binding, see paladin-verify.ts step 4)
 *   - Server correctly simulating + signing, but returning a "wrong" but
 *     invariant-satisfying delta (e.g., low slippage that's still above
 *     minBuyAmount). This is the "simulation lies" class of attack which
 *     can only be defeated by truly independent simulation infrastructure
 *     (Tenderly fallback, planned for v0.2.X).
 */

import type { Hex, Address } from "viem";

// =============================================================================
// Selector family classification
// =============================================================================

/**
 * Selectors whose calldata semantically specifies a destination amount
 * rather than a source amount. For these, the user spends UP TO sellAmount
 * (capped) and the actual sell delta is bounded but not equal to sellAmount.
 *
 * Conservative for v0.2.0 — only enumerate selectors with documented
 * Out* semantics. Adding to this set is a behavior change requiring a
 * coordinated server+plugin bump + re-review (drift CI catches mismatch).
 */
export const OUT_FAMILY_SELECTORS: ReadonlySet<string> = new Set<string>([
  "0x5e94e28d", // Velora AugustusSwapper v6.2 swapExactAmountOut
]);

export function isOutFamilySelector(selector: Hex | string): boolean {
  return OUT_FAMILY_SELECTORS.has(selector.toLowerCase());
}

// =============================================================================
// Types
// =============================================================================

export interface StateDiffInvariantInput {
  /** Outer 4-byte function selector from the calldata, lowercased. */
  selector: Hex;
  /** Address of token being sold. Compared lowercase. */
  sellTokenAddress: Address;
  /** Address of token being bought. Compared lowercase. */
  buyTokenAddress: Address;
  /** Quoted sellAmount in base units. */
  sellAmountBaseUnits: bigint;
  /** Quoted minBuyAmount in base units (slippage floor). */
  minBuyAmountBaseUnits: bigint;
  /**
   * Token-address (lowercase) → delta as bigint (post - pre).
   * Negative = decrease (spent), positive = increase (received).
   * MUST contain entries for both sellToken and buyToken.
   * SHOULD contain entries for every other TOKEN_REGISTRY token (R6 H1
   * third-token drain check requires the closed-set inspection).
   */
  deltas: ReadonlyMap<string, bigint>;
  /** Native ETH balance change (post - pre) in wei. Default 0n. */
  ethDelta?: bigint;
  /** Native ETH `value` sent with the simulated tx, in wei. Default 0n. */
  valueWei?: bigint;
}

// =============================================================================
// Constants
// =============================================================================

/**
 * Acceptable native-ETH gas-cost ceiling for a non-payable swap. 0.008 ETH
 * is comfortably above any real Base mainnet swap's gas cost (typical:
 * 100k-500k gas × ~0.001 gwei base fee = ~0.0001-0.0005 ETH). A drain
 * deeper than this is suspicious.
 *
 * Tuned to match server-side `paladin_simulator_service.py:GAS_CEILING_WEI`.
 */
const GAS_CEILING_WEI = 8_000_000_000_000_000n; // 0.008 ETH

// =============================================================================
// Public API
// =============================================================================

/**
 * Validate the post-simulation balance deltas against the expected swap
 * shape. Returns null if sound, or a failure-reason string if violated.
 *
 * Three checks (v3.4 §3.11 + R6 H1/H2 fixes):
 *
 *   1. Per-selector sell/buy delta semantic check:
 *      - In* family (default): sell_delta == -sellAmount EXACT;
 *        buy_delta >= minBuyAmount.
 *      - Out* family (`swapExactAmountOut`): -sellAmount <= sell_delta < 0;
 *        buy_delta >= minBuyAmount.
 *
 *   2. Third-token drain check (R6 H1, load-bearing): for every entry in
 *      `deltas` that is NOT (sellToken, buyToken), assert delta === 0n.
 *      Non-zero deltas in third tokens indicate the calldata leaked funds
 *      to/from a token outside the headline swap.
 *
 *   3. Native ETH delta sanity (advisory): for non-payable swaps
 *      (value_wei === 0n), the only ETH change should be gas burn. Native
 *      ETH leaks beyond a generous gas-cost ceiling are flagged. Positive
 *      ETH delta with value=0 is also flagged.
 */
export function validateStateDiffInvariants(
  input: StateDiffInvariantInput,
): string | null {
  const sellLc = input.sellTokenAddress.toLowerCase();
  const buyLc = input.buyTokenAddress.toLowerCase();

  const sellDelta = input.deltas.get(sellLc);
  const buyDelta = input.deltas.get(buyLc);
  if (sellDelta === undefined || buyDelta === undefined) {
    return `state_diff_missing_token: sell=${sellLc} buy=${buyLc}`;
  }

  const sellAmount = input.sellAmountBaseUnits;
  const minBuyAmount = input.minBuyAmountBaseUnits;

  // 1. Per-selector semantic check.
  if (isOutFamilySelector(input.selector)) {
    // Out*: spent UP TO sellAmount, received >= minBuyAmount.
    // sell_delta must be in [-sellAmount, 0) — negative (spent) but bounded.
    if (!(-sellAmount <= sellDelta && sellDelta < 0n)) {
      return `out_family_sell_delta_oob: ${sellDelta} not in [-${sellAmount}, 0)`;
    }
    if (buyDelta < minBuyAmount) {
      return `out_family_buy_delta_below_min: ${buyDelta} < ${minBuyAmount}`;
    }
  } else {
    // In*: spent EXACTLY sellAmount, received >= minBuyAmount.
    if (sellDelta !== -sellAmount) {
      return `in_family_sell_delta_mismatch: ${sellDelta} != -${sellAmount}`;
    }
    if (buyDelta < minBuyAmount) {
      return `in_family_buy_delta_below_min: ${buyDelta} < ${minBuyAmount}`;
    }
  }

  // 2. Third-token drain check (R6 H1).
  for (const [addr, delta] of input.deltas) {
    if (addr !== sellLc && addr !== buyLc && delta !== 0n) {
      return `third_token_drain: ${addr}=${delta}`;
    }
  }

  // 3. Native ETH delta sanity.
  const ethDelta = input.ethDelta ?? 0n;
  const valueWei = input.valueWei ?? 0n;
  if (valueWei === 0n) {
    if (ethDelta > 0n) {
      return `native_eth_credit_unexpected: +${ethDelta} wei with value_wei=0`;
    }
    if (ethDelta < -GAS_CEILING_WEI) {
      return `native_eth_drain_exceeds_gas_ceiling: ${ethDelta} < -${GAS_CEILING_WEI}`;
    }
  }

  return null;
}

/**
 * Helper: convert a server-side `expectedBalanceChange: Record<string, string>`
 * (string base-unit deltas keyed by lowercased address) to the bigint Map
 * shape required by `validateStateDiffInvariants`. Throws if any value is
 * not parseable as a base-10 integer (server contract violation).
 */
export function deltasToBigIntMap(
  deltas: Record<string, string>,
): Map<string, bigint> {
  const result = new Map<string, bigint>();
  for (const [addr, value] of Object.entries(deltas)) {
    let bigintValue: bigint;
    try {
      bigintValue = BigInt(value);
    } catch {
      throw new TypeError(
        `delta value not a base-10 integer: ${addr}=${value}`,
      );
    }
    result.set(addr.toLowerCase(), bigintValue);
  }
  return result;
}
