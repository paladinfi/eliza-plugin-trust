/**
 * SpendingTracker — file-backed hourly + daily USDC counters with refund.
 *
 * Used at handler step 8 to enforce per-plugin-instance spending caps:
 * tryConsume(usdc) checks BOTH hourly and daily caps atomically, refund(usdc)
 * decrements both. Buckets reset at the top of UTC hour (hourly) and UTC
 * midnight (daily) — bucket boundaries don't slide; they're absolute.
 *
 * Concurrency:
 *   - File-level: `proper-lockfile` advisory lock (cross-process safe within
 *     the same machine; multi-process plugin instances on the same host
 *     serialize via this lock).
 *   - In-process: implicit JS event-loop serialization within `withLock` —
 *     no in-process Mutex needed because we await the lockfile sequentially.
 *   - File writes: atomic via tmp + rename pattern.
 *
 * Persistence schema (version 1):
 *   {
 *     "version": 1,
 *     "hourly": { "windowStartMs": <unix ms at top of hour>, "consumedUsdc": <number> },
 *     "daily":  { "windowStartMs": <unix ms at UTC midnight>, "consumedUsdc": <number> }
 *   }
 *
 * Forward-compat: unknown `version` → reset to fresh state. Customer loses
 * spending-counter history on plugin upgrade across schema breaks; this is
 * acceptable because caps are conservative and resets are infrequent.
 *
 * `attempted-unknown` semantics (handler step 9/11/14): when x402 settlement
 * state is unknowable, the tracker debits AND emits a warn-log entry to
 * `warnLogPath`. Caller is responsible for the 5-minute on-chain
 * reconciliation poll that converts the entry to confirmed-settled or
 * triggers a `refund()`. See v11 §4.8.
 */

import { promises as fs } from "node:fs";
import * as path from "node:path";
import lockfile from "proper-lockfile";
import type { Clock } from "./clock";

export interface SpendingTrackerOptions {
  /** Path to JSON state file. Parent directory created if missing. */
  filePath: string;
  /** Hourly USDC cap. Must be > 0. */
  maxHourlyUsdc: number;
  /** Daily USDC cap. Must be > 0. */
  maxDailyUsdc: number;
  /**
   * Path for warn-log entries (attempted-unknown reconciliation,
   * unknown-RPC-operator events, drain-deadline-exceeded events).
   * If undefined, warn-log writes are silently dropped.
   */
  warnLogPath?: string;
  /** Clock instance (for window-roll computation). */
  clock: Clock;
}

export type ConsumeResult =
  | { ok: true }
  | { ok: false; reason: "HOURLY_CAP_EXCEEDED" | "DAILY_CAP_EXCEEDED" };

export interface WarnLogEntry {
  type:
    | "settlement-unknown"
    | "unknown-rpc-operator"
    | "rotation-race-grace"
    | "drain-deadline-exceeded";
  taker?: string;
  sellToken?: string;
  buyToken?: string;
  recoverable?: boolean;
  detail?: string;
}

interface TrackerState {
  version: 1;
  hourly: { windowStartMs: number; consumedUsdc: number };
  daily: { windowStartMs: number; consumedUsdc: number };
}

const STATE_VERSION = 1 as const;
const HOUR_MS = 3600_000;
const DAY_MS = 86_400_000;

function topOfHourMs(nowMs: number): number {
  return Math.floor(nowMs / HOUR_MS) * HOUR_MS;
}

function midnightUtcMs(nowMs: number): number {
  return Math.floor(nowMs / DAY_MS) * DAY_MS;
}

function emptyState(nowMs: number): TrackerState {
  return {
    version: STATE_VERSION,
    hourly: { windowStartMs: topOfHourMs(nowMs), consumedUsdc: 0 },
    daily: { windowStartMs: midnightUtcMs(nowMs), consumedUsdc: 0 },
  };
}

export class SpendingTracker {
  private readonly opts: SpendingTrackerOptions;

  constructor(opts: SpendingTrackerOptions) {
    if (opts.maxHourlyUsdc <= 0 || !Number.isFinite(opts.maxHourlyUsdc)) {
      throw new Error("SpendingTracker: maxHourlyUsdc must be a positive finite number");
    }
    if (opts.maxDailyUsdc <= 0 || !Number.isFinite(opts.maxDailyUsdc)) {
      throw new Error("SpendingTracker: maxDailyUsdc must be a positive finite number");
    }
    if (opts.maxHourlyUsdc > opts.maxDailyUsdc) {
      throw new Error("SpendingTracker: maxHourlyUsdc must be ≤ maxDailyUsdc");
    }
    this.opts = opts;
  }

  /**
   * Atomically check both caps and consume `usdc` if BOTH pass. Returns
   * a discriminated union — caller maps `reason` to the corresponding
   * ErrorCode (HOURLY_CAP_EXCEEDED or DAILY_CAP_EXCEEDED).
   *
   * `usdc` may be fractional (e.g., 0.001 for one trust-check call,
   * 0.002 for trust + simulate together). Negative or zero `usdc` is
   * a programming error and throws.
   */
  async tryConsume(usdc: number): Promise<ConsumeResult> {
    if (usdc <= 0 || !Number.isFinite(usdc)) {
      throw new Error("SpendingTracker.tryConsume: usdc must be a positive finite number");
    }
    return this.withLock(async () => {
      const state = await this.readState();
      this.rollBuckets(state);
      if (state.hourly.consumedUsdc + usdc > this.opts.maxHourlyUsdc) {
        return { ok: false, reason: "HOURLY_CAP_EXCEEDED" as const };
      }
      if (state.daily.consumedUsdc + usdc > this.opts.maxDailyUsdc) {
        return { ok: false, reason: "DAILY_CAP_EXCEEDED" as const };
      }
      state.hourly.consumedUsdc += usdc;
      state.daily.consumedUsdc += usdc;
      await this.writeState(state);
      return { ok: true as const };
    });
  }

  /**
   * Decrement both buckets by `usdc`. Clamps at 0 — never goes negative
   * even if windows rolled between the original consume and this refund.
   */
  async refund(usdc: number): Promise<void> {
    if (usdc <= 0 || !Number.isFinite(usdc)) {
      throw new Error("SpendingTracker.refund: usdc must be a positive finite number");
    }
    await this.withLock(async () => {
      const state = await this.readState();
      this.rollBuckets(state);
      state.hourly.consumedUsdc = Math.max(0, state.hourly.consumedUsdc - usdc);
      state.daily.consumedUsdc = Math.max(0, state.daily.consumedUsdc - usdc);
      await this.writeState(state);
    });
  }

  /**
   * Append a warn-log entry. Used for attempted-unknown settlement state,
   * unknown-RPC-operator events, rotation-race-grace events, drain-deadline-
   * exceeded events. JSON-line format (one entry per line).
   */
  async writeWarnLog(entry: WarnLogEntry): Promise<void> {
    if (!this.opts.warnLogPath) return;
    const line =
      JSON.stringify({ ...entry, timestamp: this.opts.clock.now() }) + "\n";
    await fs.mkdir(path.dirname(this.opts.warnLogPath), { recursive: true });
    await fs.appendFile(this.opts.warnLogPath, line, "utf8");
  }

  /** Diagnostic: snapshot current consumed amounts (post-roll). */
  async snapshot(): Promise<{
    hourlyUsdc: number;
    dailyUsdc: number;
    hourlyWindowStartMs: number;
    dailyWindowStartMs: number;
  }> {
    return this.withLock(async () => {
      const state = await this.readState();
      this.rollBuckets(state);
      return {
        hourlyUsdc: state.hourly.consumedUsdc,
        dailyUsdc: state.daily.consumedUsdc,
        hourlyWindowStartMs: state.hourly.windowStartMs,
        dailyWindowStartMs: state.daily.windowStartMs,
      };
    });
  }

  // -------------------------------------------------------------------------
  // private helpers
  // -------------------------------------------------------------------------

  private rollBuckets(state: TrackerState): void {
    const now = this.opts.clock.now();
    const currentHour = topOfHourMs(now);
    const currentDay = midnightUtcMs(now);
    if (state.hourly.windowStartMs !== currentHour) {
      state.hourly = { windowStartMs: currentHour, consumedUsdc: 0 };
    }
    if (state.daily.windowStartMs !== currentDay) {
      state.daily = { windowStartMs: currentDay, consumedUsdc: 0 };
    }
  }

  private async readState(): Promise<TrackerState> {
    try {
      const raw = await fs.readFile(this.opts.filePath, "utf8");
      const parsed = JSON.parse(raw) as TrackerState;
      if (parsed.version !== STATE_VERSION) {
        // Forward-compat: unknown version → reset to fresh state.
        return emptyState(this.opts.clock.now());
      }
      return parsed;
    } catch (e) {
      const errno = (e as NodeJS.ErrnoException).code;
      if (errno === "ENOENT") {
        return emptyState(this.opts.clock.now());
      }
      // Corrupt file or JSON parse error → treat as fresh, log nothing
      // (we may not have a warnLogPath at this point in startup).
      return emptyState(this.opts.clock.now());
    }
  }

  private async writeState(state: TrackerState): Promise<void> {
    await fs.mkdir(path.dirname(this.opts.filePath), { recursive: true });
    const tmp = `${this.opts.filePath}.tmp.${process.pid}`;
    await fs.writeFile(tmp, JSON.stringify(state), { mode: 0o600 });
    await fs.rename(tmp, this.opts.filePath); // atomic on POSIX, near-atomic on NTFS
  }

  private async withLock<T>(fn: () => Promise<T>): Promise<T> {
    await fs.mkdir(path.dirname(this.opts.filePath), { recursive: true });
    // proper-lockfile requires the target file to exist.
    try {
      await fs.access(this.opts.filePath);
    } catch {
      const initial = emptyState(this.opts.clock.now());
      await fs.writeFile(this.opts.filePath, JSON.stringify(initial), { mode: 0o600 });
    }
    const release = await lockfile.lock(this.opts.filePath, { retries: 5 });
    try {
      return await fn();
    } finally {
      await release();
    }
  }
}
