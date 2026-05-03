/**
 * Pre-sign validation for the PaladinFi 402 challenge.
 *
 * Runs inside the `onBeforePaymentCreation` hook on the x402Client, BEFORE
 * any signing happens. Receives the full hook context (paymentRequired top-level
 * + selectedRequirements which is what the library is about to sign over).
 *
 * Returning `{ ok: false, reason }` causes the hook to abort the signing call.
 *
 * Closes:
 *   - Wallet-drain (server requests a different payTo/asset)
 *   - Permit2 downgrade (server requests a different assetTransferMethod with
 *     different signing semantics + arbitrary spender)
 *   - x402 v1 downgrade (different field shape)
 *   - Long-lived-signature (server requests a 1-year validity window)
 *   - EIP-712 domain spoofing (server lies about USDC domain name/version)
 */

import {
  PALADIN_TREASURY,
  BASE_USDC,
  BASE_NETWORK,
  MAX_TRUST_CHECK_AMOUNT,
  USDC_DOMAIN_NAME,
  USDC_DOMAIN_VERSION,
  X402_VERSION,
  MAX_VALIDITY_SECONDS,
} from "./constants.js";

export interface ValidationResult {
  ok: boolean;
  reason?: string;
}

/**
 * Validates BOTH the top-level paymentRequired (x402 protocol version) AND
 * the selectedRequirements (the actual fields about to be signed).
 *
 * @param context Hook context passed by `@x402/core` to BeforePaymentCreationHook.
 *                Typed loose because the hook signature returns a wide context
 *                that includes server-controlled extra fields we want to inspect.
 */
export function validatePaladinContext(
  context: { paymentRequired?: unknown; selectedRequirements?: unknown } | undefined,
): ValidationResult {
  // 1. Protocol version — reject anything other than v2
  const wireVersion = (context?.paymentRequired as { x402Version?: unknown })?.x402Version;
  if (wireVersion !== X402_VERSION) {
    return {
      ok: false,
      reason: `x402Version=${String(wireVersion)} not allowed (expected ${X402_VERSION})`,
    };
  }

  const reqs = context?.selectedRequirements as
    | {
        scheme?: unknown;
        network?: unknown;
        asset?: unknown;
        payTo?: unknown;
        amount?: unknown;
        maxTimeoutSeconds?: unknown;
        extra?: { name?: unknown; version?: unknown; assetTransferMethod?: unknown } | undefined;
      }
    | undefined;
  if (!reqs || typeof reqs !== "object") {
    return { ok: false, reason: "no selectedRequirements" };
  }

  // 2. Asset transfer method — reject Permit2 (different signing + spender semantics)
  const method = reqs.extra?.assetTransferMethod ?? "eip3009";
  if (method !== "eip3009") {
    return {
      ok: false,
      reason: `assetTransferMethod=${String(method)} not allowed (expected eip3009)`,
    };
  }

  // 3. Scheme + network + asset + payTo — equality with hard-coded constants
  if (reqs.scheme !== "exact") {
    return { ok: false, reason: `scheme=${String(reqs.scheme)} (expected exact)` };
  }
  if (reqs.network !== BASE_NETWORK) {
    return { ok: false, reason: `network=${String(reqs.network)} (expected ${BASE_NETWORK})` };
  }
  if (typeof reqs.asset !== "string" || reqs.asset.toLowerCase() !== BASE_USDC.toLowerCase()) {
    return { ok: false, reason: `asset=${String(reqs.asset)} (expected ${BASE_USDC})` };
  }
  if (
    typeof reqs.payTo !== "string" ||
    reqs.payTo.toLowerCase() !== PALADIN_TREASURY.toLowerCase()
  ) {
    return { ok: false, reason: `payTo=${String(reqs.payTo)} (expected ${PALADIN_TREASURY})` };
  }

  // 4. Amount cap — $0.01 max
  let amount: bigint;
  try {
    amount = BigInt(reqs.amount as string | number | bigint);
  } catch {
    return { ok: false, reason: `amount=${String(reqs.amount)} (not a valid bigint)` };
  }
  if (amount > MAX_TRUST_CHECK_AMOUNT) {
    return { ok: false, reason: `amount=${amount} exceeds cap ${MAX_TRUST_CHECK_AMOUNT}` };
  }
  if (amount <= 0n) {
    return { ok: false, reason: `amount=${amount} must be positive` };
  }

  // 5. Validity window — server controls maxTimeoutSeconds (the EIP-3009 validBefore window).
  // Cap to prevent long-lived-signature vector.
  const t = Number(reqs.maxTimeoutSeconds);
  if (!Number.isFinite(t) || t <= 0 || t > MAX_VALIDITY_SECONDS) {
    return {
      ok: false,
      reason: `maxTimeoutSeconds=${String(reqs.maxTimeoutSeconds)} out of bounds (1..${MAX_VALIDITY_SECONDS}]`,
    };
  }

  // 6. EIP-712 domain integrity
  if (reqs.extra?.name !== USDC_DOMAIN_NAME) {
    return {
      ok: false,
      reason: `extra.name=${String(reqs.extra?.name)} (expected ${USDC_DOMAIN_NAME})`,
    };
  }
  if (reqs.extra?.version !== USDC_DOMAIN_VERSION) {
    return {
      ok: false,
      reason: `extra.version=${String(reqs.extra?.version)} (expected ${USDC_DOMAIN_VERSION})`,
    };
  }

  return { ok: true };
}
