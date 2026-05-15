/**
 * RFC 8785 JSON Canonicalization Scheme (JCS) wrapper.
 *
 * Why this exists:
 *   /v1/simulate response signing requires byte-identical canonical form
 *   across server (Python pyjcs) and client (TS @truestamp/canonify).
 *   Even minor representation drift breaks signature verification.
 *
 * PaladinFi-specific layer on top of vanilla JCS:
 *   1. ALL monetary/balance/amount values MUST be JSON strings, not numbers.
 *      Python ints have arbitrary precision; JS Numbers don't. JCS doesn't
 *      paper over the difference. Caller's responsibility to pre-stringify;
 *      we don't auto-convert (silent conversion = silent bugs).
 *   2. NO NaN, Infinity, or undefined. JCS implementations can drift here;
 *      we explicitly reject before serialization.
 *   3. NO BigInt. Convert to string before passing in (canonify accepts
 *      strings; BigInt JSON-serialization is not standardized).
 *   4. UTF-8 raw passthrough for non-ASCII; UTF-16 code-unit-sorted keys.
 *      `@truestamp/canonify` handles both per RFC 8785.
 *
 * Cross-language fixture harness: `tests/canonical-jcs.test.ts` (TS) and
 * `tests/test_canonical_jcs.py` (server-side Python) share
 * `tests/fixtures/jcs-fixtures.json` — 50 fixtures including nested
 * objects, Unicode (Chinese, emoji, RTL), large integers as strings,
 * tricky escapes, sorted-key edge cases. Both languages MUST produce
 * byte-identical output for every fixture; CI fails on divergence.
 *
 * Library pin (v11 §4.16 + R14 Eng LOW-5): @truestamp/canonify >=1.4.x.
 * Bump in lockstep with pyjcs server-side.
 */

import { canonify } from "@truestamp/canonify";

/** Path tracker for validation error messages. */
type Path = readonly (string | number)[];

function pathToString(path: Path): string {
  if (path.length === 0) return "$";
  return (
    "$" +
    path
      .map((p) =>
        typeof p === "number" ? `[${p}]` : /^[A-Za-z_][\w]*$/.test(p) ? `.${p}` : `["${p}"]`,
      )
      .join("")
  );
}

/**
 * Validate that `value` is JCS-safe per PaladinFi rules. Throws on first
 * violation with an actionable error message (path + reason). Called
 * implicitly by `canonicalize` and `canonicalizeToBytes`; can also be
 * called directly for pre-flight checks.
 */
export function assertCanonicalizable(value: unknown, path: Path = []): void {
  if (value === undefined) {
    throw new Error(
      `paladin-canonical: undefined at ${pathToString(path)} — use null instead, or omit the key`,
    );
  }
  if (typeof value === "bigint") {
    throw new Error(
      `paladin-canonical: BigInt at ${pathToString(path)} — convert to string before serialization (e.g., String(value))`,
    );
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Error(
        `paladin-canonical: non-finite number (${value}) at ${pathToString(path)} — JCS forbids NaN/Infinity`,
      );
    }
    // v2 H-3 hardening (2026-05-15, Security audit): reject integers outside
    // JS safe-integer range for cross-language symmetry with Python's
    // paladin_simulator_canonical.assert_canonicalizable (which raises ValueError
    // for ints > 2^53 - 1). Pre-v2 we permitted them, relying on the convention
    // that monetary fields use strings; the asymmetry was an audit-flagged
    // structural risk if a future field starts emitting raw int >2^53.
    if (Number.isInteger(value)) {
      if (value > Number.MAX_SAFE_INTEGER || value < Number.MIN_SAFE_INTEGER) {
        throw new Error(
          `paladin-canonical: integer outside JS safe range at ${pathToString(path)} ` +
            `(${value}) — convert to string for cross-language safety. ` +
            `MAX_SAFE_INTEGER = ${Number.MAX_SAFE_INTEGER}.`,
        );
      }
    }
  }
  if (typeof value === "function" || typeof value === "symbol") {
    throw new Error(
      `paladin-canonical: ${typeof value} at ${pathToString(path)} — JSON-incompatible type`,
    );
  }
  if (value !== null && typeof value === "object") {
    if (Array.isArray(value)) {
      value.forEach((v, i) => {
        assertCanonicalizable(v, [...path, i]);
      });
      return;
    }
    // Plain object — recurse into entries.
    for (const [k, v] of Object.entries(value)) {
      assertCanonicalizable(v, [...path, k]);
    }
  }
}

/**
 * Canonicalize a value to RFC 8785 JCS form for cross-language signing.
 *
 * Throws synchronously on any JCS-unsafe content — caller does not need
 * to try/catch because all checks happen before serialization.
 *
 * Returns the canonical JSON string (UTF-8 byte-identical to server-side
 * pyjcs output). For digest computation, prefer `canonicalizeToBytes` to
 * avoid an unnecessary string→bytes conversion at the call site.
 */
export function canonicalize(value: unknown): string {
  assertCanonicalizable(value);
  const result = canonify(value);
  if (result === undefined) {
    throw new TypeError(
      "canonify returned undefined; assertCanonicalizable should have rejected this input upstream",
    );
  }
  return result;
}

/**
 * Canonicalize a value to its JCS byte form (UTF-8). Suitable for direct
 * keccak256/SHA-256 digest computation in signing flows.
 */
export function canonicalizeToBytes(value: unknown): Uint8Array {
  return new TextEncoder().encode(canonicalize(value));
}

/**
 * Convenience: assert two values produce byte-identical canonical forms.
 * Used in unit tests + drift CI to verify cross-language fixture parity
 * before declaring an upgrade safe.
 */
export function assertCanonicallyEqual(a: unknown, b: unknown): void {
  const ca = canonicalize(a);
  const cb = canonicalize(b);
  if (ca !== cb) {
    throw new Error(
      `paladin-canonical: values differ in canonical form\n  a: ${ca}\n  b: ${cb}`,
    );
  }
}
