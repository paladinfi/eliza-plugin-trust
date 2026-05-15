/**
 * Diagnostic bundle for paladin_swap action.
 *
 * Per v11 §4.2 (factory option `paladinSwapDebug`), v11 §8.1 step 9 (README
 * documents bundle output), R10 Maint M-3 (explicit schema), R12 Sec MED-2
 * (redaction list — never leak private keys, x402 auth headers, raw calldata
 * bytes, signed payloads, server_secret, integrity keys, tenderlyConfig.accessKey).
 *
 * Customer-facing schema (DebugBundleEntry) is documented in README §9. The
 * bundle is appended one JSON-line per paladin_swap invocation to
 * `debugBundleSinkPath` (default `~/.paladin-trust/debug-bundle.jsonl`).
 *
 * Size cap (R12 Eng MED-6): when the sink file exceeds `maxBytes` (default
 * 50 MB), oldest entries are truncated. Keeps the file bounded so a long-
 * running agent doesn't fill the disk.
 *
 * Wallet-address redaction: by default, `taker` is redacted. Customers
 * with compliance constraints (no wallet addresses in logs) keep this
 * default; customers debugging multi-wallet flows can opt-in via
 * `debugRedactWalletAddress: false`.
 *
 * Categorical never-include list applies regardless of any setting:
 * private keys, mnemonic phrases, x402 payment headers, raw calldata bytes
 * (only the 4-byte selector is logged), the signed payload bytes themselves,
 * Tenderly accessKey, server_secret, HMAC integrity keys.
 *
 * The bundle never throws to the caller — failures to write to disk are
 * logged via console.warn and silently swallowed. The bundle is a
 * diagnostic tool, not load-bearing for paladin_swap correctness.
 */

import { promises as fs } from "node:fs";
import * as path from "node:path";
import { type Hex } from "viem";
import type { Clock } from "./clock";
import type { ErrorCode } from "../errors";

// =============================================================================
// Constants
// =============================================================================

export const DEBUG_BUNDLE_API_VERSION = "paladin-debug-v1" as const;

const DEFAULT_MAX_BYTES = 50 * 1024 * 1024; // 50 MB

/**
 * Field names that are NEVER serialized into the bundle, regardless of
 * `redactWalletAddress` setting. Matched case-insensitively against
 * metadata keys; nested keys via dotted-path are also matched.
 *
 * Adding to this list is a SECURITY-RELEVANT change — review carefully.
 * Removing is forbidden without 1-adversary security review.
 */
export const NEVER_INCLUDE_FIELDS: readonly string[] = Object.freeze([
  "privateKey",
  "private_key",
  "mnemonic",
  "seedPhrase",
  "seed_phrase",
  "tenderlyConfig.accessKey",
  "accessKey",
  "access_key",
  "server_secret",
  "serverSecret",
  "integrityKey",
  "integrity_key",
  "X-PAYMENT",
  "x-payment",
  "rawCalldata",
  "raw_calldata",
  "calldataBytes",
  "signedPayload",
  "signed_payload",
  "signedRawPayload",
]);

const HEX_KEY_PATTERN = /^0x[0-9a-fA-F]{64}$/;
const MAX_STRING_LENGTH = 500;

// =============================================================================
// Types
// =============================================================================

export interface DebugBundleEvent {
  /** Step number (1-16 per v11 §4.3 handler control flow). */
  step: number;
  /** Step name (e.g., "validateQuoteResponse"). */
  name: string;
  /** Step duration in milliseconds. Undefined if step ended without start. */
  durationMs?: number;
  /** Whether the step completed successfully. */
  ok: boolean;
  /** Error code if !ok. */
  errorCode?: ErrorCode;
  /** Truncated error message if !ok (max 200 chars). */
  errorMessage?: string;
  /** Per-step metadata; redacted before serialization. */
  metadata?: Record<string, unknown>;
}

export interface DebugBundleEntry {
  apiVersion: typeof DEBUG_BUNDLE_API_VERSION;
  /** Unix milliseconds when the bundle was created. */
  timestamp: number;
  /** Wallet address — only present if redactWalletAddress=false. */
  taker?: string;
  /** Decoded request inputs; raw bytes never logged. */
  request: {
    sellTokenSymbol?: string;
    buyTokenSymbol?: string;
    sellAmount?: string;
    chainId?: number;
    /** First 4 bytes of calldata (the selector); raw calldata never logged. */
    selector?: Hex;
  };
  events: DebugBundleEvent[];
  /** Final outcome of the paladin_swap call. */
  outcome: "success" | "error";
  /** Final error code if outcome=error. */
  errorCode?: ErrorCode;
  /** Diagnostic block — redacted before serialization. */
  diagnostic?: Record<string, unknown>;
}

export interface DebugBundleOpts {
  /** Master switch — when false, all methods are no-ops. */
  enabled: boolean;
  /** File path for JSONL sink. Defaults to `~/.paladin-trust/debug-bundle.jsonl`. */
  sinkPath?: string;
  /** Default true — wallet address NOT in bundle. */
  redactWalletAddress?: boolean;
  /** Size cap — file truncated to keep most recent half above this. */
  maxBytes?: number;
  /** Clock for timestamping. */
  clock: Clock;
}

// =============================================================================
// Public API
// =============================================================================

export class DebugBundle {
  private readonly entry: DebugBundleEntry;
  private readonly stepStartTimes = new Map<number, number>();
  private readonly opts: Required<Omit<DebugBundleOpts, "sinkPath">> &
    Pick<DebugBundleOpts, "sinkPath">;

  constructor(
    opts: DebugBundleOpts,
    requestSummary: DebugBundleEntry["request"],
    taker?: string,
  ) {
    this.opts = {
      enabled: opts.enabled,
      sinkPath: opts.sinkPath,
      redactWalletAddress: opts.redactWalletAddress ?? true,
      maxBytes: opts.maxBytes ?? DEFAULT_MAX_BYTES,
      clock: opts.clock,
    };
    this.entry = {
      apiVersion: DEBUG_BUNDLE_API_VERSION,
      timestamp: opts.clock.now(),
      request: { ...requestSummary },
      events: [],
      outcome: "success",
    };
    if (taker && !this.opts.redactWalletAddress) {
      this.entry.taker = taker;
    }
  }

  /** Mark step start. Used to compute `durationMs` on endStep. */
  startStep(step: number, _name: string): void {
    if (!this.opts.enabled) return;
    this.stepStartTimes.set(step, this.opts.clock.now());
  }

  /** Append a step result to the bundle. Metadata is redacted before storage. */
  endStep(
    step: number,
    name: string,
    ok: boolean,
    options: {
      errorCode?: ErrorCode;
      errorMessage?: string;
      metadata?: Record<string, unknown>;
    } = {},
  ): void {
    if (!this.opts.enabled) return;
    const start = this.stepStartTimes.get(step);
    const durationMs =
      start !== undefined ? this.opts.clock.now() - start : undefined;
    this.entry.events.push({
      step,
      name,
      durationMs,
      ok,
      errorCode: options.errorCode,
      errorMessage: options.errorMessage
        ? options.errorMessage.slice(0, 200)
        : undefined,
      metadata: options.metadata
        ? (this.redactValue(options.metadata) as Record<string, unknown>)
        : undefined,
    });
  }

  /** Set final outcome + diagnostic block. Diagnostic is redacted before storage. */
  setOutcome(
    outcome: "success" | "error",
    errorCode?: ErrorCode,
    diagnostic?: Record<string, unknown>,
  ): void {
    if (!this.opts.enabled) return;
    this.entry.outcome = outcome;
    if (errorCode) this.entry.errorCode = errorCode;
    if (diagnostic) {
      this.entry.diagnostic = this.redactValue(diagnostic) as Record<string, unknown>;
    }
  }

  /**
   * Persist the bundle to `sinkPath` and rotate if size > maxBytes. Best
   * effort — disk failures are logged but never thrown. The bundle is a
   * diagnostic, not load-bearing.
   */
  async finalize(): Promise<void> {
    if (!this.opts.enabled || !this.opts.sinkPath) return;
    try {
      await fs.mkdir(path.dirname(this.opts.sinkPath), { recursive: true });
      const line = JSON.stringify(this.entry) + "\n";
      await fs.appendFile(this.opts.sinkPath, line, { mode: 0o600 });
      const stat = await fs.stat(this.opts.sinkPath);
      if (stat.size > this.opts.maxBytes) {
        await this.truncateOldest(this.opts.sinkPath, this.opts.maxBytes);
      }
    } catch (e) {
      // eslint-disable-next-line no-console
      console.warn(
        `[paladin-trust] debug-bundle write failed: ${(e as Error).message ?? "unknown"}`,
      );
    }
  }

  /** Pre-rendered JSON for in-process inspection (e.g., re-throwing as cause). */
  toJSON(): DebugBundleEntry {
    // Deep clone to prevent caller mutation of internal state.
    return JSON.parse(JSON.stringify(this.entry)) as DebugBundleEntry;
  }

  // -------------------------------------------------------------------------
  // private — redaction
  // -------------------------------------------------------------------------

  private redactValue(value: unknown, currentPath: string = ""): Record<string, unknown> | unknown {
    if (value === null || value === undefined) return value;
    if (Array.isArray(value)) {
      return value.map((v, i) => this.redactValue(v, `${currentPath}[${i}]`));
    }
    if (typeof value === "object") {
      return this.redactObject(value as Record<string, unknown>, currentPath);
    }
    if (typeof value === "string") {
      // Defense: any 32-byte hex looks like a private key OR signed payload.
      if (HEX_KEY_PATTERN.test(value)) {
        return "[REDACTED-32-byte-hex]";
      }
      if (value.length > MAX_STRING_LENGTH) {
        return value.slice(0, MAX_STRING_LENGTH) + "…[truncated]";
      }
      return value;
    }
    return value;
  }

  private redactObject(
    obj: Record<string, unknown>,
    parentPath: string,
  ): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(obj)) {
      const fullPath = parentPath ? `${parentPath}.${key}` : key;
      // Categorical never-include match (case-insensitive on key + dotted path).
      if (this.matchesNeverInclude(key, fullPath)) {
        out[key] = "[REDACTED]";
        continue;
      }
      out[key] = this.redactValue(val, fullPath);
    }
    return out;
  }

  private matchesNeverInclude(key: string, fullPath: string): boolean {
    const lowerKey = key.toLowerCase();
    const lowerPath = fullPath.toLowerCase();
    return NEVER_INCLUDE_FIELDS.some((banned) => {
      const lowerBan = banned.toLowerCase();
      return (
        lowerKey === lowerBan ||
        lowerPath === lowerBan ||
        lowerPath.endsWith("." + lowerBan)
      );
    });
  }

  // -------------------------------------------------------------------------
  // private — rotation
  // -------------------------------------------------------------------------

  private async truncateOldest(filePath: string, _maxBytes: number): Promise<void> {
    // Read whole file (50MB is reasonable in memory), keep most recent half
    // by line count. Use atomic tmp + rename to avoid mid-truncate corruption.
    const content = await fs.readFile(filePath, "utf8");
    const lines = content.split("\n").filter((l) => l.length > 0);
    const keepFrom = Math.floor(lines.length / 2);
    const truncated = lines.slice(keepFrom).join("\n") + "\n";
    const tmp = `${filePath}.tmp.${process.pid}`;
    await fs.writeFile(tmp, truncated, { mode: 0o600 });
    await fs.rename(tmp, filePath);
  }
}

/** Default sink path: ~/.paladin-trust/debug-bundle.jsonl */
export function defaultDebugBundleSinkPath(): string {
  const home = process.env.HOME ?? process.env.USERPROFILE ?? ".";
  return path.join(home, ".paladin-trust", "debug-bundle.jsonl");
}
