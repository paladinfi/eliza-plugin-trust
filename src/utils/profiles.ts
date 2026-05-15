/**
 * Spending profiles for paladin_swap.
 *
 * Three profiles per v11 §4.7:
 *   - paper-test: ~$1 per swap, $0.10/day cap — for development & small CI
 *   - default:    ~$100 per swap, $5/day cap — recommended for most customers
 *   - pro:        ~$1000 per swap, $25/day cap — treasury/professional tier
 *
 * Each profile bundles: per-token sellAmount caps, rate-limit window/quota,
 * hourly + daily USDC caps, and the default `keyTrustMode` (auto-rotate vs
 * pinned). Customers can override any single knob via factory options
 * without picking a different profile.
 *
 * Customer factory option `paladinSwapProfile` selects one of these.
 * The active profile's defaults are used unless explicitly overridden.
 */

import type { RateLimiterOptions } from "./rate-limiter";
import {
  TOKEN_REGISTRY_DEFAULT_CAPS,
  TOKEN_REGISTRY,
} from "./sell-caps";

export type ProfileName = "paper-test" | "default" | "pro";

export type KeyTrustMode = "auto-rotate" | "pinned";

export interface SpendingProfile {
  /** Per-token sellAmount caps (base-units, lowercased addresses). */
  sellAmountCaps: Readonly<Record<string, string>>;
  /** Rate-limit window/quota for the per-instance limiter. */
  rateLimit: RateLimiterOptions;
  /** Hourly USDC cap (across paid trust + simulate calls). */
  maxHourlyUsdc: number;
  /** Daily USDC cap. */
  maxDailyUsdc: number;
  /** Default `keyTrustMode` for this profile (customer can override). */
  keyTrustMode: KeyTrustMode;
}

/**
 * Multiply every per-token cap by `factor`. Used to derive paper-test (×0.01)
 * and pro (×10) caps from the `default` profile's TOKEN_REGISTRY_DEFAULT_CAPS.
 *
 * Math is done in BigInt to preserve precision for 18-decimal tokens. Factor
 * may be fractional (e.g., 0.01); we scale by multiplying numerator and dividing
 * denominator with rounding to avoid float artifacts on large numbers.
 */
export function scaleCaps(factor: number): Record<string, string> {
  if (factor <= 0 || !Number.isFinite(factor)) {
    throw new Error("scaleCaps: factor must be a positive finite number");
  }
  // Convert factor to a numerator/denominator pair to do BigInt math.
  // Rationalize to 6 decimal places of precision (sufficient for 0.01-100×).
  const PRECISION = 1_000_000n;
  const numerator = BigInt(Math.round(factor * Number(PRECISION)));
  const result: Record<string, string> = {};
  for (const [addr, cap] of Object.entries(TOKEN_REGISTRY_DEFAULT_CAPS)) {
    const capBig = BigInt(cap);
    const scaled = (capBig * numerator) / PRECISION;
    result[addr] = scaled.toString();
  }
  return result;
}

export const SPENDING_PROFILES: Readonly<Record<ProfileName, SpendingProfile>> = Object.freeze({
  "paper-test": {
    sellAmountCaps: Object.freeze(scaleCaps(0.01)),
    rateLimit: { maxCalls: 1, windowMs: 60_000 },
    maxHourlyUsdc: 0.01,
    maxDailyUsdc: 0.10,
    keyTrustMode: "auto-rotate",
  },
  default: {
    sellAmountCaps: TOKEN_REGISTRY_DEFAULT_CAPS,
    rateLimit: { maxCalls: 3, windowMs: 10_000 },
    maxHourlyUsdc: 1.0,
    maxDailyUsdc: 5.0,
    keyTrustMode: "auto-rotate",
  },
  pro: {
    sellAmountCaps: Object.freeze(scaleCaps(10)),
    rateLimit: { maxCalls: 10, windowMs: 10_000 },
    maxHourlyUsdc: 5.0,
    maxDailyUsdc: 25.0,
    keyTrustMode: "pinned",
  },
});

/** Resolve a profile by name. Throws on unknown name (caller's bug). */
export function getProfile(name: ProfileName): SpendingProfile {
  const profile = SPENDING_PROFILES[name];
  if (!profile) {
    // Should be unreachable under TypeScript's discriminated check, but
    // guard anyway for runtime safety against bad customer input.
    throw new Error(`Unknown spending profile: ${String(name)}`);
  }
  return profile;
}

/** All profile names — used for Zod enum validation in factory options. */
export const PROFILE_NAMES: readonly ProfileName[] = Object.freeze(
  Object.keys(SPENDING_PROFILES),
) as readonly ProfileName[];

// Sanity check at module load: every profile has a cap entry for every
// registered token. Catches drift between TOKEN_REGISTRY and the scaled
// profiles. (Throws at import time, fail-fast.)
for (const [name, profile] of Object.entries(SPENDING_PROFILES)) {
  for (const addr of Object.keys(TOKEN_REGISTRY)) {
    if (!(addr in profile.sellAmountCaps)) {
      throw new Error(
        `Profile "${name}" missing sellAmountCap for ${addr} — TOKEN_REGISTRY/profiles drift`,
      );
    }
  }
}
