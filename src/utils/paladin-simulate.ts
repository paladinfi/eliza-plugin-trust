/**
 * Layer 4 HTTP client for /v1/simulate.
 *
 * Per v11 §4.3 step 13-14 + §4.10.3 (server-side signing flow):
 *   - Generate clientNonce (32 bytes random) per call
 *   - Compute requestHash = keccak256(canonicalize(quoteReq + clientNonce))
 *   - POST to /v1/simulate with request body + nonce
 *   - On 503: server returns retryToken in body for idempotent retry
 *     (R13 Eng MED-3 — within 60s window, no second x402 settlement)
 *   - Threads AbortSignal for cancellation
 *
 * Returns the SignedSimulateResponse for the caller (handler) to verify
 * via paladin-verify.ts. This module does NOT perform verification — that
 * is the verifier's job, kept separate for testability.
 */

import { keccak256, toHex, type Hex, type Address } from "viem";
import { canonicalize } from "./paladin-canonical";
import type { SignedSimulateResponse } from "./paladin-verify";
import { PaladinTrustError, ErrorCode } from "../errors";

// =============================================================================
// Constants
// =============================================================================

/** Default request timeout — must accommodate Anvil simulation latency. */
const DEFAULT_TIMEOUT_MS = 12_000;

/** retryToken header name (server-side x402 idempotency). */
const RETRY_TOKEN_HEADER = "x-paladin-retry-token";

// =============================================================================
// Types
// =============================================================================

export interface QuoteForSimulation {
  taker: Address;
  router: Address;
  sellToken: Address;
  buyToken: Address;
  /** sellAmount in base units (string to preserve precision for 18-decimal tokens). */
  sellAmount: string;
  minBuyAmount: string;
  calldata: Hex;
  chainId: number;
  /** Native ETH attached to the call. "0" for ERC-20 → ERC-20 swaps. */
  valueWei?: string;
}

/**
 * Wire-format request body for POST /v1/simulate. Field names match the
 * server's Pydantic SimulateRequest aliases exactly:
 *   - `takerAddress` (NOT plugin's internal `taker`)
 *   - `routerAddress` (NOT plugin's internal `router`)
 *   - `requestHash` and `clientNonce` are required (R16 HIGH-A)
 *   - `apiVersion` is sent explicitly even though server has a default,
 *     so any future verifier-side discriminator on protocol version
 *     reads what was actually requested.
 *
 * The transformation from `QuoteForSimulation` to this wire shape is done
 * inline in `simulateServer()` rather than via interface inheritance, so
 * the wire boundary is one explicit place to inspect when debugging
 * shape drift between plugin and server.
 */
export interface SimulateRequestWire {
  apiVersion: "paladin-simulate-v2";
  takerAddress: Address;
  routerAddress: Address;
  sellToken: Address;
  buyToken: Address;
  sellAmount: string;
  minBuyAmount: string;
  chainId: number;
  calldata: Hex;
  valueWei: string;
  clientNonce: Hex;
  requestHash: Hex;
  retryToken?: string;
}

/** @deprecated Use SimulateRequestWire for the actual wire shape. Retained for back-compat. */
export interface SimulateRequest extends QuoteForSimulation {
  clientNonce: Hex;
}

export interface SimulateOpts {
  /** Default: https://swap.paladinfi.com/v1/simulate */
  serverUrl: string;
  /** External cancellation. */
  signal?: AbortSignal;
  /** Idempotency token for free retry within server's 60s TTL window. */
  retryToken?: string;
  /** Override timeout (ms). Default 12s. */
  timeoutMs?: number;
}

export interface SimulateResult {
  signed: SignedSimulateResponse;
  /** Returned for verify step — caller must pass through unchanged. */
  requestHash: Hex;
  /** Returned for verify step — caller must pass through unchanged. */
  clientNonce: Hex;
}

export interface SimulationFailedDetail {
  status?: number;
  retryToken?: string;
  retryAfterSec?: number;
  body?: unknown;
}

// =============================================================================
// Public API
// =============================================================================

/**
 * Generate a fresh 32-byte clientNonce as a 0x-prefixed hex string. Used
 * to bind a /v1/simulate request to a specific signed response per
 * v11 §4.10.3 (request-binding closes R8 Sec CRITICAL-1 replay attack).
 */
export function generateClientNonce(): Hex {
  const bytes = new Uint8Array(32);
  // Node 19+ exposes globalThis.crypto; older Node has require("node:crypto").webcrypto.
  // Both expose getRandomValues with the same signature.
  const cryptoApi: Crypto =
    (globalThis as unknown as { crypto?: Crypto }).crypto ??
    // Fallback for old Node — never reached on Node ≥19, here for safety.
    (require("node:crypto").webcrypto as Crypto);
  cryptoApi.getRandomValues(bytes);
  return toHex(bytes);
}

/**
 * Compute requestHash = keccak256(canonicalize({ ...quote, clientNonce })).
 * Caller passes the same hash to both `simulateServer()` and the verifier.
 */
export function computeRequestHash(quote: QuoteForSimulation, clientNonce: Hex): Hex {
  const canonical = canonicalize({ ...quote, clientNonce });
  return keccak256(toHex(canonical));
}

/**
 * POST /v1/simulate with the given quote + nonce. On success, returns the
 * SignedSimulateResponse; caller must verify. On 503 with retryToken,
 * embeds the token in the thrown error so the handler's retry path can
 * include it on the next attempt for x402 idempotency.
 *
 * Throws PaladinTrustError with ErrorCode.SIMULATION_FAILED on any
 * network/timeout/non-2xx/parse error. The `cause` field on the error
 * preserves the underlying `e` for debug-bundle output.
 */
export async function simulateServer(
  quote: QuoteForSimulation,
  clientNonce: Hex,
  requestHash: Hex,
  opts: SimulateOpts,
): Promise<SimulateResult> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    accept: "application/json",
  };
  if (opts.retryToken) {
    headers[RETRY_TOKEN_HEADER] = opts.retryToken;
  }

  // R16 HIGH-A: server's Pydantic SimulateRequest requires `requestHash` and uses
  // the alias names `takerAddress` and `routerAddress`. Plugin's internal types
  // use `taker`/`router`. Transform here at the wire boundary — explicit, one
  // place to inspect, no inheritance ambiguity.
  const body: SimulateRequestWire = {
    apiVersion: "paladin-simulate-v2",
    takerAddress: quote.taker,
    routerAddress: quote.router,
    sellToken: quote.sellToken,
    buyToken: quote.buyToken,
    sellAmount: quote.sellAmount,
    minBuyAmount: quote.minBuyAmount,
    chainId: quote.chainId,
    calldata: quote.calldata,
    valueWei: quote.valueWei ?? "0",
    clientNonce,
    requestHash,
    ...(opts.retryToken ? { retryToken: opts.retryToken } : {}),
  };

  // Stitch external + timeout AbortSignals.
  const controller = new AbortController();
  const externalSignal = opts.signal;
  if (externalSignal) {
    if (externalSignal.aborted) {
      controller.abort();
    } else {
      const onAbort = () => controller.abort();
      externalSignal.addEventListener("abort", onAbort, { once: true });
    }
  }
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  let response: Response;
  try {
    response = await fetch(opts.serverUrl, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (e) {
    clearTimeout(timeoutId);
    const aborted = (e as { name?: string }).name === "AbortError";
    throw new PaladinTrustError(
      ErrorCode.SIMULATION_FAILED,
      aborted
        ? `simulate request aborted (timeout=${timeoutMs}ms or external cancel)`
        : `simulate request failed: ${(e as Error).message ?? "unknown"}`,
      e,
    );
  }
  clearTimeout(timeoutId);

  // 503: server-side issue or fork-refresh in progress; may include retryToken.
  if (response.status === 503) {
    const retryAfter = parseRetryAfter(response.headers.get("retry-after"));
    let bodyJson: { retryToken?: string; error?: string } = {};
    try {
      bodyJson = (await response.json()) as typeof bodyJson;
    } catch {
      // Non-JSON 503 — propagate without token.
    }
    const detail: SimulationFailedDetail = {
      status: 503,
      retryToken: bodyJson.retryToken,
      retryAfterSec: retryAfter,
      body: bodyJson,
    };
    throw new PaladinTrustError(
      ErrorCode.SIMULATION_FAILED,
      `simulate returned 503: ${bodyJson.error ?? "service unavailable"}`,
      detail,
    );
  }

  if (!response.ok) {
    let bodyJson: unknown;
    try {
      bodyJson = await response.json();
    } catch {
      bodyJson = null;
    }
    throw new PaladinTrustError(
      ErrorCode.SIMULATION_FAILED,
      `simulate returned HTTP ${response.status}`,
      { status: response.status, body: bodyJson } satisfies SimulationFailedDetail,
    );
  }

  let signed: SignedSimulateResponse;
  try {
    signed = (await response.json()) as SignedSimulateResponse;
  } catch (e) {
    throw new PaladinTrustError(
      ErrorCode.SIMULATION_FAILED,
      `simulate response not valid JSON: ${(e as Error).message}`,
      e,
    );
  }

  return { signed, requestHash, clientNonce };
}

// =============================================================================
// Helpers
// =============================================================================

function parseRetryAfter(value: string | null): number | undefined {
  if (!value) return undefined;
  const n = parseInt(value, 10);
  if (Number.isFinite(n) && n >= 0 && n < 86400) return n;
  return undefined;
}
