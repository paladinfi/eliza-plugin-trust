/**
 * Tenderly fallback verifier — alternative to Layer 4 /v1/simulate for
 * customers who prefer Tenderly over PaladinFi for simulation.
 *
 * Per v11 §4.10.10 + R12 Sec MED-4 + R13 Sec LOW-1:
 *   - Account checksum verification (defeats typosquatting)
 *   - SPKI cert pinning to api.tenderly.co (survives cert renewals from
 *     same key; stale-pin rotation via signed advisory file)
 *   - Signed advisory: customer-side override of pinned SPKI, validated
 *     against current trust pair, with explicit checks (NOT inferred):
 *       (a) advisory.validUntil <= 7 days after issuedAt (R13 LOW-1: 30d → 7d)
 *       (b) advisory.issuedAt <= clock.now() + 60s (clock-skew tolerance)
 *       (c) advisory.validUntil > clock.now() (not expired)
 *       (d) advisory.epoch === trustState.epoch (R12 MED-4: bound to current)
 *       (e) 2-of-2 signatures recover to current trust pair
 *
 * SPKI cert pinning at the TLS layer is the load-bearing defense. Node's
 * `fetch` (undici) does not natively support SPKI pinning — implementation
 * requires undici Agent with custom TLS callback. v11 §7 step 51 (deploy)
 * is responsible for wiring the actual `simulateViaTenderly` HTTP call;
 * this file currently exposes the advisory + checksum verification primitives,
 * with `simulateViaTenderly` throwing until the SPKI plumbing lands.
 *
 * Why this is a fallback, not the default: the Tenderly path bypasses
 * PaladinFi's signed verification entirely. Customers who use it accept
 * the risk that Tenderly's TLS chain (or our SPKI pin) is the trust root,
 * not our 2-of-2 KMS pair. Documented in v11 §17 README threat model.
 */

import { promises as fs } from "node:fs";
import { recoverAddress, keccak256, toHex, concat, type Hex } from "viem";
import { canonicalize } from "./paladin-canonical";
import type { CachedTrustState } from "./paladin-keys";
import { PaladinTrustError, ErrorCode } from "../errors";
import type { Clock } from "./clock";

// =============================================================================
// Constants
// =============================================================================

/** Domain separator for Tenderly SPKI advisories. Distinct from /v1/simulate. */
const ADVISORY_DOMAIN_SEPARATOR = toHex("paladin-tenderly-advisory-v1");

/** R13 Sec LOW-1: max validity window 7d (was 30d in v9). */
export const ADVISORY_MAX_VALIDITY_SEC = 7 * 86400;

/** Clock-skew tolerance for "future" issuedAt timestamps. */
const ADVISORY_FUTURE_SKEW_SEC = 60;

/**
 * Default pinned SPKI hash (base64 SHA-256 of api.tenderly.co's subject-
 * public-key-info). REPLACED at v0.2.0 publish time with the actual
 * fingerprint. Customer can override via signed advisory.
 *
 * Until publish, leave as the literal placeholder so failures surface
 * during deploy review rather than silently bypass.
 */
export const DEFAULT_TENDERLY_API_SPKI_HASH = "PLACEHOLDER-set-at-publish";

// =============================================================================
// Types
// =============================================================================

export interface TenderlyConfig {
  user: string;
  project: string;
  /** Tenderly API access key. NEVER sent to PaladinFi. */
  accessKey: string;
  /** keccak256(toHex(`${user}:${project}`)) — defeats typosquatting. */
  accountChecksum: Hex;
}

export interface TenderlySpkiAdvisory {
  /** Base64 SHA-256 of new api.tenderly.co SPKI. */
  newSpki: string;
  /** Unix seconds when issued. */
  issuedAt: number;
  /** Unix seconds when expires. Must be ≤ issuedAt + 7d. */
  validUntil: number;
  /** Free-form reason for the rotation. */
  reason: string;
  /** Trust epoch this advisory is bound to (R12 MED-4). */
  epoch: number;
  /** 2-of-2 signatures over the canonicalized advisory minus the signature field. */
  signature: { aws: Hex; gcp: Hex };
}

export interface TenderlySimulateRequest {
  /** Tenderly's network_id field. e.g., "8453" for Base. */
  network_id: string;
  from: string;
  to: string;
  input: Hex;
  value: string;
  gas?: number;
  gas_price?: string;
}

export interface TenderlySimulateResult {
  /** Tenderly's transaction simulation status (true = succeeded on-chain). */
  status: boolean;
  /** Raw Tenderly response payload — caller may inspect for state changes. */
  raw: unknown;
}

export interface TenderlyOpts {
  config: TenderlyConfig;
  /** Path to optional signed-advisory file (~/.paladin-trust/tenderly-advisory.json). */
  spkiAdvisoryPath?: string;
  trustState: CachedTrustState;
  clock: Clock;
  signal?: AbortSignal;
}

// =============================================================================
// Public API
// =============================================================================

/**
 * Verify accountChecksum at factory construction. Throws on mismatch.
 *
 * keccak256(toHex(`${user}:${project}`)) — customer must compute this and
 * supply it; the plugin verifies. A typo'd `user` or `project` won't
 * pass the checksum, defeating typosquatting attacks per R12 Sec HIGH-2.
 */
export function verifyAccountChecksum(config: TenderlyConfig): void {
  const expected = keccak256(toHex(`${config.user}:${config.project}`));
  if (config.accountChecksum.toLowerCase() !== expected.toLowerCase()) {
    throw new PaladinTrustError(
      ErrorCode.INVALID_INPUT,
      `tenderly accountChecksum mismatch — possible typosquatting attempt. ` +
        `Expected ${expected}, got ${config.accountChecksum}`,
    );
  }
}

/**
 * Verify a signed SPKI advisory file. ALL checks shown explicitly per
 * R12 Sec MED-4. Throws PaladinTrustError(INVALID_INPUT) on any failure.
 */
export async function verifyAdvisory(
  advisory: TenderlySpkiAdvisory,
  trustState: CachedTrustState,
  clock: Clock,
): Promise<void> {
  const nowSec = Math.floor(clock.now() / 1000);

  // (a) Window ≤ 7d max (R13 LOW-1: 30d → 7d)
  if (advisory.validUntil - advisory.issuedAt > ADVISORY_MAX_VALIDITY_SEC) {
    throw new PaladinTrustError(
      ErrorCode.INVALID_INPUT,
      `tenderly advisory window ${advisory.validUntil - advisory.issuedAt}s exceeds ` +
        `${ADVISORY_MAX_VALIDITY_SEC}s max (= 7 days)`,
    );
  }

  // (b) issuedAt not unreasonably in the future
  if (advisory.issuedAt > nowSec + ADVISORY_FUTURE_SKEW_SEC) {
    throw new PaladinTrustError(
      ErrorCode.INVALID_INPUT,
      `tenderly advisory issuedAt (${advisory.issuedAt}) > now+${ADVISORY_FUTURE_SKEW_SEC}s (${nowSec + ADVISORY_FUTURE_SKEW_SEC}); ` +
        `clock skew exceeds tolerance`,
    );
  }

  // (c) Not expired
  if (advisory.validUntil <= nowSec) {
    throw new PaladinTrustError(
      ErrorCode.INVALID_INPUT,
      `tenderly advisory expired (validUntil=${advisory.validUntil}, now=${nowSec})`,
    );
  }

  // (d) Bound to current trust epoch (R12 MED-4)
  if (advisory.epoch !== trustState.epoch) {
    throw new PaladinTrustError(
      ErrorCode.INVALID_INPUT,
      `tenderly advisory epoch ${advisory.epoch} ≠ current trust epoch ${trustState.epoch}`,
    );
  }

  // (e) 2-of-2 signatures recover to current pair
  const advisoryWithoutSig: Omit<TenderlySpkiAdvisory, "signature"> = {
    newSpki: advisory.newSpki,
    issuedAt: advisory.issuedAt,
    validUntil: advisory.validUntil,
    reason: advisory.reason,
    epoch: advisory.epoch,
  };
  const canonical = canonicalize(advisoryWithoutSig);
  const digest = keccak256(concat([ADVISORY_DOMAIN_SEPARATOR, toHex(canonical)]));

  for (const provider of ["aws", "gcp"] as const) {
    const sig = advisory.signature[provider];
    let recovered: string;
    try {
      recovered = await recoverAddress({ hash: digest, signature: sig });
    } catch (e) {
      throw new PaladinTrustError(
        ErrorCode.INVALID_INPUT,
        `tenderly advisory ${provider} signature recovery failed: ${(e as Error).message}`,
        e,
      );
    }
    const expected = trustState.pair[provider];
    if (recovered.toLowerCase() !== expected.toLowerCase()) {
      throw new PaladinTrustError(
        ErrorCode.INVALID_INPUT,
        `tenderly advisory ${provider} signature does not recover to current pair[${provider}]=${expected}; got ${recovered}`,
      );
    }
  }
}

/**
 * Read the SPKI advisory from disk (if configured + present) and verify it.
 * Returns the new SPKI hash if valid, or undefined if no advisory found.
 *
 * Verification failures throw — caller's responsibility to catch and
 * decide whether to fall through to the default pinned hash. (The
 * conservative choice for high-value swaps is to fail-closed; pinned-
 * mode customers default to that posture.)
 */
export async function loadAdvisoryIfPresent(opts: TenderlyOpts): Promise<string | undefined> {
  if (!opts.spkiAdvisoryPath) return undefined;

  let raw: string;
  try {
    raw = await fs.readFile(opts.spkiAdvisoryPath, "utf8");
  } catch {
    return undefined; // no advisory file
  }

  let advisory: TenderlySpkiAdvisory;
  try {
    advisory = JSON.parse(raw) as TenderlySpkiAdvisory;
  } catch {
    throw new PaladinTrustError(
      ErrorCode.INVALID_INPUT,
      `tenderly advisory file at ${opts.spkiAdvisoryPath} is not valid JSON`,
    );
  }

  await verifyAdvisory(advisory, opts.trustState, opts.clock);
  return advisory.newSpki;
}

/**
 * Resolve the active SPKI hash to pin against. Either the default shipped
 * at npm-publish time, or the advisory-supplied override (if a verified
 * advisory file exists at `spkiAdvisoryPath`).
 */
export async function resolveTenderlySpki(opts: TenderlyOpts): Promise<string> {
  const override = await loadAdvisoryIfPresent(opts);
  return override ?? DEFAULT_TENDERLY_API_SPKI_HASH;
}

/**
 * Call Tenderly's /simulate-bundle. SPKI cert pinning enforced via undici
 * Agent with custom TLS verification (TODO: wire at deploy time, Step 51).
 *
 * Until the SPKI plumbing lands, this throws ErrorCode.SIMULATION_FAILED
 * so that production deploys that select `simulationVerifier: 'tenderly'`
 * fail visibly during smoke testing rather than silently bypass cert pin.
 */
export async function simulateViaTenderly(
  _request: TenderlySimulateRequest,
  opts: TenderlyOpts,
): Promise<TenderlySimulateResult> {
  // Always pre-validate before any network attempt.
  verifyAccountChecksum(opts.config);
  const expectedSpki = await resolveTenderlySpki(opts);

  if (expectedSpki === DEFAULT_TENDERLY_API_SPKI_HASH) {
    throw new PaladinTrustError(
      ErrorCode.SIMULATION_FAILED,
      `tenderly path: SPKI cert-pin not yet configured (still PLACEHOLDER). ` +
        `v0.2.0 deploy (Step 51) MUST wire undici Agent with TLS callback before this verifier is functional. ` +
        `Until then, customers selecting 'tenderly' must wait or use the default 'paladin-multikey'.`,
    );
  }

  // SPKI is set; full implementation pending Step 51.
  throw new PaladinTrustError(
    ErrorCode.SIMULATION_FAILED,
    `tenderly path: SPKI hash resolved (${expectedSpki.slice(0, 12)}...) but undici Agent ` +
      `wiring not yet implemented. Step 51 deploy responsibility.`,
  );
}
