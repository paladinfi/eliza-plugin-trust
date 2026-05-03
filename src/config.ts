/**
 * Resolves plugin config from the Eliza runtime's settings/env layer.
 *
 * factoryDefaults are passed in by-value from the action factory closure
 * (`makeTrustCheckAction(factoryDefaults)`) — no runtime mutation. This avoids
 * the silent-load-order race that arises when two plugin instances try to
 * decorate the same runtime via a shared symbol slot.
 *
 * Env override precedence: env > factoryDefaults > DEFAULT_CONFIG.
 *
 * Special case: if `PALADIN_TRUST_MODE=paid` is set in env but no
 * walletClientAccount was passed via the factory, we degrade to preview with
 * a once-per-runtime warn — this matches v0.0.x behavior so existing setups
 * don't break on upgrade.
 */

import type { IAgentRuntime } from "@elizaos/core";
import { DEFAULT_CONFIG, type PaladinTrustConfig } from "./types.js";
import type { LocalAccount } from "viem/accounts";

function readSetting(runtime: IAgentRuntime, key: string): string | undefined {
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

// Track which runtimes have already received the paid-degrade warning.
// WeakSet so it doesn't pin runtimes against GC.
const _paidWarnEmittedRuntimes = new WeakSet<object>();

export function resolveConfig(
  runtime: IAgentRuntime,
  factoryDefaults?: Partial<PaladinTrustConfig>,
): PaladinTrustConfig {
  const rawApiBase =
    readSetting(runtime, "PALADIN_TRUST_API_BASE") ??
    factoryDefaults?.apiBase ??
    DEFAULT_CONFIG.apiBase;
  const apiBase = enforceHttps(rawApiBase, runtime);

  const modeRaw =
    readSetting(runtime, "PALADIN_TRUST_MODE") ??
    factoryDefaults?.mode ??
    DEFAULT_CONFIG.mode;
  let mode: PaladinTrustConfig["mode"] =
    modeRaw === "paid" ? "paid" : "preview";

  const walletClientAccount: LocalAccount | undefined =
    factoryDefaults?.walletClientAccount;

  // Paid mode requires a wallet. Without one, degrade to preview with a one-time
  // warn (per-runtime, not per-process) so multi-runtime hosts still get notified.
  if (mode === "paid" && !walletClientAccount) {
    if (!_paidWarnEmittedRuntimes.has(runtime as object)) {
      const warn =
        "[paladin-trust] PALADIN_TRUST_MODE=paid but plugin was constructed without walletClientAccount. " +
        "Falling back to preview. To enable paid mode, use createPaladinTrustPlugin({ walletClientAccount }) " +
        "from @paladinfi/eliza-plugin-trust.";
      console.warn(warn);
      _paidWarnEmittedRuntimes.add(runtime as object);
    }
    mode = "preview";
  }

  const chainIdRaw =
    readSetting(runtime, "PALADIN_TRUST_DEFAULT_CHAIN_ID") ??
    String(factoryDefaults?.defaultChainId ?? DEFAULT_CONFIG.defaultChainId);
  const parsedChain = Number.parseInt(chainIdRaw, 10);
  const defaultChainId =
    Number.isFinite(parsedChain) && parsedChain > 0
      ? parsedChain
      : DEFAULT_CONFIG.defaultChainId;

  const config: PaladinTrustConfig = {
    apiBase,
    mode,
    defaultChainId,
  };
  // Attach walletClientAccount non-enumerably so accidental JSON.stringify
  // won't expose it via the resolved config.
  if (walletClientAccount) {
    Object.defineProperty(config, "walletClientAccount", {
      value: walletClientAccount,
      enumerable: false,
      writable: false,
      configurable: false,
    });
  }
  return config;
}

function enforceHttps(url: string, runtime: IAgentRuntime): string {
  if (url.startsWith("https://")) return url;
  if (
    url.startsWith("http://localhost") ||
    url.startsWith("http://127.0.0.1")
  ) {
    return url;
  }
  // Allow other http:// only when explicit env override is set (testnet/dev).
  // NOTE: PALADIN_TRUST_ALLOW_INSECURE has NO EFFECT in paid mode (paid mode
  // requires HTTPS regardless) — see factory in index.ts AND the constructor
  // in client.ts which both throw if a paid-mode apiBase is non-HTTPS.
  const allow = readSetting(runtime, "PALADIN_TRUST_ALLOW_INSECURE") ?? "";
  if (allow === "1" || allow.toLowerCase() === "true") return url;
  throw new Error(
    `[paladin-trust] PALADIN_TRUST_API_BASE must use https:// (got "${url.slice(0, 80)}"). ` +
      "Set PALADIN_TRUST_ALLOW_INSECURE=1 for non-HTTPS dev/testnet hosts (preview mode only).",
  );
}
