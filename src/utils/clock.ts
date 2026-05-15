/**
 * Injectable Clock interface for time-dependent code.
 *
 * Why this exists:
 * - Cache TTLs (6h trust state), freshness windows (10min sig), rate-limit
 *   buckets, spending-tracker resets, retryToken expiry — all depend on time.
 * - Tests must advance time deterministically without `setTimeout(real, 7d)`.
 * - Drift CI grep test asserts no `Date.now()` outside this file (with
 *   --exclude-dir=node_modules --exclude-dir=dist).
 *
 * Production: `realClock` reads `Date.now()` (unix milliseconds).
 * Tests: `FakeClock` lets the test set/advance time atomically.
 *
 * Production guardrail: if a customer passes `clockOverride` while
 * `NODE_ENV=production`, the factory throws (see `index.ts`). This
 * prevents supply-chain attacks where a malicious dependency injects
 * a fake clock to bypass freshness/rate-limit/spending-cap checks.
 */

export interface Clock {
  /** Returns current time in unix milliseconds. */
  now(): number;
}

/** Production clock — reads `Date.now()`. */
export const realClock: Clock = {
  now(): number {
    return Date.now();
  },
};

/** Test clock — caller controls time. NOT for production use. */
export class FakeClock implements Clock {
  private currentMs: number;

  constructor(initialMs: number = 0) {
    this.currentMs = initialMs;
  }

  now(): number {
    return this.currentMs;
  }

  /** Set absolute time (unix milliseconds). */
  setTime(ms: number): void {
    this.currentMs = ms;
  }

  /** Advance by delta milliseconds. */
  advance(deltaMs: number): void {
    this.currentMs += deltaMs;
  }

  /** Convenience: advance by seconds. */
  advanceSeconds(deltaSec: number): void {
    this.currentMs += deltaSec * 1000;
  }
}

/**
 * Resolve the active clock. Called by the factory after the production
 * guardrail check. If override is non-null in production, the factory
 * throws BEFORE this is called — see index.ts.
 */
export function resolveClock(override?: Clock): Clock {
  return override ?? realClock;
}
