/**
 * x402 protocol constants for PaladinFi trust-check.
 *
 * These are the fields that, byte-for-byte, the agent's wallet will sign over
 * via EIP-3009 transferWithAuthorization. They are hard-coded so a malicious
 * or compromised PaladinFi server cannot redirect the signed authorization to
 * a different recipient, asset, or chain.
 *
 * Validated inside the `onBeforePaymentCreation` hook in client.ts (pre-sign,
 * defense-in-depth alongside boot-time validation in index.ts).
 */

export const PALADIN_TREASURY = "0xeA8C33d018760D034384e92D1B2a7cf0338834b4" as const;
export const BASE_USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" as const;
export const BASE_NETWORK = "eip155:8453" as const;

/** $0.01 cap, 10x expected $0.001 trust-check unit price. Pure equality with this would also work; using a cap permits future small price adjustments without a plugin upgrade. */
export const MAX_TRUST_CHECK_AMOUNT = 10_000n;

/** x402 protocol version we accept. v1 has different field shape; v3+ unbounded. */
export const X402_VERSION = 2 as const;

/** EIP-712 domain integrity check — Base USDC's `name` and `version` strings. */
export const USDC_DOMAIN_NAME = "USD Coin" as const;
export const USDC_DOMAIN_VERSION = "2" as const;

/**
 * Cap on the EIP-3009 `validBefore` window the server can request.
 * 10 min is well above PaladinFi's 5-min default; rejects long-lived-signature
 * vectors where a hostile server requests a 1-year valid sig.
 */
export const MAX_VALIDITY_SECONDS = 600;

export const PALADIN_API_DEFAULT = "https://swap.paladinfi.com" as const;
