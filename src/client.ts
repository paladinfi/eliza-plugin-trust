/**
 * HTTP client for the PaladinFi trust-check endpoints.
 *
 * - `preview()` — free, sample-fixture, no auth/payment.
 * - `paid()`    — x402-settled $0.001 USDC/call on Base via @x402/fetch@2.11.0.
 *                 Pre-sign hook validates the server's 402 challenge against
 *                 hard-coded constants before viem signs anything.
 * - `paidEx()`  — v0.2.0 NEW. Same paid call but returns `{ data,
 *                 settlementState, txHash? }` for refund accounting in the
 *                 paladin_swap handler. On error, throws `TrustCheckPaidError`
 *                 carrying `settlementState` so the handler maps to
 *                 refund/debit/warn-log per v11 §4.3 step 9.
 * - `walletAddress` — convenience getter for the configured wallet address
 *                     (used by handler step 4 INVALID_TAKER check).
 *
 * Wallet account is held privately on the instance via a `#config` private
 * field. Do NOT JSON.stringify the client.
 *
 * Defense-in-depth: this constructor enforces HTTPS in paid mode (mirroring
 * createPaladinTrustPlugin's boot-time check). A consumer who instantiates
 * PaladinTrustClient directly (skipping the factory) still gets the gate.
 */

import { x402Client, wrapFetchWithPayment } from "@x402/fetch";
import { registerExactEvmScheme } from "@x402/evm/exact/client";
import {
  type PaladinTrustConfig,
  type PaidExResult,
  type SettlementState,
  type TrustCheckRequest,
  type TrustCheckResponse,
  trustCheckResponseSchema,
} from "./types.js";
import { validatePaladinContext } from "./x402/validate.js";
import { scrubViemError } from "./errors.js";
import { BASE_NETWORK } from "./x402/constants.js";

/** Distinct prefix on hook-abort errors so operators can grep their logs. */
const HOOK_ABORT_PREFIX = "paladin-trust BLOCKED pre-sign:";

/**
 * Error thrown by `paidEx()` carrying the settlementState for the
 * paladin_swap handler's refund decision tree (v11 §4.3 step 9).
 *
 * v0.1.0 callers using `paid()` are unaffected — that method continues
 * to throw plain `Error` for backwards-compatibility.
 */
export class TrustCheckPaidError extends Error {
  public readonly settlementState: SettlementState;
  public override readonly cause?: unknown;

  constructor(
    message: string,
    settlementState: SettlementState,
    cause?: unknown,
  ) {
    super(message);
    this.name = "TrustCheckPaidError";
    this.settlementState = settlementState;
    if (cause !== undefined) this.cause = cause;
    if (typeof Error.captureStackTrace === "function") {
      Error.captureStackTrace(this, TrustCheckPaidError);
    }
  }
}

export class PaladinTrustClient {
  readonly #config: PaladinTrustConfig;
  readonly #paidFetch: typeof globalThis.fetch | undefined;

  constructor(config: PaladinTrustConfig) {
    this.#config = config;

    if (config.mode === "paid") {
      // HTTPS gate — defense in depth (factory also checks; this catches
      // direct PaladinTrustClient instantiation that bypasses the factory).
      if (!config.apiBase.startsWith("https://")) {
        throw new Error(
          `[paladin-trust] paid mode requires https:// apiBase (got "${config.apiBase.slice(0, 80)}"). ` +
            "PALADIN_TRUST_ALLOW_INSECURE has no effect on paid mode.",
        );
      }

      if (!config.walletClientAccount) {
        // Fallthrough: no wallet means we cannot construct paidFetch. The
        // resolveConfig path degrades paid→preview with a warn already; if
        // someone passes mode:paid without wallet directly, paid() will throw.
        return;
      }

      const x402 = new x402Client();
      // Pin v2 to Base ONLY. Belt-and-suspenders: also add a policy that
      // filters requirements to BASE_NETWORK so v1 schemes (auto-registered
      // for all EVM networks by registerExactEvmScheme) are unreachable
      // even if a future change weakens the hook.
      registerExactEvmScheme(x402, {
        signer: config.walletClientAccount,
        networks: [BASE_NETWORK],
        policies: [
          (_x402Version, reqs) => reqs.filter((r) => r.network === BASE_NETWORK),
        ],
      });
      // Pre-sign hook — last line of defense before viem signs anything.
      x402.onBeforePaymentCreation(async (context) => {
        const r = validatePaladinContext(context);
        if (!r.ok) {
          return { abort: true, reason: `${HOOK_ABORT_PREFIX} ${r.reason}` };
        }
        return undefined;
      });
      // We deliberately do NOT register onPaymentCreationFailure: a recovery
      // hook can swallow an abort + supply a forged payload, defeating the gate.
      this.#paidFetch = wrapFetchWithPayment(globalThis.fetch, x402);
    }
  }

  /**
   * Wallet address from the configured `walletClientAccount`. Used by
   * the paladin_swap handler at step 4 to enforce taker === wallet.address.
   * Returns undefined for preview-only configurations.
   */
  get walletAddress(): string | undefined {
    return this.#config.walletClientAccount?.address;
  }

  /**
   * POST /v1/trust-check/preview — free, no auth, returns sample fixture.
   * Every factor has `real: false` and `recommendation` is `sample-` prefixed
   * so the response cannot be cropped into looking like a real assessment.
   */
  async preview(req: TrustCheckRequest): Promise<TrustCheckResponse> {
    const url = `${this.#config.apiBase}/v1/trust-check/preview`;
    let res: Response;
    try {
      res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(req),
      });
    } catch (e) {
      throw new Error(`paladin-trust preview call failed: ${scrubViemError(e)}`);
    }

    if (!res.ok) {
      const body = await res.text().catch(() => "<unreadable>");
      throw new Error(
        `paladin-trust preview HTTP ${res.status}: ${body.slice(0, 500)}`,
      );
    }

    let json: unknown;
    try {
      json = await res.json();
    } catch (e) {
      throw new Error(`paladin-trust preview response parse failed: ${scrubViemError(e)}`);
    }
    // safeParse so malformed responses don't leak field details via ZodError
    const parsed = trustCheckResponseSchema.safeParse(json);
    if (!parsed.success) {
      throw new Error("paladin-trust preview response failed schema validation");
    }
    return parsed.data;
  }

  /**
   * POST /v1/trust-check — paid, x402-settled $0.001 USDC/call on Base.
   *
   * Settlement flow (handled by @x402/fetch):
   *   1. Plain POST → server returns 402 + payment-required header
   *   2. Lib parses challenge, calls onBeforePaymentCreation hook
   *   3. Hook validates against PALADIN_TREASURY/BASE_USDC/etc.; aborts on mismatch
   *   4. If OK, viem signs EIP-3009 transferWithAuthorization
   *   5. Lib retries with X-PAYMENT header; server settles + returns 200
   *
   * If the hook aborts, the thrown error message is prefixed with
   * "paladin-trust BLOCKED pre-sign:" so operators can grep / alert.
   *
   * v0.2.0: optional `opts.signal` for AbortSignal cancellation. Backwards-
   * compatible — v0.1.0 callers without opts work unchanged.
   */
  async paid(
    req: TrustCheckRequest,
    opts: { signal?: AbortSignal } = {},
  ): Promise<TrustCheckResponse> {
    if (!this.#paidFetch) {
      throw new Error(
        "paladin-trust paid mode not initialized. Use createPaladinTrustPlugin({ walletClientAccount }) " +
          "with a viem LocalAccount (e.g. privateKeyToAccount).",
      );
    }
    const url = `${this.#config.apiBase}/v1/trust-check`;
    let r: Response;
    try {
      r = await this.#paidFetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(req),
        signal: opts.signal,
      });
    } catch (e) {
      // Surface hook-abort reason verbatim if present (so operators see WHICH
      // check tripped); otherwise scrub viem internals.
      const scrubbed = scrubViemError(e);
      // The library wraps our hook-return into an Error; check both message
      // and any reason carried via cause.
      const causeMsg =
        e instanceof Error && e.cause instanceof Error ? e.cause.message : "";
      const reasonField =
        e instanceof Error && typeof (e as unknown as { reason?: unknown }).reason === "string"
          ? (e as unknown as { reason: string }).reason
          : "";
      const fromCause = causeMsg || reasonField;
      const combined = scrubbed.includes(HOOK_ABORT_PREFIX)
        ? scrubbed
        : fromCause.includes(HOOK_ABORT_PREFIX)
          ? fromCause.slice(0, 300)
          : scrubbed;
      throw new Error(`paladin-trust paid call failed: ${combined}`);
    }
    if (!r.ok) {
      throw new Error(`paladin-trust paid HTTP ${r.status}`);
    }
    let json: unknown;
    try {
      json = await r.json();
    } catch (e) {
      throw new Error(`paladin-trust paid response parse failed: ${scrubViemError(e)}`);
    }
    const parsed = trustCheckResponseSchema.safeParse(json);
    if (!parsed.success) {
      throw new Error("paladin-trust paid response failed schema validation");
    }
    return parsed.data;
  }

  /**
   * v0.2.0 NEW. Paid trust-check that returns settlement metadata for the
   * paladin_swap handler's refund decision tree (v11 §4.3 step 9).
   *
   * Returns `{ data, settlementState, txHash? }` on success.
   * Throws `TrustCheckPaidError` (with .settlementState field) on failure
   * so the handler can branch refund/debit/warn-log:
   *   - settlementState='not-attempted' → refund tracker
   *   - settlementState='attempted-unknown' → debit + warn-log + 5min reconcile
   *   - settlementState='confirmed-failed' → refund tracker
   *
   * Settlement-state mapping (best-effort given x402 lib opacity):
   *   - HOOK_ABORT_PREFIX in error → not-attempted (signing didn't happen)
   *   - AbortSignal cancellation pre-fetch → not-attempted
   *   - HTTP 402 after retry → confirmed-failed (payment explicitly rejected)
   *   - All other errors → attempted-unknown (conservative for safety)
   */
  async paidEx(
    req: TrustCheckRequest,
    opts: { signal?: AbortSignal } = {},
  ): Promise<PaidExResult> {
    if (!this.#paidFetch) {
      throw new TrustCheckPaidError(
        "paladin-trust paid mode not initialized. Use createPaladinTrustPlugin({ walletClientAccount }) " +
          "with a viem LocalAccount.",
        "not-attempted",
      );
    }
    const url = `${this.#config.apiBase}/v1/trust-check`;
    let r: Response;
    try {
      r = await this.#paidFetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(req),
        signal: opts.signal,
      });
    } catch (e) {
      const scrubbed = scrubViemError(e);
      const causeMsg =
        e instanceof Error && e.cause instanceof Error ? e.cause.message : "";
      const reasonField =
        e instanceof Error && typeof (e as unknown as { reason?: unknown }).reason === "string"
          ? (e as unknown as { reason: string }).reason
          : "";
      const fromCause = causeMsg || reasonField;
      const combined = scrubbed.includes(HOOK_ABORT_PREFIX)
        ? scrubbed
        : fromCause.includes(HOOK_ABORT_PREFIX)
          ? fromCause.slice(0, 300)
          : scrubbed;

      // Settlement-state mapping. Pre-sign hook abort or AbortSignal
      // cancellation = not-attempted. Anything else from the fetch path
      // is attempted-unknown (conservative — we can't tell if x402 lib
      // signed before the throw).
      const aborted = (e as { name?: string }).name === "AbortError";
      const hookAborted =
        combined.includes(HOOK_ABORT_PREFIX) || fromCause.includes(HOOK_ABORT_PREFIX);
      const settlementState: SettlementState =
        hookAborted || aborted ? "not-attempted" : "attempted-unknown";

      throw new TrustCheckPaidError(
        `paladin-trust paid call failed: ${combined}`,
        settlementState,
        e,
      );
    }
    if (!r.ok) {
      // HTTP 402 after retry = payment explicitly rejected (confirmed-failed).
      // Other non-2xx = attempted-unknown (response came after potential settlement).
      const settlementState: SettlementState =
        r.status === 402 ? "confirmed-failed" : "attempted-unknown";
      throw new TrustCheckPaidError(
        `paladin-trust paid HTTP ${r.status}`,
        settlementState,
      );
    }
    let json: unknown;
    try {
      json = await r.json();
    } catch (e) {
      throw new TrustCheckPaidError(
        `paladin-trust paid response parse failed: ${scrubViemError(e)}`,
        "attempted-unknown",
        e,
      );
    }
    const parsed = trustCheckResponseSchema.safeParse(json);
    if (!parsed.success) {
      throw new TrustCheckPaidError(
        "paladin-trust paid response failed schema validation",
        "attempted-unknown",
      );
    }
    // Server may surface the settlement tx hash via response header
    // (per swap.paladinfi.com v0.11.x convention).
    const txHash = r.headers.get("x-paladin-tx-hash") ?? undefined;
    return {
      data: parsed.data,
      settlementState: "attempted-confirmed",
      txHash,
    };
  }
}
