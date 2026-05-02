/**
 * Resolves plugin config from the Eliza runtime's settings/env layer.
 * Falls back to DEFAULT_CONFIG values when keys are absent.
 */

import type { IAgentRuntime } from "@elizaos/core";
import { DEFAULT_CONFIG, type PaladinTrustConfig } from "./types.js";

function readSetting(runtime: IAgentRuntime, key: string): string | undefined {
  // Eliza v2-alpha exposes a getSetting method on the runtime; fall back to
  // process.env so the plugin works in non-Eliza node contexts (tests, scripts).
  type RuntimeWithGetSetting = IAgentRuntime & {
    getSetting?: (k: string) => string | undefined;
  };
  const rt = runtime as RuntimeWithGetSetting;
  if (typeof rt.getSetting === "function") {
    const v = rt.getSetting(key);
    if (v !== undefined && v !== null && String(v).length > 0) return String(v);
  }
  const env = process.env?.[key];
  return env && env.length > 0 ? env : undefined;
}

export function resolveConfig(runtime: IAgentRuntime): PaladinTrustConfig {
  const apiBase =
    readSetting(runtime, "PALADIN_TRUST_API_BASE") ?? DEFAULT_CONFIG.apiBase;

  const modeRaw =
    readSetting(runtime, "PALADIN_TRUST_MODE") ?? DEFAULT_CONFIG.mode;
  const mode: PaladinTrustConfig["mode"] =
    modeRaw === "paid" ? "paid" : "preview";

  const chainIdRaw =
    readSetting(runtime, "PALADIN_TRUST_DEFAULT_CHAIN_ID") ??
    String(DEFAULT_CONFIG.defaultChainId);
  const parsedChain = Number.parseInt(chainIdRaw, 10);
  const defaultChainId = Number.isFinite(parsedChain) && parsedChain > 0
    ? parsedChain
    : DEFAULT_CONFIG.defaultChainId;

  return { apiBase, mode, defaultChainId };
}
