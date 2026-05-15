/**
 * TOKEN_REGISTRY — single source of truth for supported tokens.
 *
 * Mirrored server-side in paladin_simulator_token_registry.py; both sides
 * MUST agree byte-for-byte. Pre-publish CI test (drift.test.ts) fetches
 * the live server registry and asserts byte-equality with the bundled value.
 *
 * On-chain binding: PaladinKeyRegistry.tokenRegistryHash() exposes the
 * canonical hash. Plugin asserts TOKEN_REGISTRY_HASH ===
 * server-observed value on every signed /v1/simulate response (per-call
 * granularity, not just cache-cycle). Drift = TOKEN_REGISTRY_DRIFT,
 * which is in the retryable set (one cache-refresh retry; second failure
 * propagates).
 *
 * Storage slots (balanceSlot, allowanceSlot) are verified pre-deploy via
 * `scripts/verify_storage_slots.py` against live Base state. Service
 * refuses to start if any slot returns a wrong value when probed.
 * USDC slots verified via spike 2026-05-04; others tagged PLACEHOLDER.
 */

import { keccak256, toHex } from "viem";

export interface TokenRegistryEntry {
  /** Checksummed Base address. */
  address: `0x${string}`;
  symbol: string;
  decimals: number;
  /**
   * Default sellAmount cap in base units (string to avoid JS Number
   * precision loss for 18-decimal tokens). Customer factory option
   * `maxSellAmountByTokenAddress` overrides.
   */
  defaultCap: string;
  /** ERC20 storage slot for `mapping(address => uint256) balances`. */
  balanceSlot: number;
  /** ERC20 storage slot for `mapping(address => mapping(address => uint256)) allowances`. */
  allowanceSlot: number;
  /** Whether this token is accepted as a sellToken in /v1/quote. */
  isPaymentToken: boolean;
  /** Free-form notes (verification status, proxy lineage, etc.). */
  notes?: string;
}

/**
 * Token registry. Keys are LOWERCASED addresses; entry.address is the
 * checksummed canonical form. Lookup via `getTokenEntry(address)` — it
 * lowercases for you.
 */
export const TOKEN_REGISTRY: Readonly<Record<string, TokenRegistryEntry>> = Object.freeze({
  "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913": {
    address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    symbol: "USDC",
    decimals: 6,
    defaultCap: "100000000", // 100 USDC
    balanceSlot: 9,
    allowanceSlot: 10,
    isPaymentToken: true,
    notes: "FiatTokenV2_2; verified via spike 2026-05-04",
  },
  "0xfde4c96c8593536e31f229ea8f37b2ada2699bb2": {
    address: "0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2",
    symbol: "USDT",
    decimals: 6,
    defaultCap: "100000000",
    balanceSlot: 0,
    allowanceSlot: 1,
    isPaymentToken: true,
    notes: "Base USDT (Tether bridged). Slots verified 2026-05-11 via scripts/discover_storage_slot.py against live Base; whale 0x1111111254EEB25477B68fb85Ed929f73A960582.",
  },
  "0x4200000000000000000000000000000000000006": {
    address: "0x4200000000000000000000000000000000000006",
    symbol: "WETH",
    decimals: 18,
    defaultCap: "30000000000000000", // 0.03 WETH ≈ $100
    balanceSlot: 3,
    allowanceSlot: 4,
    isPaymentToken: true,
    notes: "Base WETH9 standard. Slots verified 2026-05-11 via scripts/discover_storage_slot.py against live Base; whale 0xF977814e90dA44bFA03b6295A0616a897441aceC.",
  },
  "0xcbb7c0000ab88b473b1f5afd9ef808440eed33bf": {
    address: "0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf",
    symbol: "cbBTC",
    decimals: 8,
    defaultCap: "150000",
    balanceSlot: 9,
    allowanceSlot: 10,
    isPaymentToken: true,
    notes: "Coinbase Wrapped BTC. Slots verified 2026-05-11 via scripts/discover_storage_slot.py against live Base; whale 0xF977814e90dA44bFA03b6295A0616a897441aceC.",
  },
  "0x50c5725949a6f0c72e6c4a641f24049a917db0cb": {
    address: "0x50c5725949A6F0c72E6C4a641F24049A917DB0Cb",
    symbol: "DAI",
    decimals: 18,
    defaultCap: "100000000000000000000",
    balanceSlot: 0,
    allowanceSlot: 1,
    isPaymentToken: true,
    notes: "Base DAI. Slots verified 2026-05-11 via scripts/discover_storage_slot.py against live Base; whale 0x1111111254EEB25477B68fb85Ed929f73A960582.",
  },
  "0x940181a94a35a4569e4529a3cdfb74e38fd98631": {
    address: "0x940181a94A35A4569E4529A3CDfB74e38FD98631",
    symbol: "AERO",
    decimals: 18,
    defaultCap: "100000000000000000000",
    balanceSlot: 0,
    allowanceSlot: 1,
    isPaymentToken: true,
    notes: "Aerodrome AERO. Slots verified 2026-05-11 via scripts/discover_storage_slot.py against live Base; whale 0xF977814e90dA44bFA03b6295A0616a897441aceC.",
  },
  "0xd9aaec86b65d86f6a7b5b1b0c42ffa531710b6ca": {
    address: "0xd9aAEc86B65D86f6A7B5B1b0c42FFA531710b6CA",
    symbol: "USDbC",
    decimals: 6,
    defaultCap: "100000000",
    balanceSlot: 51,
    allowanceSlot: 52,
    isPaymentToken: true,
    notes: "USD Base Coin (proxy). Slots verified 2026-05-11 via scripts/discover_storage_slot.py against live Base — proxy has non-trivial layout (slot 51, NOT slot 9 like USDC); whale 0xF977814e90dA44bFA03b6295A0616a897441aceC.",
  },
});

/**
 * Canonical hash of TOKEN_REGISTRY. Computed at module load time over a
 * stable string serialization (lexicographic-key order, pipe-delimited).
 * Server's PaladinKeyRegistry.tokenRegistryHash() must match this value
 * post-deploy. Per-response binding via signed-payload's
 * `serverObservedTokenRegistryHash` field.
 *
 * Adding/removing/modifying a token entry changes this hash, which
 * MUST be coordinated with a server-side `proposeTokenRegistryHashChange`
 * → 7-day timelock → `finalizeTokenRegistryHashChange`. See v11 §4.6 +
 * §4.10.6 for the on-chain timelock contract.
 */
export const TOKEN_REGISTRY_HASH: `0x${string}` = computeRegistryHash(TOKEN_REGISTRY);

function computeRegistryHash(
  registry: Readonly<Record<string, TokenRegistryEntry>>,
): `0x${string}` {
  const sortedKeys = Object.keys(registry).sort();
  // Stable string form. Order is fixed; do NOT use JSON.stringify (object key
  // ordering is implementation-specific in older runtimes).
  const canonical = sortedKeys
    .map((key) => {
      const entry = registry[key];
      return [
        entry.address.toLowerCase(),
        entry.symbol,
        String(entry.decimals),
        entry.defaultCap,
        String(entry.balanceSlot),
        String(entry.allowanceSlot),
        entry.isPaymentToken ? "1" : "0",
      ].join("|");
    })
    .join("\n");
  return keccak256(toHex(canonical));
}

/** All registered token addresses, lowercased. */
export const TOKEN_REGISTRY_ADDRESSES: readonly string[] = Object.freeze(
  Object.keys(TOKEN_REGISTRY),
);

/** Lookup by address. Lowercases input. Returns undefined if not registered. */
export function getTokenEntry(address: string): TokenRegistryEntry | undefined {
  return TOKEN_REGISTRY[address.toLowerCase()];
}

/** Closed-set membership check. Used at handler step 5. */
export function isTokenSupported(address: string): boolean {
  return address.toLowerCase() in TOKEN_REGISTRY;
}

/**
 * Effective sell-amount cap for a token. Customer override (per factory
 * option `maxSellAmountByTokenAddress`) wins over the registry's
 * defaultCap. Returns undefined if token is not in the registry.
 *
 * Override map is expected to use lowercased addresses; this helper
 * lowercases the lookup key for safety.
 */
export function getTokenCap(
  address: string,
  override?: Record<string, string>,
): string | undefined {
  const lower = address.toLowerCase();
  if (override && lower in override) {
    return override[lower];
  }
  return TOKEN_REGISTRY[lower]?.defaultCap;
}

/**
 * Default per-token caps as a plain `Record<address, capString>`. Used by
 * profiles.ts (`default` profile uses these as-is; `paper-test` and `pro`
 * scale them).
 */
export const TOKEN_REGISTRY_DEFAULT_CAPS: Readonly<Record<string, string>> = Object.freeze(
  Object.fromEntries(
    Object.entries(TOKEN_REGISTRY).map(([addr, entry]) => [addr, entry.defaultCap]),
  ),
);
