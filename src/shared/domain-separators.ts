/**
 * Domain separator constants for cryptographic signing across PaladinFi services.
 *
 * v2 hardening (2026-05-15, post-Security-audit C-1): the domain separator is
 * now a 32-byte keccak256 hash of a typed-domain string, NOT the raw UTF-8
 * bytes of the apiVersion. Pre-v2 the constant was the literal string bytes
 * — structurally indistinguishable from the apiVersion field appearing inside
 * the canonical payload. Cross-service replay defense was by-policy (key
 * segregation) rather than by digest math. v2 uses a hashed typed-domain
 * constant + hash-of-hash digest formula:
 *
 *     digest = keccak256(DOMAIN_HASH || keccak256(JCS(body)))
 *
 * where DOMAIN_HASH is a 32-byte constant unique to this service. Structurally
 * impossible for the digest input to collide with any field value, since the
 * inputs to the outer keccak are both 32-byte hashes.
 *
 * This file is the **single source of truth** for the TypeScript side. The
 * Python server imports a parallel file (`paladin-server/shared/domain_separators.py`)
 * that MUST emit identical bytes for the same domain. The cross-language
 * byte-equality is asserted by `tests/domain-separators.test.ts` and the
 * corresponding Python test in `paladin-server/tests/test_domain_separator_parity.py`.
 *
 * If you add a new domain separator here, add the matching constant to the
 * Python file in the SAME PR. CI will fail if the two diverge.
 */

import { keccak256, toHex, type Hex } from "viem";

// Typed-domain label for the /v1/simulate endpoint (v2 wire format).
// Human-readable; the actual prefix is the keccak256 hash of these UTF-8 bytes.
export const DOMAIN_LABEL_SIMULATE: string = "PaladinFi/simulate/v2";

// 32-byte keccak256 hash of the typed-domain label. Used by paladin-verify.ts
// as the OUTER hash input alongside keccak256(JCS(body)). Pre-v2 this was the
// raw UTF-8 bytes of "paladin-simulate-v1"; post-v2 it is a hashed constant
// for structural separation.
export const DOMAIN_SEPARATOR_SIMULATE: Hex = keccak256(toHex(DOMAIN_LABEL_SIMULATE));

// Future domain separators per v11 plan §7 v2 follow-on sprints. These are
// RESERVED — do not use until the corresponding service ships its v2 signed-
// response surface.
//
// export const DOMAIN_LABEL_QUOTE: string = "PaladinFi/quote/v1";
// export const DOMAIN_SEPARATOR_QUOTE: Hex = keccak256(toHex(DOMAIN_LABEL_QUOTE));
// export const DOMAIN_LABEL_TRUST_CHECK: string = "PaladinFi/trust-check/v1";
// export const DOMAIN_SEPARATOR_TRUST_CHECK: Hex = keccak256(toHex(DOMAIN_LABEL_TRUST_CHECK));
// export const DOMAIN_LABEL_MCP: string = "PaladinFi/mcp/v1";
// export const DOMAIN_SEPARATOR_MCP: Hex = keccak256(toHex(DOMAIN_LABEL_MCP));

/**
 * Return all currently-defined domain separators by name.
 *
 * Used by the parity test to enumerate the set against the Python side.
 */
export function allDomainSeparators(): Record<string, Hex> {
  return {
    DOMAIN_SEPARATOR_SIMULATE,
  };
}

/**
 * Return all currently-defined domain labels (pre-hash form).
 *
 * Used by the parity test to assert label-string equality across languages
 * in addition to byte-equality of the hashes.
 */
export function allDomainLabels(): Record<string, string> {
  return {
    DOMAIN_LABEL_SIMULATE,
  };
}
