/**
 * paladin_trust_check Action
 *
 * v0.0.1 SCOPE NOTE
 * -----------------
 * This action is shipped as a SKELETON for community feedback (per Eliza Discussion
 * https://github.com/orgs/elizaOS/discussions/7242). Two simplifications vs the
 * full v2-alpha pattern (e.g. plugin-evm/transfer.ts) are deliberate:
 *
 * 1. No LLM prompt-template extraction. transfer.ts uses
 *    `composePromptFromState` + `runtime.useModel(ModelType.TEXT_SMALL)` +
 *    `parseKeyValueXml` to extract structured params from the user's natural-language
 *    request. We skip that here. v0.0.1 expects the address in `options.address`.
 *    v0.1.0 will wire in the full prompt-template flow per evm-plugin conventions.
 *
 * 2. No paid x402 settlement. v0.0.1 always uses the FREE preview endpoint
 *    (`/v1/trust-check/preview`) which returns a sample fixture. Paid mode requires
 *    wallet-runtime EIP-3009 signing which lands in v0.1.0.
 *
 * The skeleton is published to anchor the public Eliza Discussion commitment with
 * a real artifact instead of a design doc. Functional value lands in v0.1.0.
 */

import {
  type Action,
  type ActionResult,
  type HandlerCallback,
  type IAgentRuntime,
  type Memory,
  type State,
} from "@elizaos/core";
import type { Address } from "viem";
import { isAddress } from "viem";
import { PaladinTrustClient } from "../client.js";
import { resolveConfig } from "../config.js";
import {
  type TrustCheckRequest,
  trustCheckRequestSchema,
} from "../types.js";

const ACTION_NAME = "PALADIN_TRUST_CHECK";

const ACTION_DESCRIPTION =
  "Pre-trade composed risk gate on a token + taker. Calls PaladinFi /v1/trust-check " +
  "(OFAC SDN screening from U.S. Treasury XML refreshed every 24h, GoPlus token security, " +
  "Etherscan source verification, anomaly heuristics, lookalike detection). Returns a single " +
  "verdict (`allow`/`warn`/`block`) plus per-factor breakdown so the agent can abstain on `block` " +
  "before signing any swap. Settled via x402 micropayments on Base ($0.001 USDC/call when in paid mode).";

interface TrustCheckOptions {
  address?: string;
  chainId?: number | string;
  taker?: string;
  confirmed?: boolean;
}

function pickRequest(
  options: TrustCheckOptions | undefined,
  defaultChainId: number,
): TrustCheckRequest {
  const rawAddress = options?.address;
  if (!rawAddress || typeof rawAddress !== "string") {
    throw new Error(
      "paladin_trust_check requires `options.address` (the buy-token contract address). " +
        "v0.0.1 does not extract this from natural language; v0.1.0 will via the standard " +
        "Eliza prompt-template flow.",
    );
  }
  if (!isAddress(rawAddress as Address)) {
    throw new Error(
      `paladin_trust_check: address "${rawAddress}" is not a valid EIP-55 hex address`,
    );
  }

  const rawChain = options?.chainId;
  let chainId = defaultChainId;
  if (rawChain !== undefined) {
    const parsed = typeof rawChain === "number" ? rawChain : Number.parseInt(String(rawChain), 10);
    if (Number.isFinite(parsed) && parsed > 0) chainId = parsed;
  }

  const taker = typeof options?.taker === "string" && isAddress(options.taker as Address)
    ? options.taker
    : undefined;

  const candidate = { address: rawAddress, chainId, taker };
  return trustCheckRequestSchema.parse(candidate);
}

export const trustCheckAction: Action = {
  name: ACTION_NAME,
  description: ACTION_DESCRIPTION,
  similes: [
    "CHECK_TOKEN_SAFETY",
    "PRE_TRADE_TRUST_CHECK",
    "PALADIN_TRUST",
    "VERIFY_TOKEN",
  ],

  validate: async (
    _runtime: IAgentRuntime,
    message: Memory,
    _state?: State,
  ): Promise<boolean> => {
    // v0.0.1: simple keyword-based intent gate. v0.1.0 will use the structured
    // validator factory (see plugin-evm/actions/helpers.ts createEvmActionValidator).
    const text = (message?.content?.text ?? "").toString().toLowerCase();
    if (!text) return false;
    return /\b(trust[- ]?check|risk[- ]?gate|honeypot|ofac|sanctioned|verify[- ]?token|pre[- ]?trade)\b/.test(
      text,
    );
  },

  handler: async (
    runtime: IAgentRuntime,
    _message: Memory,
    _state: State | undefined,
    options: Record<string, unknown> | undefined,
    callback?: HandlerCallback,
  ): Promise<ActionResult> => {
    const config = resolveConfig(runtime);
    const client = new PaladinTrustClient(config);

    const req = pickRequest(options as TrustCheckOptions | undefined, config.defaultChainId);

    // v0.0.x: config.ts gracefully degrades any "paid" mode request to
    // "preview" with a one-time console.warn. The action handler never sees
    // mode === "paid" in v0.0.x. v0.1.0 wires the paid x402 settlement path.
    const response = await client.preview(req);

    const verdict = response.trust.recommendation;
    const factorSummary = response.trust.factors
      .map((f) => `${f.source}=${f.signal}${f.real ? "" : " (sample)"}`)
      .join(" / ");
    const text = `paladin_trust_check (${config.mode}) for ${req.address} on chainId ${req.chainId}: recommendation=${verdict}. Factors: ${factorSummary}.`;

    if (callback) {
      callback({
        text,
        content: {
          paladinTrust: response,
          mode: config.mode,
        },
      });
    }

    return {
      success: true,
      text,
      values: {
        paladinTrustRecommendation: verdict,
        paladinTrustMode: config.mode,
      },
      data: {
        actionName: ACTION_NAME,
        request: req,
        response,
      },
    };
  },

  examples: [
    [
      {
        name: "user",
        content: {
          text: "Run a pre-trade trust check on 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913 on Base before swapping",
          action: ACTION_NAME,
        },
      },
      {
        name: "assistant",
        content: {
          text:
            "Calling PaladinFi /v1/trust-check on 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913 (chainId 8453). " +
            "Will abstain from the swap if recommendation comes back `block`.",
          action: ACTION_NAME,
        },
      },
    ],
  ],
};
