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

let _paidWarnEmitted = false;

export function resolveConfig(runtime: IAgentRuntime): PaladinTrustConfig {
  const rawApiBase =
    readSetting(runtime, "PALADIN_TRUST_API_BASE") ?? DEFAULT_CONFIG.apiBase;

  // HTTPS enforcement: reject non-HTTPS bases unless explicit dev override.
  // Localhost is allowed for development without the override.
  const apiBase = enforceHttps(rawApiBase, runtime);

  // Graceful-degrade: v0.0.x silently downgrades `paid` → `preview` (with a
  // one-time warn) since paid mode lands in v0.1.0. Without this, env vars
  // set per the public docs would surface the throw at first NL invocation.
  const modeRaw =
    readSetting(runtime, "PALADIN_TRUST_MODE") ?? DEFAULT_CONFIG.mode;
  let mode: PaladinTrustConfig["mode"] =
    modeRaw === "paid" ? "paid" : "preview";

  if (mode === "paid") {
    if (!_paidWarnEmitted) {
      const warn =
        "[paladin-trust] paid mode is not implemented in v0.0.x — falling back to preview. Paid x402 settlement lands in v0.1.0 (https://github.com/paladinfi/eliza-plugin-trust/issues/1).";
      // Use console.warn to avoid coupling to a specific runtime logger.
      console.warn(warn);
      _paidWarnEmitted = true;
    }
    mode = "preview";
  }

  const chainIdRaw =
    readSetting(runtime, "PALADIN_TRUST_DEFAULT_CHAIN_ID") ??
    String(DEFAULT_CONFIG.defaultChainId);
  const parsedChain = Number.parseInt(chainIdRaw, 10);
  const defaultChainId =
    Number.isFinite(parsedChain) && parsedChain > 0
      ? parsedChain
      : DEFAULT_CONFIG.defaultChainId;

  return { apiBase, mode, defaultChainId };
}

function enforceHttps(url: string, runtime: IAgentRuntime): string {
  if (url.startsWith("https://")) return url;
  // Allow http://localhost for development without explicit override.
  if (
    url.startsWith("http://localhost") ||
    url.startsWith("http://127.0.0.1")
  ) {
    return url;
  }
  // Allow other http:// only when explicit env override is set (testnet/dev).
  const allow = readSetting(runtime, "PALADIN_TRUST_ALLOW_INSECURE") ?? "";
  if (allow === "1" || allow.toLowerCase() === "true") return url;
  throw new Error(
    `[paladin-trust] PALADIN_TRUST_API_BASE must use https:// (got "${url.slice(0, 80)}"). ` +
      "Set PALADIN_TRUST_ALLOW_INSECURE=1 for non-HTTPS dev/testnet hosts.",
  );
}
