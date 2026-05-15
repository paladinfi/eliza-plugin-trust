/**
 * Layer 2 — client-side router/selector/Settler-target/deny-list validation.
 *
 * Mirrors the server-side allowlist check (paladin-swap-mcp v0.11.71+).
 * Per v11 §4.9 + CLAUDE.md "Current Architecture" v0.11.71:
 *   - Layer 1: outer router whitelist (server-side, existing)
 *   - Layer 2: outer selector allowlist (this file, client-side mirror)
 *   - Layer 3 (load-bearing): for 0x exec, decode + validate inner `target` arg
 *     against 0x Settler whitelist. Without this, layer 2 is cosmetic since
 *     AllowanceHolder.exec is a `target.call(data)` dispatcher.
 *   - Hard deny-list (7 selectors): unconditional rejection even in WARN mode.
 *
 * Drift CI test (drift.test.ts at Step 21) asserts byte-equality between
 * this file's constants and the server-side `paladin-swap-mcp` Layer 2 module.
 *
 * Adding a new chain or selector requires a coordinated server-side change
 * + drift CI re-run + plugin bump. The pre-publish hook fails on mismatch.
 */

import { PaladinTrustError, ErrorCode } from "../errors";

// =============================================================================
// Selectors — function selectors are the first 4 bytes of keccak256(signature)
// =============================================================================

/**
 * Hard deny-list: 7 selectors that MUST never appear as the outer calldata
 * selector, regardless of mode. Listed in v0.11.71 production allowlist.
 *
 * Even WARN-only mode cannot bypass this — these are the universal
 * funds-loss vectors (transferFrom, approve, Permit2 signed transfers).
 */
export const CLIENT_SIDE_DENY_LIST: readonly `0x${string}`[] = Object.freeze([
  // ERC20 transferFrom(address,address,uint256)
  "0x23b872dd",
  // ERC20 transfer(address,uint256)
  "0xa9059cbb",
  // ERC20 approve(address,uint256)
  "0x095ea7b3",
  // Permit2 permitTransferFrom (signed transfer) — the dominant funds-drain
  // vector if a signed Permit2 message reaches the router as outer calldata
  "0x30f28b7a",
  // Permit2 AllowanceTransfer.transferFrom(address,address,uint160,address)
  "0x36c78516",
  // Permit2 permit single (PermitSingle)
  "0x2b67b570",
  // Permit2 permit batch (PermitBatch)
  "0x2a2d80d1",
]);

// =============================================================================
// Per-chain allowlists — Base only at v0.2.0 (chainId 8453)
// =============================================================================

const BASE_CHAIN_ID = 8453;

/**
 * Allowed router contracts. Outer `to` of any quote calldata MUST be one
 * of these. Velora and 0x AllowanceHolder are the v0.11.71 sources.
 */
export const ALLOWED_ROUTERS_BY_CHAIN: Readonly<
  Record<number, readonly `0x${string}`[]>
> = Object.freeze({
  [BASE_CHAIN_ID]: Object.freeze<readonly `0x${string}`[]>([
    // Velora AugustusSwapper v6.2 on Base
    "0x6a000f20005980200259b80c5102003040001068",
    // 0x AllowanceHolder on Base
    "0x0000000000001ff3684f28c67538d4d072c22734",
  ]),
});

/**
 * Allowed outer selectors per chain. v0.11.71 production set:
 *   - 0x: 1 selector (`exec` only)
 *   - Velora: 11 swap selectors on AugustusSwapper v6.2
 *
 * NOTE: Velora's 11 selectors must be sync'd from the server-side at deploy
 * via drift.test.ts. The list below tracks the v0.11.71 production set;
 * update both sides via a coordinated bump.
 */
export const ALLOWED_SELECTORS_BY_CHAIN: Readonly<
  Record<number, readonly `0x${string}`[]>
> = Object.freeze({
  [BASE_CHAIN_ID]: Object.freeze<readonly `0x${string}`[]>([
    // 0x AllowanceHolder.exec(address,address,uint256,address,bytes)
    "0x2213bc0b",
    // Velora AugustusSwapper v6.2 — 11 swap selectors
    // swapExactAmountIn (the canonical 5-arg form)
    "0xe3ead59e",
    // swapExactAmountOut
    "0x5e94e28d",
    // swapOnUniswapV3
    "0x876a02f6",
    // swapOnUniswapV2
    "0x54e3f31b",
    // swapOnAugustusV5
    "0x46c67b6d",
    // swapOnAugustusV6
    "0x9ed1d4d1",
    // multiSwap
    "0xa94e78ef",
    // megaSwap
    "0xec1d21dd",
    // simpleSwap
    "0xcfc0afeb",
    // protectedMultiSwap
    "0x46cc4be3",
    // protectedMegaSwap
    "0x91a32363",
  ]),
});

/**
 * Allowed inner `target` for 0x AllowanceHolder.exec calldata. The exec
 * selector dispatches to `target.call(data)` — without this whitelist,
 * Layer 2's outer selector check is cosmetic. Per v0.11.71 audit-not-code-
 * review framing finding (the load-bearing addition).
 */
export const ALLOWED_ZEROEX_SETTLERS_BY_CHAIN: Readonly<
  Record<number, readonly `0x${string}`[]>
> = Object.freeze({
  [BASE_CHAIN_ID]: Object.freeze<readonly `0x${string}`[]>([
    // 0x Settler on Base
    "0x7747f8d2a76bd6345cc29622a946a929647f2359",
  ]),
});

const ZEROEX_EXEC_SELECTOR = "0x2213bc0b" as const;

// =============================================================================
// Public API
// =============================================================================

export interface QuoteForValidation {
  /** Outer router (the `to` field of the to-be-signed transaction). */
  router: string;
  /** Full calldata bytes (hex with 0x prefix). */
  calldata: string;
  /** Source aggregator (informational; allowlists are per-chain). */
  source?: string;
}

/**
 * Validate a quote response against Layer 2 allowlists. Throws
 * `PaladinTrustError(ROUTER_NOT_ALLOWED)` on any failure.
 *
 * Order of checks (matches server-side v0.11.71):
 *   1. Calldata length sanity (≥10 hex chars = 4-byte selector + 0x prefix)
 *   2. Outer selector ∈ deny-list → reject (unconditional)
 *   3. Chain ID supported (Base 8453 only at v0.2.0)
 *   4. Outer router ∈ ALLOWED_ROUTERS_BY_CHAIN[chainId] → reject otherwise
 *   5. Outer selector ∈ ALLOWED_SELECTORS_BY_CHAIN[chainId] → reject otherwise
 *   6. If outer selector is 0x exec (`0x2213bc0b`), decode inner `target`
 *      arg and check ∈ ALLOWED_ZEROEX_SETTLERS_BY_CHAIN[chainId]
 */
export function validateQuoteResponse(quote: QuoteForValidation, chainId: number): void {
  const calldata = quote.calldata.toLowerCase();
  if (!calldata.startsWith("0x") || calldata.length < 10) {
    throw new PaladinTrustError(
      ErrorCode.ROUTER_NOT_ALLOWED,
      `calldata too short or missing 0x prefix: ${calldata.slice(0, 20)}`,
    );
  }
  const selector = calldata.slice(0, 10) as `0x${string}`;

  // 2. Hard deny-list — unconditional, even in WARN mode.
  if (CLIENT_SIDE_DENY_LIST.includes(selector)) {
    throw new PaladinTrustError(
      ErrorCode.ROUTER_NOT_ALLOWED,
      `outer selector ${selector} is on hard deny-list (ERC20/Permit2 funds-loss vector)`,
    );
  }

  // 3. Chain support.
  const allowedRouters = ALLOWED_ROUTERS_BY_CHAIN[chainId];
  const allowedSelectors = ALLOWED_SELECTORS_BY_CHAIN[chainId];
  if (!allowedRouters || !allowedSelectors) {
    throw new PaladinTrustError(
      ErrorCode.ROUTER_NOT_ALLOWED,
      `chainId ${chainId} not supported (v0.2.0 ships Base 8453 only)`,
    );
  }

  // 4. Router whitelist.
  const routerLower = quote.router.toLowerCase() as `0x${string}`;
  if (!allowedRouters.includes(routerLower)) {
    throw new PaladinTrustError(
      ErrorCode.ROUTER_NOT_ALLOWED,
      `router ${quote.router} not in ALLOWED_ROUTERS_BY_CHAIN[${chainId}]`,
    );
  }

  // 5. Selector whitelist.
  if (!allowedSelectors.includes(selector)) {
    throw new PaladinTrustError(
      ErrorCode.ROUTER_NOT_ALLOWED,
      `outer selector ${selector} not in ALLOWED_SELECTORS_BY_CHAIN[${chainId}]`,
    );
  }

  // 6. For 0x exec, decode + validate inner Settler target.
  if (selector === ZEROEX_EXEC_SELECTOR) {
    const target = decodeZeroExExecTarget(calldata);
    const allowedSettlers = ALLOWED_ZEROEX_SETTLERS_BY_CHAIN[chainId];
    if (!allowedSettlers || !allowedSettlers.includes(target.toLowerCase() as `0x${string}`)) {
      throw new PaladinTrustError(
        ErrorCode.ROUTER_NOT_ALLOWED,
        `0x exec inner target ${target} not in ALLOWED_ZEROEX_SETTLERS_BY_CHAIN[${chainId}]`,
      );
    }
  }
}

/**
 * Decode the `target` argument from 0x AllowanceHolder.exec calldata.
 *
 * exec(address operator, address allowanceTarget, uint256 amount, address target, bytes data)
 *
 * After the 4-byte selector, args are ABI-encoded. Address args are 32-byte
 * left-padded. `target` is the 4th address arg = bytes [4 + 96, 4 + 128).
 * Hex offset: 10 + 96*2 = 202; length 64 (32 bytes); take last 40 hex chars.
 */
function decodeZeroExExecTarget(calldata: string): `0x${string}` {
  // 0x prefix + 8 selector + 64 hex per arg × 3 args before target = 200
  const targetStart = 2 + 8 + 64 * 3;
  const targetEnd = targetStart + 64;
  if (calldata.length < targetEnd) {
    throw new PaladinTrustError(
      ErrorCode.ROUTER_NOT_ALLOWED,
      `0x exec calldata too short to decode target: len=${calldata.length}`,
    );
  }
  const word = calldata.slice(targetStart, targetEnd);
  // Last 20 bytes (40 hex chars) of the 32-byte word.
  return `0x${word.slice(24)}` as `0x${string}`;
}
