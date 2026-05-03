/**
 * paladin_trust_check Action
 *
 * Extracts the token address (and optionally chainId, taker) from the user's
 * natural-language message via the standard Eliza v2-alpha prompt-template flow:
 * `composePromptFromState` → `runtime.useModel(ModelType.TEXT_SMALL)` →
 * `parseKeyValueXml`. If `options.address` is supplied directly (programmatic
 * invocation), the LLM extraction is bypassed.
 *
 * Then calls PaladinFi /v1/trust-check (paid mode, x402-settled $0.001 USDC on
 * Base) or /v1/trust-check/preview (free, sample fixture). Pre-sign hook in
 * client.paid() validates the 402 challenge against hard-coded constants
 * before any signing.
 *
 * Action shape: exported as `trustCheckAction` (env-only mode, default) AND
 * via factory `makeTrustCheckAction(factoryDefaults)` so the plugin factory
 * (createPaladinTrustPlugin) can bind walletClientAccount via closure rather
 * than mutating the runtime.
 */

import {
  type Action,
  type ActionResult,
  type HandlerCallback,
  type IAgentRuntime,
  type Memory,
  type State,
  ModelType,
  composePromptFromState,
  parseKeyValueXml,
} from "@elizaos/core";
import type { Address } from "viem";
import { isAddress } from "viem";
import { z } from "zod";
import { PaladinTrustClient } from "../client.js";
import { resolveConfig } from "../config.js";
import { trustCheckTemplate } from "../templates/trust-check.js";
import {
  type PaladinTrustConfig,
  type TrustCheckRequest,
  trustCheckRequestSchema,
} from "../types.js";
import { scrubViemError } from "../errors.js";

export const ACTION_NAME = "PALADIN_TRUST_CHECK";

const ACTION_DESCRIPTION =
  "Pre-trade composed risk gate on a token + taker. Calls PaladinFi /v1/trust-check " +
  "(OFAC SDN screening from U.S. Treasury XML refreshed every 24h, GoPlus token security, " +
  "Etherscan source verification, anomaly heuristics, lookalike detection). Returns a single " +
  "verdict (`allow`/`warn`/`block`) plus per-factor breakdown so the agent can abstain on `block` " +
  "before signing any swap.";

interface TrustCheckOptions {
  address?: string;
  chainId?: number | string;
  taker?: string;
}

const extractedFieldsSchema = z.object({
  address: z.string().optional(),
  chainId: z.union([z.string(), z.number()]).optional(),
  taker: z.string().optional(),
});
type ExtractedFields = z.infer<typeof extractedFieldsSchema>;

async function extractFromLlm(
  runtime: IAgentRuntime,
  message: Memory,
  state: State | undefined,
): Promise<ExtractedFields> {
  const composedState = state ?? (await runtime.composeState(message));
  const prompt = composePromptFromState({
    state: composedState,
    template: trustCheckTemplate,
  });
  const raw = await runtime.useModel(ModelType.TEXT_SMALL, { prompt });
  if (typeof raw !== "string" || raw.length === 0) {
    return {};
  }
  // parseKeyValueXml returns whatever shape it pleases; runtime-validate it
  // so a misbehaving LLM (nested tags, non-string values) doesn't crash the
  // handler with confusing TypeErrors downstream.
  const parsed = parseKeyValueXml(raw);
  if (!parsed || typeof parsed !== "object") return {};
  const validated = extractedFieldsSchema.safeParse(parsed);
  return validated.success ? validated.data : {};
}

function pickRequest(
  fields: ExtractedFields,
  defaultChainId: number,
): TrustCheckRequest {
  const rawAddress = fields.address;
  if (
    !rawAddress ||
    typeof rawAddress !== "string" ||
    rawAddress.toLowerCase() === "none" ||
    !isAddress(rawAddress as Address, { strict: false })
  ) {
    throw new Error(
      "PALADIN_TRUST_CHECK could not extract a valid EVM token address from the message. " +
        "Ask the user to specify the contract address (e.g. 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913).",
    );
  }

  const rawChain = fields.chainId;
  let chainId = defaultChainId;
  if (rawChain !== undefined && rawChain !== null && String(rawChain).toLowerCase() !== "none") {
    const parsed = typeof rawChain === "number" ? rawChain : Number.parseInt(String(rawChain), 10);
    if (Number.isFinite(parsed) && parsed > 0) chainId = parsed;
  }

  const rawTaker = typeof fields.taker === "string" ? fields.taker : undefined;
  let taker: string | undefined;
  if (rawTaker && rawTaker.toLowerCase() !== "none") {
    if (!isAddress(rawTaker as Address, { strict: false })) {
      // Fail loud rather than silently dropping a user-declared taker —
      // the user might be relying on it being passed through.
      throw new Error(
        `PALADIN_TRUST_CHECK: taker "${rawTaker}" is not a valid EVM address. Either omit taker or pass a valid 0x... address.`,
      );
    }
    taker = rawTaker;
  }

  const candidate = { address: rawAddress, chainId, taker };
  return trustCheckRequestSchema.parse(candidate);
}

const ACTION_SIMILES = [
  "CHECK_TOKEN_SAFETY",
  "PRE_TRADE_TRUST_CHECK",
  "PALADIN_TRUST",
  "VERIFY_TOKEN",
];

const ACTION_EXAMPLES = [
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
  [
    {
      name: "user",
      content: {
        text: "Is 0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48 safe to swap?",
        action: ACTION_NAME,
      },
    },
    {
      name: "assistant",
      content: {
        text:
          "Verifying 0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48 with PaladinFi's composed risk gate (OFAC + GoPlus + Etherscan + lookalike detection).",
        action: ACTION_NAME,
      },
    },
  ],
  // Negative example: should not fire on unrelated message
  [
    {
      name: "user",
      content: {
        text: "What time is it in Tokyo?",
      },
    },
    {
      name: "assistant",
      content: {
        text: "I can help with token risk checks; for time queries you'll need a different tool.",
      },
    },
  ],
];

/**
 * Build the action with optional factoryDefaults closure.
 *
 * `factoryDefaults` flow through `resolveConfig(runtime, factoryDefaults)`
 * — by-value, no runtime mutation. This means multiple plugin instances
 * (e.g. the default `paladinTrustPlugin` AND a `createPaladinTrustPlugin({...})`
 * factory) on the same runtime each see their own config without race.
 */
export function makeTrustCheckAction(
  factoryDefaults?: Partial<PaladinTrustConfig>,
): Action {
  const validate: Action["validate"] = async (runtime, message) => {
    const text = (message?.content?.text ?? "").toString().toLowerCase();
    if (!text) return false;
    const intentMatch =
      /\b(trust[- ]?check|risk[- ]?gate|honeypot|ofac|sanctioned|verify[- ]?token|pre[- ]?trade|safe to (?:swap|buy|trade))\b/.test(
        text,
      );
    if (!intentMatch) return false;

    // Wallet-readiness gate: paid mode requires walletClientAccount
    const config = resolveConfig(runtime, factoryDefaults);
    if (config.mode === "paid" && !config.walletClientAccount) {
      return false;
    }
    return true;
  };

  const handler: Action["handler"] = async (
    runtime: IAgentRuntime,
    message: Memory,
    state: State | undefined,
    options,
    callback?: HandlerCallback,
  ): Promise<ActionResult> => {
    const config = resolveConfig(runtime, factoryDefaults);
    const client = new PaladinTrustClient(config);

    const opt = options as TrustCheckOptions | undefined;
    let fields: ExtractedFields;
    if (opt?.address && typeof opt.address === "string" && isAddress(opt.address as Address, { strict: false })) {
      fields = {
        address: opt.address,
        chainId: opt.chainId,
        taker: opt.taker,
      };
    } else {
      fields = await extractFromLlm(runtime, message, state);
      if (opt?.chainId !== undefined && fields.chainId === undefined) {
        fields.chainId = opt.chainId;
      }
      if (opt?.taker && fields.taker === undefined) {
        fields.taker = opt.taker;
      }
    }

    let req: TrustCheckRequest;
    try {
      req = pickRequest(fields, config.defaultChainId);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (callback) callback({ text: msg });
      return {
        success: false,
        text: msg,
        data: { actionName: ACTION_NAME, error: "extraction_failed" },
      };
    }

    let response;
    try {
      response =
        config.mode === "paid"
          ? await client.paid(req)
          : await client.preview(req);
    } catch (e) {
      const msg = scrubViemError(e);
      if (callback) callback({ text: `PALADIN_TRUST_CHECK failed: ${msg}` });
      return {
        success: false,
        text: msg,
        data: { actionName: ACTION_NAME, error: "request_failed", request: req },
      };
    }

    const verdict = response.trust.recommendation;
    const factorSummary = response.trust.factors
      .map((f) => `${f.source}=${f.signal}${f.real ? "" : " (sample)"}`)
      .join(" / ");
    const text = `PALADIN_TRUST_CHECK (${config.mode}) for ${req.address} on chainId ${req.chainId}: recommendation=${verdict}. Factors: ${factorSummary}.`;

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
  };

  return {
    name: ACTION_NAME,
    description: ACTION_DESCRIPTION,
    similes: ACTION_SIMILES,
    validate,
    handler,
    examples: ACTION_EXAMPLES,
  };
}

/**
 * Default action export — env-only mode (no factory closure).
 * Suitable for the default `paladinTrustPlugin` and for direct registration.
 */
export const trustCheckAction: Action = makeTrustCheckAction();
