/**
 * Wire-format types for PaladinFi /v1/trust-check responses.
 *
 * Mirrors the live API at https://swap.paladinfi.com. The preview endpoint
 * (POST /v1/trust-check/preview) returns a sample fixture with `_preview: true`
 * and per-factor `real: false`. The paid endpoint (POST /v1/trust-check) returns
 * the same shape with `real: true` on each factor — runs live OFAC SDN screening,
 * GoPlus token security, Etherscan source verification, and anomaly heuristics.
 */

import { isAddress, type Address } from "viem";
import type { LocalAccount } from "viem/accounts";
import { z } from "zod";

export const TRUST_FACTOR_SOURCES = [
  "ofac",
  "goplus",
  "etherscan_source",
  "anomaly",
  "lookalike",
] as const;
export type TrustFactorSource = (typeof TRUST_FACTOR_SOURCES)[number];

export const TRUST_RECOMMENDATIONS = [
  "allow",
  "warn",
  "block",
  "sample-allow",
  "sample-warn",
  "sample-block",
] as const;
export type TrustRecommendation = (typeof TRUST_RECOMMENDATIONS)[number];

export const trustFactorSchema = z.object({
  source: z.string(),
  signal: z.string(),
  details: z.string().optional(),
  // `real` is present on preview responses (always false) and absent on paid
  // responses (implicit true). Default to true so action handler logic
  // (`f.real ? "" : " (sample)"`) renders paid factors without sample tag.
  real: z.boolean().default(true),
});
export type TrustFactor = z.infer<typeof trustFactorSchema>;

export const trustBlockSchema = z.object({
  // Constrain to the closed enum so server-side typos (e.g. "alllow") don't
  // silently pass through to agent branching logic. Permissive `z.string()`
  // was a v0.0.1 footgun caught in retrospective review (2026-05-02).
  recommendation: z.enum(TRUST_RECOMMENDATIONS),
  recommendation_enum: z.array(z.string()).optional(),
  factors: z.array(trustFactorSchema),
  risk_score: z.number().nullable().optional(),
  risk_score_scale: z.string().optional(),
  version: z.string().optional(),
  _preview: z.boolean().optional(),
  _request_id: z.string().optional(),
  _message: z.string().optional(),
});
export type TrustBlock = z.infer<typeof trustBlockSchema>;

export const trustCheckResponseSchema = z.object({
  address: z.string(),
  chainId: z.number(),
  taker: z.string().nullable().optional(),
  // request_id is present on preview responses but absent on paid (verified
  // empirically against live /v1/trust-check on 2026-05-04). Made optional.
  request_id: z.string().optional(),
  trust: trustBlockSchema,
});
export type TrustCheckResponse = z.infer<typeof trustCheckResponseSchema>;

export const trustCheckRequestSchema = z.object({
  address: z.string().refine((v) => isAddress(v as Address), {
    message: "address must be a valid EIP-55 hex address",
  }),
  chainId: z.number().int().positive(),
  taker: z
    .string()
    .refine((v) => isAddress(v as Address), {
      message: "taker must be a valid EIP-55 hex address",
    })
    .optional(),
});
export type TrustCheckRequest = z.infer<typeof trustCheckRequestSchema>;

/**
 * Plugin-level config shape resolved from runtime settings or env.
 * Defaults match `agentConfig.pluginParameters` in package.json.
 *
 * `walletClientAccount` is set non-enumerably by the factory (createPaladinTrustPlugin)
 * — never via env. Paid mode requires a viem `LocalAccount` (i.e. an account with a
 * local `signTypedData`). JsonRpcAccount / SmartAccount are not supported in v0.1.0.
 */
export interface PaladinTrustConfig {
  apiBase: string;
  mode: "preview" | "paid";
  defaultChainId: number;
  walletClientAccount?: LocalAccount;
}

export const DEFAULT_CONFIG: PaladinTrustConfig = {
  apiBase: "https://swap.paladinfi.com",
  mode: "preview",
  defaultChainId: 8453,
};

// =============================================================================
// v0.2.0 NEW — settlement-state types for paid call ergonomics
// =============================================================================

/**
 * x402 payment-settlement state surfaced from `client.paidEx()`.
 *
 * Per v11 §4.3 step 9 + R7 Engineering HIGH-1 fix: the handler distinguishes
 * "x402 didn't run" (refund tracker) from "x402 ran but we don't know if it
 * settled on-chain" (debit + warn-log + reconcile within 5 min).
 *
 * - `not-attempted`: paid call returned an error before viem signed. Refund.
 *   Examples: HTTPS gate failed, network error before fetch, AbortSignal,
 *   pre-sign hook aborted (treasury mismatch).
 * - `attempted-confirmed`: paid call succeeded, server returned 200, x402 lib
 *   reports settlement complete. No refund needed; tracker stays debited.
 * - `attempted-unknown`: paid call threw mid-flow OR server returned non-2xx
 *   AFTER the X-PAYMENT header was POSTed. Cannot determine on-chain truth
 *   from the client side. Tracker debits + warn-log entry written; handler
 *   should poll x402 settlement events on Base for ~5 min to reconcile.
 * - `confirmed-failed`: server returned HTTP 402 even after the retry attempt
 *   (payment explicitly rejected). Refund.
 */
export type SettlementState =
  | "not-attempted"
  | "attempted-confirmed"
  | "attempted-unknown"
  | "confirmed-failed";

/**
 * Result envelope returned from `client.paidEx()` on success. v0.1.0
 * `client.paid()` keeps its existing `Promise<TrustCheckResponse>` return
 * type for backwards-compat; v0.2.0 paladin_swap action uses paidEx() to
 * receive the settlement metadata for refund accounting.
 */
export interface PaidExResult {
  data: TrustCheckResponse;
  settlementState: SettlementState;
  /** On-chain settlement tx hash if surfaced via response header. */
  txHash?: string;
}
