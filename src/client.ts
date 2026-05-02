/**
 * Thin HTTP client for the PaladinFi trust-check endpoints.
 *
 * Currently only the preview endpoint (free; sample fixture) is wired in v0.0.1.
 * Paid endpoint requires the wallet runtime to provide x402 settlement, which
 * lands in v0.1.0 alongside the full LLM-prompt extraction flow.
 */

import {
  type PaladinTrustConfig,
  type TrustCheckRequest,
  type TrustCheckResponse,
  trustCheckResponseSchema,
} from "./types.js";

export class PaladinTrustClient {
  constructor(private readonly config: PaladinTrustConfig) {}

  /**
   * Hit POST /v1/trust-check/preview. Free, no auth, no payment.
   * Always returns a sample fixture — every factor has `real: false` and
   * `recommendation` is `sample-` prefixed so the response cannot be
   * cropped into looking like a real assessment.
   *
   * Suitable for development, CI, request-shape validation. NOT a substitute
   * for live evaluation — for that, switch to `mode: "paid"` (v0.1.0).
   */
  async preview(req: TrustCheckRequest): Promise<TrustCheckResponse> {
    const url = `${this.config.apiBase}/v1/trust-check/preview`;
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(req),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => "<unreadable>");
      throw new Error(
        `paladin-trust preview HTTP ${res.status}: ${body.slice(0, 500)}`,
      );
    }

    const json: unknown = await res.json();
    return trustCheckResponseSchema.parse(json);
  }

  /**
   * Live paid call against /v1/trust-check. NOT IMPLEMENTED in v0.0.1 —
   * x402 settlement requires a wallet runtime and the EIP-3009 signing flow
   * which we wire in v0.1.0.
   *
   * For now, throws if invoked. Use {@link preview} for v0.0.1.
   */
  async paid(_req: TrustCheckRequest): Promise<TrustCheckResponse> {
    throw new Error(
      "paladin-trust paid mode not yet implemented in v0.0.1; use preview mode. " +
        "Tracking: https://github.com/paladinfi/eliza-plugin-trust/issues",
    );
  }
}
