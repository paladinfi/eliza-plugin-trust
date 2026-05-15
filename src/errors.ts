/**
 * Error contract for `@paladinfi/eliza-plugin-trust`.
 *
 * v0.1.0: error scrubbing for paid-mode (`scrubViemError` retained, unchanged).
 *
 * v0.2.0: closed-enum `ErrorCode` (27 codes) for `paladin_swap` action +
 * `PaladinTrustError` class. Codes map 1:1 to documented failure modes
 * surfaced via `ActionResult` so customer agents can branch deterministically.
 *
 * Adding a new code requires: bumping the enum + a row in README §8 error
 * reference + a row in `paladin-swap.test.ts`. The drift CI grep enforces this.
 */

// =============================================================================
// v0.1.0 utility (UNCHANGED — preserves existing API for trust-check action)
// =============================================================================

/**
 * viem errors carry rich context — `.cause`, `.details`, `.metaMessages`,
 * full request init — that we never want surfaced to users or logged. A raw
 * `String(error)` after a failed sign can leak headers, body bytes, or worse.
 *
 * Returns a bounded, single-string summary safe to surface.
 */
export function scrubViemError(e: unknown): string {
  if (e instanceof Error) {
    const short = (e as { shortMessage?: unknown }).shortMessage;
    if (typeof short === "string" && short.length > 0) {
      return short.slice(0, 200);
    }
    const msg = e.message ?? "";
    return msg.length > 0 ? msg.slice(0, 200) : "redacted error";
  }
  return String(e).slice(0, 200);
}

// =============================================================================
// v0.2.0 NEW — closed-enum error contract for paladin_swap
// =============================================================================

/**
 * Closed-enum error contract — every `paladin_swap` failure path returns
 * exactly one of these codes. Values are stable strings; customer agents
 * branch on them deterministically. Adding a new code is a MINOR version
 * bump and requires a README §8 reference-table row + a unit test.
 *
 * Step references map to the 16-step handler in `actions/paladin-swap.ts`.
 */
export const ErrorCode = {
  // --- Construction-time (factory) -----------------------------------------
  /** Factory: paladinSwapEnabled=true but no walletClientAccount provided. */
  WALLET_MISSING: "WALLET_MISSING",
  /** Factory: paladinSwapEnabled=true requires acknowledgeRisks=true. */
  RESIDUAL_NOT_ACKNOWLEDGED: "RESIDUAL_NOT_ACKNOWLEDGED",
  /** Factory or steps 1/3: Zod schema validation failed; required option missing. */
  INVALID_INPUT: "INVALID_INPUT",

  // --- Step 2 (LLM extraction) ---------------------------------------------
  /** LLM extraction returned empty result or threw. */
  EXTRACTION_FAILED: "EXTRACTION_FAILED",

  // --- Step 4 (taker validation) -------------------------------------------
  /** Extracted taker address does not match wallet.address. */
  INVALID_TAKER: "INVALID_TAKER",

  // --- Step 5 (token registry) ---------------------------------------------
  /** sellToken is not present in TOKEN_REGISTRY (closed-set check). */
  TOKEN_NOT_SUPPORTED: "TOKEN_NOT_SUPPORTED",

  // --- Step 6 (sell-amount cap) --------------------------------------------
  /** sellAmount exceeds the per-token cap from TOKEN_REGISTRY or override. */
  SELL_AMOUNT_EXCEEDS_CAP: "SELL_AMOUNT_EXCEEDS_CAP",

  // --- Step 7 (rate limiter) -----------------------------------------------
  /** token-bucket rate limiter exhausted for the active window. */
  RATE_LIMITED: "RATE_LIMITED",

  // --- Step 8 (spending caps) ----------------------------------------------
  /** Spending tracker: hourly USDC cap exceeded. */
  HOURLY_CAP_EXCEEDED: "HOURLY_CAP_EXCEEDED",
  /** Spending tracker: daily USDC cap exceeded. */
  DAILY_CAP_EXCEEDED: "DAILY_CAP_EXCEEDED",

  // --- Step 9 (paid trust check) -------------------------------------------
  /** Paid `/v1/trust-check` call threw at the network or middleware layer. */
  TRUST_CHECK_FAILED: "TRUST_CHECK_FAILED",

  // --- Step 10 (trust branch) ----------------------------------------------
  /** trust-check returned recommendation=block AND effective mode=block. */
  TRUST_BLOCKED: "TRUST_BLOCKED",

  // --- Step 11 (quote fetch) -----------------------------------------------
  /** `/v1/quote` failed at network/middleware layer. */
  QUOTE_FAILED: "QUOTE_FAILED",
  /** `/v1/quote` returned 404 / no liquidity for the requested pair. */
  UPSTREAM_LIQUIDITY_NONE: "UPSTREAM_LIQUIDITY_NONE",

  // --- Step 12 (client-side router/selector validation) --------------------
  /** Layer 2: router/selector/Settler-target check or deny-list match failed. */
  ROUTER_NOT_ALLOWED: "ROUTER_NOT_ALLOWED",

  // --- Step 14 (server-side simulation) ------------------------------------
  /** Layer 4: `/v1/simulate` network failure, timeout, or 5xx. */
  SIMULATION_FAILED: "SIMULATION_FAILED",

  // --- Step 15 (on-chain trust state) --------------------------------------
  /** Base RPC unreachable AND on-disk cache exhausted (>2h grace + sticky-revoked). */
  PALADIN_REGISTRY_UNREACHABLE: "PALADIN_REGISTRY_UNREACHABLE",
  /** Multi-RPC quorum: <2 RPCs agreed on highest-epoch's pair + tokenRegistryHash. */
  PALADIN_REGISTRY_QUORUM_FAILED: "PALADIN_REGISTRY_QUORUM_FAILED",

  // --- Step 16 (Layer 3 cryptographic verification) ------------------------
  /** One or more 2-of-2 KMS signatures fail to recover to current trusted pair. */
  RESPONSE_SIG_INVALID: "RESPONSE_SIG_INVALID",
  /** Signed response outside freshness window (default 600s + 120s clock-skew). */
  RESPONSE_STALE: "RESPONSE_STALE",
  /** apiVersion not in acceptVersions, or version downgrade detected. */
  RESPONSE_VERSION_UNSUPPORTED: "RESPONSE_VERSION_UNSUPPORTED",
  /** requestHash or clientNonce in signed payload doesn't match local computation. */
  RESPONSE_BINDING_MISMATCH: "RESPONSE_BINDING_MISMATCH",
  /** Signed response's epoch ≠ on-chain currentEpoch (and not pinned mode). */
  RESPONSE_EPOCH_MISMATCH: "RESPONSE_EPOCH_MISMATCH",
  /** On-chain `revoked[epoch]=true` for the response's signing epoch. */
  RESPONSE_EPOCH_REVOKED: "RESPONSE_EPOCH_REVOKED",
  /** Bundled TOKEN_REGISTRY_HASH ≠ on-chain tokenRegistryHash (or server-observed). */
  TOKEN_REGISTRY_DRIFT: "TOKEN_REGISTRY_DRIFT",

  // --- Step 17 (final branch) ----------------------------------------------
  /** simulator returned ok=false (state-diff or revert detected server-side). */
  SIMULATION_REJECTED: "SIMULATION_REJECTED",

  // --- Steps 9 / 11 / 14 (x402 settlement) ---------------------------------
  /** x402 settlement state unknowable (e.g., timeout after middleware accept).
   * Tracker debited; warn-log written. Customer reconciles via on-chain check
   * within 5 min, after which the entry resolves to confirmed-settled or refund. */
  SETTLEMENT_UNKNOWN: "SETTLEMENT_UNKNOWN",
} as const;

export type ErrorCode = typeof ErrorCode[keyof typeof ErrorCode];

/**
 * Closed list of all error codes — used by drift CI test to assert README §8
 * reference table and `errors.ts` enum stay in sync.
 */
export const ALL_ERROR_CODES: readonly ErrorCode[] = Object.values(ErrorCode);

/**
 * Error class for all `paladin_swap` failures. Carries a closed-enum `code`
 * for deterministic branching plus a human-readable `message`. Optional
 * `cause` preserves the underlying error for debug-bundle output (subject
 * to redaction policy in `debug-bundle.ts`).
 */
export class PaladinTrustError extends Error {
  public readonly code: ErrorCode;
  public override readonly cause?: unknown;

  constructor(code: ErrorCode, message: string, cause?: unknown) {
    super(message);
    this.name = "PaladinTrustError";
    this.code = code;
    if (cause !== undefined) {
      this.cause = cause;
    }
    // Preserve stack on Node 18+ V8.
    if (typeof Error.captureStackTrace === "function") {
      Error.captureStackTrace(this, PaladinTrustError);
    }
  }
}

/**
 * Type guard: narrow unknown → PaladinTrustError. Useful at action boundaries
 * where the surrounding framework hands us `unknown` from a catch block.
 */
export function isPaladinTrustError(e: unknown): e is PaladinTrustError {
  return e instanceof PaladinTrustError;
}
