/**
 * Plugin-side state-diff invariant validator tests.
 *
 * Mirrors `paladin-server/tests/test_run_simulation.py:TestValidateStateDiffInvariants`
 * — both implementations are intentionally redundant per the v0.2.0 Layer 5
 * defense-in-depth design. If either side's invariant logic regresses,
 * the cross-language fixture suite (when implemented) catches drift.
 */

import { describe, it, expect } from "vitest";
import type { Address, Hex } from "viem";

import {
  validateStateDiffInvariants,
  deltasToBigIntMap,
  isOutFamilySelector,
  OUT_FAMILY_SELECTORS,
} from "../src/utils/state-diff-invariants";

const USDC = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913" as Address;
const WETH = "0x4200000000000000000000000000000000000006" as Address;
const USDT = "0xfde4c96c8593536e31f229ea8f37b2ada2699bb2" as Address;
const cbBTC = "0xcbb7c0000ab88b473b1f5afd9ef808440eed33bf" as Address;
const DAI = "0x50c5725949a6f0c72e6c4a641f24049a917db0cb" as Address;
const AERO = "0x940181a94a35a4569e4529a3cdfb74e38fd98631" as Address;
const USDbC = "0xd9aaec86b65d86f6a7b5b1b0c42ffa531710b6ca" as Address;

const SWAP_EXACT_AMOUNT_IN: Hex = "0xe3ead59e";
const SWAP_EXACT_AMOUNT_OUT: Hex = "0x5e94e28d";
const SWAP_ON_UNISWAP_V3: Hex = "0x876a02f6";

function makeDeltas(
  sell: bigint,
  buy: bigint,
  extras: Record<string, bigint> = {},
): Map<string, bigint> {
  const m = new Map<string, bigint>();
  // Always include all 7 v0.2.0 TOKEN_REGISTRY tokens with delta=0 by default
  for (const t of [USDC, USDT, WETH, cbBTC, DAI, AERO, USDbC]) {
    m.set(t.toLowerCase(), 0n);
  }
  m.set(USDC.toLowerCase(), sell);
  m.set(WETH.toLowerCase(), buy);
  for (const [addr, delta] of Object.entries(extras)) {
    m.set(addr.toLowerCase(), delta);
  }
  return m;
}

describe("OUT_FAMILY_SELECTORS classification", () => {
  it("classifies swapExactAmountOut as Out*", () => {
    expect(isOutFamilySelector(SWAP_EXACT_AMOUNT_OUT)).toBe(true);
  });
  it("classifies swapExactAmountIn as In* (default)", () => {
    expect(isOutFamilySelector(SWAP_EXACT_AMOUNT_IN)).toBe(false);
  });
  it("classifies swapOnUniswapV3 as In* (default)", () => {
    expect(isOutFamilySelector(SWAP_ON_UNISWAP_V3)).toBe(false);
  });
  it("is case-insensitive", () => {
    expect(isOutFamilySelector("0x5E94E28D" as Hex)).toBe(true);
  });
  it("conservative — only one selector classified Out at v0.2.0", () => {
    expect(OUT_FAMILY_SELECTORS.size).toBe(1);
  });
});

describe("In* family (default — every selector EXCEPT swapExactAmountOut)", () => {
  it("exact match passes", () => {
    const result = validateStateDiffInvariants({
      selector: SWAP_EXACT_AMOUNT_IN,
      sellTokenAddress: USDC,
      buyTokenAddress: WETH,
      sellAmountBaseUnits: 1_000_000n,
      minBuyAmountBaseUnits: 900_000_000_000_000n,
      deltas: makeDeltas(-1_000_000n, 999_000_000_000_000n),
    });
    expect(result).toBeNull();
  });

  it("sell delta short (< sellAmount) rejects", () => {
    const result = validateStateDiffInvariants({
      selector: SWAP_EXACT_AMOUNT_IN,
      sellTokenAddress: USDC,
      buyTokenAddress: WETH,
      sellAmountBaseUnits: 1_000_000n,
      minBuyAmountBaseUnits: 0n,
      deltas: makeDeltas(-999_999n, 999_000_000_000_000n),
    });
    expect(result).toContain("in_family_sell_delta_mismatch");
  });

  it("sell delta over (> sellAmount) rejects", () => {
    const result = validateStateDiffInvariants({
      selector: SWAP_EXACT_AMOUNT_IN,
      sellTokenAddress: USDC,
      buyTokenAddress: WETH,
      sellAmountBaseUnits: 1_000_000n,
      minBuyAmountBaseUnits: 0n,
      deltas: makeDeltas(-2_000_000n, 999_000_000_000_000n),
    });
    expect(result).toContain("in_family_sell_delta_mismatch");
  });

  it("buy delta below minBuyAmount rejects", () => {
    const result = validateStateDiffInvariants({
      selector: SWAP_EXACT_AMOUNT_IN,
      sellTokenAddress: USDC,
      buyTokenAddress: WETH,
      sellAmountBaseUnits: 1_000_000n,
      minBuyAmountBaseUnits: 1_000_000_000_000_000n,
      deltas: makeDeltas(-1_000_000n, 999_000_000_000_000n),
    });
    expect(result).toContain("in_family_buy_delta_below_min");
  });

  it("V3 callback path (swapOnUniswapV3) defaults to In* semantics", () => {
    const result = validateStateDiffInvariants({
      selector: SWAP_ON_UNISWAP_V3,
      sellTokenAddress: USDC,
      buyTokenAddress: WETH,
      sellAmountBaseUnits: 1_000_000n,
      minBuyAmountBaseUnits: 900_000_000_000_000n,
      deltas: makeDeltas(-1_000_000n, 999_000_000_000_000n),
    });
    expect(result).toBeNull();
  });
});

describe("Out* family (swapExactAmountOut)", () => {
  it("within cap passes", () => {
    const result = validateStateDiffInvariants({
      selector: SWAP_EXACT_AMOUNT_OUT,
      sellTokenAddress: USDC,
      buyTokenAddress: WETH,
      sellAmountBaseUnits: 1_000_000n,
      minBuyAmountBaseUnits: 900_000_000_000_000n,
      deltas: makeDeltas(-800_000n, 999_000_000_000_000n),
    });
    expect(result).toBeNull();
  });

  it("exceeds cap rejects", () => {
    const result = validateStateDiffInvariants({
      selector: SWAP_EXACT_AMOUNT_OUT,
      sellTokenAddress: USDC,
      buyTokenAddress: WETH,
      sellAmountBaseUnits: 1_000_000n,
      minBuyAmountBaseUnits: 0n,
      deltas: makeDeltas(-1_500_000n, 999_000_000_000_000n),
    });
    expect(result).toContain("out_family_sell_delta_oob");
  });

  it("zero spend rejects (must spend something)", () => {
    const result = validateStateDiffInvariants({
      selector: SWAP_EXACT_AMOUNT_OUT,
      sellTokenAddress: USDC,
      buyTokenAddress: WETH,
      sellAmountBaseUnits: 1_000_000n,
      minBuyAmountBaseUnits: 0n,
      deltas: makeDeltas(0n, 999_000_000_000_000n),
    });
    expect(result).toContain("out_family_sell_delta_oob");
  });

  it("buy delta below min rejects", () => {
    const result = validateStateDiffInvariants({
      selector: SWAP_EXACT_AMOUNT_OUT,
      sellTokenAddress: USDC,
      buyTokenAddress: WETH,
      sellAmountBaseUnits: 1_000_000n,
      minBuyAmountBaseUnits: 1_000_000_000_000_000n,
      deltas: makeDeltas(-800_000n, 999_000_000_000_000n),
    });
    expect(result).toContain("out_family_buy_delta_below_min");
  });

  it("exactly at sellAmount cap passes", () => {
    const result = validateStateDiffInvariants({
      selector: SWAP_EXACT_AMOUNT_OUT,
      sellTokenAddress: USDC,
      buyTokenAddress: WETH,
      sellAmountBaseUnits: 1_000_000n,
      minBuyAmountBaseUnits: 0n,
      deltas: makeDeltas(-1_000_000n, 999_000_000_000_000n),
    });
    expect(result).toBeNull();
  });
});

describe("Third-token drain check (R6 H1, load-bearing)", () => {
  it("drain in third token rejects", () => {
    const result = validateStateDiffInvariants({
      selector: SWAP_EXACT_AMOUNT_IN,
      sellTokenAddress: USDC,
      buyTokenAddress: WETH,
      sellAmountBaseUnits: 1_000_000n,
      minBuyAmountBaseUnits: 0n,
      deltas: makeDeltas(-1_000_000n, 999_000_000_000_000n, {
        [USDT]: -500_000n,
      }),
    });
    expect(result).toContain("third_token_drain");
    expect(result).toContain(USDT.toLowerCase());
  });

  it("unexpected credit in third token rejects", () => {
    // Even tiny non-zero deltas count
    const result = validateStateDiffInvariants({
      selector: SWAP_EXACT_AMOUNT_IN,
      sellTokenAddress: USDC,
      buyTokenAddress: WETH,
      sellAmountBaseUnits: 1_000_000n,
      minBuyAmountBaseUnits: 0n,
      deltas: makeDeltas(-1_000_000n, 999_000_000_000_000n, {
        [cbBTC]: 1n,
      }),
    });
    expect(result).toContain("third_token_drain");
    expect(result).toContain(cbBTC.toLowerCase());
  });

  it("multiple TOKEN_REGISTRY zero-deltas pass (no false positive)", () => {
    // Default makeDeltas already populates all 7 with zeros
    const result = validateStateDiffInvariants({
      selector: SWAP_EXACT_AMOUNT_IN,
      sellTokenAddress: USDC,
      buyTokenAddress: WETH,
      sellAmountBaseUnits: 1_000_000n,
      minBuyAmountBaseUnits: 0n,
      deltas: makeDeltas(-1_000_000n, 999_000_000_000_000n),
    });
    expect(result).toBeNull();
  });
});

describe("Native ETH delta sanity (advisory, value=0)", () => {
  it("ETH credit with zero value rejects", () => {
    const result = validateStateDiffInvariants({
      selector: SWAP_EXACT_AMOUNT_IN,
      sellTokenAddress: USDC,
      buyTokenAddress: WETH,
      sellAmountBaseUnits: 1_000_000n,
      minBuyAmountBaseUnits: 0n,
      deltas: makeDeltas(-1_000_000n, 999_000_000_000_000n),
      ethDelta: 1n,
      valueWei: 0n,
    });
    expect(result).toContain("native_eth_credit_unexpected");
  });

  it("ETH drain above gas ceiling rejects", () => {
    const result = validateStateDiffInvariants({
      selector: SWAP_EXACT_AMOUNT_IN,
      sellTokenAddress: USDC,
      buyTokenAddress: WETH,
      sellAmountBaseUnits: 1_000_000n,
      minBuyAmountBaseUnits: 0n,
      deltas: makeDeltas(-1_000_000n, 999_000_000_000_000n),
      ethDelta: -10_000_000_000_000_000n, // 0.01 ETH > 0.008 ETH ceiling
      valueWei: 0n,
    });
    expect(result).toContain("native_eth_drain_exceeds_gas_ceiling");
  });

  it("ETH drain within gas ceiling passes", () => {
    const result = validateStateDiffInvariants({
      selector: SWAP_EXACT_AMOUNT_IN,
      sellTokenAddress: USDC,
      buyTokenAddress: WETH,
      sellAmountBaseUnits: 1_000_000n,
      minBuyAmountBaseUnits: 0n,
      deltas: makeDeltas(-1_000_000n, 999_000_000_000_000n),
      ethDelta: -1_000_000_000_000_000n, // 0.001 ETH (typical gas)
      valueWei: 0n,
    });
    expect(result).toBeNull();
  });

  it("ETH check skipped when value > 0 (payable swap)", () => {
    // For a value-bearing swap, ETH delta math is more complex; we don't
    // enforce here. Test with a positive ETH delta + non-zero value to
    // confirm the check is skipped.
    const result = validateStateDiffInvariants({
      selector: SWAP_EXACT_AMOUNT_IN,
      sellTokenAddress: USDC,
      buyTokenAddress: WETH,
      sellAmountBaseUnits: 1_000_000n,
      minBuyAmountBaseUnits: 0n,
      deltas: makeDeltas(-1_000_000n, 999_000_000_000_000n),
      ethDelta: 1n,
      valueWei: 100n,
    });
    expect(result).toBeNull();
  });

  it("default (no ethDelta/valueWei provided) skips ETH check", () => {
    const result = validateStateDiffInvariants({
      selector: SWAP_EXACT_AMOUNT_IN,
      sellTokenAddress: USDC,
      buyTokenAddress: WETH,
      sellAmountBaseUnits: 1_000_000n,
      minBuyAmountBaseUnits: 0n,
      deltas: makeDeltas(-1_000_000n, 999_000_000_000_000n),
    });
    expect(result).toBeNull();
  });
});

describe("Edge cases", () => {
  it("missing sell token in deltas returns failure", () => {
    const m = new Map<string, bigint>();
    m.set(WETH.toLowerCase(), 999_000_000_000_000n);
    const result = validateStateDiffInvariants({
      selector: SWAP_EXACT_AMOUNT_IN,
      sellTokenAddress: USDC,
      buyTokenAddress: WETH,
      sellAmountBaseUnits: 1_000_000n,
      minBuyAmountBaseUnits: 0n,
      deltas: m,
    });
    expect(result).toContain("state_diff_missing_token");
  });

  it("missing buy token in deltas returns failure", () => {
    const m = new Map<string, bigint>();
    m.set(USDC.toLowerCase(), -1_000_000n);
    const result = validateStateDiffInvariants({
      selector: SWAP_EXACT_AMOUNT_IN,
      sellTokenAddress: USDC,
      buyTokenAddress: WETH,
      sellAmountBaseUnits: 1_000_000n,
      minBuyAmountBaseUnits: 0n,
      deltas: m,
    });
    expect(result).toContain("state_diff_missing_token");
  });

  it("address case-insensitive on input", () => {
    const result = validateStateDiffInvariants({
      selector: SWAP_EXACT_AMOUNT_IN,
      sellTokenAddress: "0x833589FCD6EDB6E08F4C7C32D4F71B54BDA02913" as Address,
      buyTokenAddress: "0x4200000000000000000000000000000000000006" as Address,
      sellAmountBaseUnits: 1_000_000n,
      minBuyAmountBaseUnits: 0n,
      deltas: makeDeltas(-1_000_000n, 999_000_000_000_000n),
    });
    expect(result).toBeNull();
  });
});

describe("deltasToBigIntMap helper", () => {
  it("converts string deltas to lowercase-keyed bigint map", () => {
    const result = deltasToBigIntMap({
      "0x833589FCD6EDB6E08F4C7C32D4F71B54BDA02913": "-1000000",
      "0x4200000000000000000000000000000000000006": "999000000000000",
    });
    expect(result.get("0x833589fcd6edb6e08f4c7c32d4f71b54bda02913")).toBe(-1_000_000n);
    expect(result.get("0x4200000000000000000000000000000000000006")).toBe(
      999_000_000_000_000n,
    );
  });

  it("supports zero deltas", () => {
    const result = deltasToBigIntMap({ [USDC]: "0" });
    expect(result.get(USDC.toLowerCase())).toBe(0n);
  });

  it("throws on non-integer string", () => {
    expect(() =>
      deltasToBigIntMap({ [USDC]: "not_a_number" }),
    ).toThrow(/not a base-10 integer/);
  });

  it("throws on float string", () => {
    expect(() => deltasToBigIntMap({ [USDC]: "1.5" })).toThrow(
      /not a base-10 integer/,
    );
  });
});
