/**
 * Token-bucket rate limiter for paladin_swap action.
 *
 * Used at handler step 7 to bound per-plugin-instance call rate. Bucket
 * size and refill window come from the active spending profile (see
 * profiles.ts) or a per-knob override.
 *
 * Implementation: "leaky bucket" via timestamp queue. tryAcquire() prunes
 * timestamps older than (now - windowMs), then accepts if queue size <
 * maxCalls. O(maxCalls) per call, but maxCalls is small (≤10 across all
 * profiles) so trivial.
 *
 * Per-instance, in-memory only. Customers running multi-process agents
 * must aggregate themselves — documented in v11 §3 / §10 risk #2.
 *
 * Time source is injected via Clock (see clock.ts) — tests use FakeClock
 * to deterministically exhaust + replenish the window without real waits.
 */

import type { Clock } from "./clock";

export interface RateLimiterOptions {
  /** Maximum calls allowed within the window. Must be > 0. */
  maxCalls: number;
  /** Window length in milliseconds. Must be > 0. */
  windowMs: number;
}

export class RateLimiter {
  private readonly maxCalls: number;
  private readonly windowMs: number;
  private readonly clock: Clock;
  private readonly timestamps: number[] = [];

  constructor(opts: RateLimiterOptions, clock: Clock) {
    if (opts.maxCalls <= 0 || !Number.isFinite(opts.maxCalls)) {
      throw new Error("RateLimiter: maxCalls must be a positive finite number");
    }
    if (opts.windowMs <= 0 || !Number.isFinite(opts.windowMs)) {
      throw new Error("RateLimiter: windowMs must be a positive finite number");
    }
    this.maxCalls = opts.maxCalls;
    this.windowMs = opts.windowMs;
    this.clock = clock;
  }

  /**
   * Attempt to acquire a token. Returns true if accepted (token consumed),
   * false if the window is full (caller should return RATE_LIMITED).
   */
  tryAcquire(): boolean {
    this.prune();
    if (this.timestamps.length >= this.maxCalls) {
      return false;
    }
    this.timestamps.push(this.clock.now());
    return true;
  }

  /** Diagnostic: how many slots are currently consumed (post-prune). */
  inFlight(): number {
    this.prune();
    return this.timestamps.length;
  }

  private prune(): void {
    const cutoff = this.clock.now() - this.windowMs;
    while (this.timestamps.length > 0 && this.timestamps[0] < cutoff) {
      this.timestamps.shift();
    }
  }
}
