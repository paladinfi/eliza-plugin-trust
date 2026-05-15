/**
 * Layer 3 cryptographic verification of /v1/simulate signed responses.
 *
 * Per v11 §4.10.5 + R10/R11/R12/R13 fixes:
 *   1. Version check + downgrade prevention (numeric compareVersion)
 *   2. TOKEN_REGISTRY hash binding via signed-payload's
 *      `serverObservedTokenRegistryHash` field (per-call, not per-cache)
 *   3. Sanity: server-observed hash matches cached on-chain hash
 *   4. Epoch check + epochRevoked check (sticky on-chain state)
 *   5. Request binding: requestHash + clientNonce match local computation
 *   6. Freshness: serverTimestamp within ±freshnessWindowSec (default 600s)
 *      with -120s clock-skew tolerance
 *   7. Signatures: 2-of-2 ECDSA over secp256k1, low-s normalized
 *
 * The handler (paladin-swap.ts) wraps verifyAndExtract with retry-once-on-
 * cache-refresh for the four `RETRYABLE_VERIFICATION_ERRORS` (per v11 §4.3
 * step 16 + R12 Sec HIGH-3 TOKEN_REGISTRY_DRIFT extension). This file
 * exposes the retryable set for that wrapper.
 */

import { recoverAddress, keccak256, toHex, concat, type Hex } from "viem";
import { canonicalize } from "./paladin-canonical";
import { TOKEN_REGISTRY_HASH } from "./sell-caps";
import type { CachedTrustState } from "./paladin-keys";
import { PaladinTrustError, ErrorCode } from "../errors";
import type { Clock } from "./clock";
import { DOMAIN_SEPARATOR_SIMULATE } from "../shared/domain-separators";

// =============================================================================
// Constants
// =============================================================================

/** secp256k1 curve order — for low-s normalization (EIP-2). */
const SECP256K1_N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
const SECP256K1_HALF_N = SECP256K1_N / 2n;

/** Default freshness window. Customer can override via factory. */
export const DEFAULT_FRESHNESS_WINDOW_SEC = 600;

/** Default supported response API versions. v2 (2026-05-15) replaces v1
 * after the Security-audit C-1 hardening to a typed-domain digest. v1 is
 * NOT accepted by default — a v1 envelope reaching a v2 plugin would have
 * been signed under the weaker pre-hardening digest formula, which is no
 * longer trustable for the cross-service separation property. Customers
 * pinning v1 must explicitly opt in via `acceptVersions: ["paladin-simulate-v1"]`
 * (NOT recommended; provided only for transitional debugging).
 */
export const DEFAULT_ACCEPT_VERSIONS: readonly string[] = Object.freeze(["paladin-simulate-v2"]);

/** Clock-skew tolerance for "future" server timestamps (clients with slightly fast clocks). */
const FUTURE_SKEW_TOLERANCE_SEC = 120;

// =============================================================================
// Types — wire format matches server's paladin_simulator_service.py:570-595
// =============================================================================

/**
 * Result block returned by /v1/simulate when `ok=true`. Field names match
 * server's `_run_simulation` output verbatim.
 *
 * R16 fix: prior to v0.2.0-rc1 this type expected `deltas: Record<string,string>`
 * + `forkAge` — but server actually emits sender-balance-before/after pairs.
 * Server-side companion fix adds `deltas` + `forkAge` to result. Both fields
 * coexist with the existing balance pairs for ops debugging.
 */
export interface SimulateResultBlock {
  /** Sender's balance of buyToken before swap (string base units). */
  senderBalanceBeforeToken: string;
  /** Sender's balance of buyToken after swap. */
  senderBalanceAfterToken: string;
  /** Expected balance change from quote (= buyAmount). */
  expectedBalanceChange: string;
  /** Sender's native ETH balance before swap. */
  ethBalanceBefore: string;
  /** Sender's native ETH balance after swap. */
  ethBalanceAfter: string;
  /** Gas used by the simulated tx. */
  gasUsed: number;
  /**
   * Token-address (lowercase) → signed balance delta (positive = received,
   * negative = spent). Used by Layer 5 state-diff invariant validator.
   * Includes the sell token (negative), buy token (positive), and any other
   * tokens captured by the simulator's third-token-drain check.
   */
  deltas: Record<string, string>;
  /** Native ETH delta (signed, base units). */
  ethDelta: string;
  /** Anvil fork height age in blocks. */
  forkAge: number;
}

/**
 * Wire-format flat response from POST /v1/simulate. Field names match
 * server's response_body dict (paladin_simulator_service.py:570-595)
 * exactly. The signatures are top-level fields awsSignature + gcpSignature
 * (NOT a nested `signatures` object).
 *
 * R16 HIGH-B fix history: pre-v0.2.0-rc2 the plugin's verifier expected a
 * nested envelope `{ apiVersion, payload: {...}, signatures: {aws, gcp} }`
 * while the server emitted the flat shape below. The reshape converged
 * both sides on this flat layout.
 */
export interface SignedSimulateResponse {
  apiVersion: string;
  epoch: number;
  /**
   * v2 (2026-05-15, Security audit H-1): chainId is bound into the signed
   * envelope as a top-level field. Pre-v2 it was only transitively bound
   * via requestHash; v2 makes it an explicit invariant the verifier checks.
   */
  chainId: number;
  requestHash: Hex;
  clientNonce: Hex;
  /** Unix seconds when the response was signed (was `serverTimestamp` pre-R16). */
  signedAt: number;
  serverObservedTokenRegistryHash: Hex;
  ok: boolean;
  /** Present when ok=true. */
  result?: SimulateResultBlock;
  /** Present when ok=false. */
  error?: string;
  /** AWS Key #1 compact signature (r || s || v), 65 bytes hex. */
  awsSignature: Hex;
  /** GCP Key #2 compact signature (r || s || v), 65 bytes hex. */
  gcpSignature: Hex;
}

/**
 * What `verifyAndExtract` returns to the handler on success: the result
 * block (or error string) plus a few echo fields the handler uses.
 */
export interface SimulateVerifiedExtract {
  ok: boolean;
  /** Set when ok=true. */
  result?: SimulateResultBlock;
  /** Set when ok=false. Server's reason string. */
  error?: string;
  /** Echoed for handler/log convenience. */
  apiVersion: string;
  epoch: number;
  signedAt: number;
}

/** @deprecated Pre-R16 nested shape. Retained briefly for migration; no longer emitted by server. */
export type SimulateResponseBody = SimulateVerifiedExtract;

export interface VerifyOpts {
  signed: SignedSimulateResponse;
  trustState: CachedTrustState;
  expectedRequestHash: Hex;
  expectedClientNonce: Hex;
  /**
   * v2 (2026-05-15, Security audit H-1): the chainId the caller INTENDED
   * the request to target. Verifier asserts signed.chainId === this.
   * Defense-in-depth alongside the transitive binding via requestHash.
   */
  expectedChainId: number;
  freshnessWindowSec?: number;
  acceptVersions?: readonly string[];
  /** Mutable ref so handler can track highest version seen across calls. */
  highestVersionEverSeen: { value: string };
  clock: Clock;
}

// =============================================================================
// Retryable error set
// =============================================================================

/**
 * Errors that the handler MAY retry once after force-refreshing trust state.
 * Rationale: rotation finalize between cache fetch + server response can
 * present as any of these four; one cache-refresh + retry resolves the race.
 *
 * Per v11 §4.3 step 16 + R12 Sec HIGH-3 (TOKEN_REGISTRY_DRIFT added).
 */
export const RETRYABLE_VERIFICATION_ERRORS: ReadonlySet<ErrorCode> = new Set<ErrorCode>([
  ErrorCode.RESPONSE_SIG_INVALID,
  ErrorCode.RESPONSE_EPOCH_MISMATCH,
  ErrorCode.RESPONSE_EPOCH_REVOKED,
  ErrorCode.TOKEN_REGISTRY_DRIFT,
]);

export function isRetryableVerificationError(code: ErrorCode): boolean {
  return RETRYABLE_VERIFICATION_ERRORS.has(code);
}

// =============================================================================
// Public API
// =============================================================================

/**
 * Strip the two signature fields from a signed response. The remaining flat
 * dict is what the server canonicalized BEFORE signing, so it's what the
 * verifier must canonicalize for digest reconstruction. Mirrors the server-
 * side flow in paladin_simulator_service.py:592-595.
 */
function extractSigningInput(
  signed: SignedSimulateResponse,
): Omit<SignedSimulateResponse, "awsSignature" | "gcpSignature"> {
  const { awsSignature, gcpSignature, ...rest } = signed;
  void awsSignature;
  void gcpSignature;
  return rest;
}

/**
 * Verify a signed /v1/simulate response and extract the result block.
 * Throws PaladinTrustError with one of the seven verification ErrorCodes
 * on any failure. Caller (handler) decides whether to retry (see
 * RETRYABLE_VERIFICATION_ERRORS).
 *
 * R16 HIGH-B/C fix: reads the FLAT server shape; computes digest as
 * keccak256(DOMAIN_SEPARATOR_SIMULATE || canonical(signing_input)) where
 * signing_input is the response with awsSignature + gcpSignature stripped.
 * Mirrors server's paladin_simulator_signer.compute_payload_digest +
 * paladin_simulator_service.py response builder exactly.
 */
export async function verifyAndExtract(opts: VerifyOpts): Promise<SimulateVerifiedExtract> {
  const {
    signed,
    trustState,
    expectedRequestHash,
    expectedClientNonce,
    expectedChainId,
    freshnessWindowSec = DEFAULT_FRESHNESS_WINDOW_SEC,
    acceptVersions = DEFAULT_ACCEPT_VERSIONS,
    highestVersionEverSeen,
    clock,
  } = opts;

  // 1. Version check
  if (!acceptVersions.includes(signed.apiVersion)) {
    throw new PaladinTrustError(
      ErrorCode.RESPONSE_VERSION_UNSUPPORTED,
      `apiVersion ${signed.apiVersion} not in acceptVersions [${acceptVersions.join(", ")}]`,
    );
  }
  // Downgrade prevention — track highest version ever seen across calls.
  if (compareVersion(signed.apiVersion, highestVersionEverSeen.value) < 0) {
    throw new PaladinTrustError(
      ErrorCode.RESPONSE_VERSION_UNSUPPORTED,
      `version downgrade detected: response=${signed.apiVersion} < highest-ever-seen=${highestVersionEverSeen.value}`,
    );
  }

  // 2. TOKEN_REGISTRY hash binding (per-response, R11 Eng MED-1)
  if (TOKEN_REGISTRY_HASH.toLowerCase() !== signed.serverObservedTokenRegistryHash.toLowerCase()) {
    throw new PaladinTrustError(
      ErrorCode.TOKEN_REGISTRY_DRIFT,
      `bundled TOKEN_REGISTRY_HASH (${TOKEN_REGISTRY_HASH}) ≠ ` +
        `server-observed (${signed.serverObservedTokenRegistryHash})`,
    );
  }
  // Sanity: server-observed must also match what we read on-chain (catches forks)
  if (
    signed.serverObservedTokenRegistryHash.toLowerCase() !==
    trustState.tokenRegistryHash.toLowerCase()
  ) {
    throw new PaladinTrustError(
      ErrorCode.TOKEN_REGISTRY_DRIFT,
      `server-observed hash (${signed.serverObservedTokenRegistryHash}) ≠ ` +
        `cached on-chain (${trustState.tokenRegistryHash})`,
    );
  }

  // 3. Epoch checks
  if (signed.epoch !== trustState.epoch) {
    throw new PaladinTrustError(
      ErrorCode.RESPONSE_EPOCH_MISMATCH,
      `response epoch ${signed.epoch} ≠ on-chain currentEpoch ${trustState.epoch}`,
    );
  }
  if (trustState.epochRevoked) {
    throw new PaladinTrustError(
      ErrorCode.RESPONSE_EPOCH_REVOKED,
      `epoch ${trustState.epoch} has been revoked on-chain`,
    );
  }

  // 4. Request binding (closes R8 Sec CRITICAL-1 replay attack).
  // v2 (2026-05-15, Security audit H-1): explicit chainId check too.
  if (signed.chainId !== expectedChainId) {
    throw new PaladinTrustError(
      ErrorCode.RESPONSE_BINDING_MISMATCH,
      `chainId mismatch: response=${signed.chainId}, expected=${expectedChainId} ` +
        `(defense-in-depth check; transitively bound via requestHash but verified explicitly v2+)`,
    );
  }
  if (signed.requestHash.toLowerCase() !== expectedRequestHash.toLowerCase()) {
    throw new PaladinTrustError(
      ErrorCode.RESPONSE_BINDING_MISMATCH,
      `requestHash mismatch: response=${signed.requestHash}, expected=${expectedRequestHash}`,
    );
  }
  if (signed.clientNonce.toLowerCase() !== expectedClientNonce.toLowerCase()) {
    throw new PaladinTrustError(
      ErrorCode.RESPONSE_BINDING_MISMATCH,
      `clientNonce mismatch`,
    );
  }

  // 5. Freshness
  const ageSec = Math.floor(clock.now() / 1000) - signed.signedAt;
  if (ageSec > freshnessWindowSec || ageSec < -FUTURE_SKEW_TOLERANCE_SEC) {
    throw new PaladinTrustError(
      ErrorCode.RESPONSE_STALE,
      `signed response age ${ageSec}s outside [${-FUTURE_SKEW_TOLERANCE_SEC}, ${freshnessWindowSec}]`,
    );
  }

  // 6. Signatures (2-of-2, low-s, recover + compare to current pair)
  // v2 digest = keccak256(DOMAIN_HASH || keccak256(canonical(signing_input)))
  // where signing_input is the flat response with signatures stripped, and
  // DOMAIN_HASH is the 32-byte keccak256("PaladinFi/simulate/v2") constant.
  // See paladin-server/simulator/paladin_simulator_signer.py:compute_payload_digest
  // for the matching server-side formula. Pre-v2 the digest was a single
  // keccak over raw-string-prefix + canonical bytes; v2 uses hash-of-hash
  // for structural domain separation (Security audit C-1, 2026-05-15).
  const signingInput = extractSigningInput(signed);
  const canonical = canonicalize(signingInput);
  const bodyHash = keccak256(toHex(canonical));
  const digest = keccak256(concat([DOMAIN_SEPARATOR_SIMULATE, bodyHash]));

  const sigs: ReadonlyArray<readonly ["aws" | "gcp", Hex]> = [
    ["aws", signed.awsSignature],
    ["gcp", signed.gcpSignature],
  ];
  for (const [provider, raw] of sigs) {
    const sig = enforceLowS(raw);
    let recovered: string;
    try {
      recovered = await recoverAddress({ hash: digest, signature: sig });
    } catch (e) {
      throw new PaladinTrustError(
        ErrorCode.RESPONSE_SIG_INVALID,
        `${provider} signature recovery failed: ${(e as Error).message}`,
        e,
      );
    }
    const expected = trustState.pair[provider];
    if (recovered.toLowerCase() !== expected.toLowerCase()) {
      throw new PaladinTrustError(
        ErrorCode.RESPONSE_SIG_INVALID,
        `${provider} signature does not recover to expected address ` +
          `${expected}; got ${recovered}`,
      );
    }
  }

  // All checks passed. Ratchet highest-version-ever-seen and return extract.
  highestVersionEverSeen.value = signed.apiVersion;
  return {
    ok: signed.ok,
    result: signed.result,
    error: signed.error,
    apiVersion: signed.apiVersion,
    epoch: signed.epoch,
    signedAt: signed.signedAt,
  };
}

// =============================================================================
// Helpers
// =============================================================================

/**
 * EIP-2 low-s normalization. secp256k1 signatures (r, s) are malleable —
 * both (r, s) and (r, n-s) recover to the same pubkey. EIP-2 requires
 * s ≤ n/2 to prevent malleability-based replay deduplication bypass.
 *
 * Input: 65-byte hex (r=32 + s=32 + v=1) with 0x prefix.
 * Output: same shape with s normalized to canonical form.
 */
export function enforceLowS(sig: Hex): Hex {
  const cleaned = sig.startsWith("0x") ? sig.slice(2) : sig;
  if (cleaned.length !== 130) {
    throw new PaladinTrustError(
      ErrorCode.RESPONSE_SIG_INVALID,
      `signature has wrong length: ${cleaned.length} hex chars (expected 130 = 65 bytes)`,
    );
  }
  const r = cleaned.slice(0, 64);
  const sHex = cleaned.slice(64, 128);
  const v = cleaned.slice(128, 130);
  const s = BigInt("0x" + sHex);
  if (s > SECP256K1_HALF_N) {
    const sNorm = SECP256K1_N - s;
    const sNormHex = sNorm.toString(16).padStart(64, "0");
    return `0x${r}${sNormHex}${v}` as Hex;
  }
  return sig;
}

/**
 * Numeric semantic version comparison for `paladin-simulate-vN` strings.
 * Closes R12 Sec LOW-1: lexical "v10" < "v2" was wrong; we extract the
 * numeric suffix and compare as integers.
 */
export function compareVersion(a: string, b: string): number {
  const parse = (s: string): number => {
    const m = s.match(/-v(\d+)$/);
    return m ? parseInt(m[1], 10) : 0;
  };
  return parse(a) - parse(b);
}
