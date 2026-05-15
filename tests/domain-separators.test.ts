/**
 * Cross-language parity test for DOMAIN_SEPARATOR constants.
 *
 * v0.3.0 (2026-05-15 hardening): the constants are now 32-byte keccak256
 * hashes of typed-domain labels (was raw UTF-8 bytes pre-v0.3.0). Fixture
 * shape carries the label + the keccak256 hex; both languages re-derive
 * the hash from the label and assert byte-equality.
 *
 * Asserts byte-equality between the TS `src/shared/domain-separators` module
 * and the shared fixture at `tests/fixtures/domain-separators-parity.json`.
 *
 * If this test fails, signatures produced on one side will not verify on the
 * other. Add new separators in lockstep on both sides + regenerate the fixture.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it, expect } from "vitest";
import { keccak256, toHex } from "viem";

import {
  DOMAIN_LABEL_SIMULATE,
  DOMAIN_SEPARATOR_SIMULATE,
  allDomainSeparators,
  allDomainLabels,
} from "../src/shared/domain-separators";

const FIXTURE_PATH = resolve(
  __dirname,
  "fixtures",
  "domain-separators-parity.json",
);

interface FixtureEntry {
  label: string;
  label_utf8_hex_lower: string;
  keccak256_hex_lower: string;
  byte_length: number;
  note?: string;
}

interface Fixture {
  [k: string]: FixtureEntry | unknown;
}

const fixture: Fixture = JSON.parse(readFileSync(FIXTURE_PATH, "utf-8"));

describe("Domain separator parity (TS vs fixture)", () => {
  it("DOMAIN_SEPARATOR_SIMULATE matches the fixture byte-for-byte", () => {
    const fx = fixture["DOMAIN_SEPARATOR_SIMULATE"] as FixtureEntry;
    // The TS constant is the 32-byte keccak256(label) hex
    expect(DOMAIN_SEPARATOR_SIMULATE.toLowerCase()).toBe(
      fx.keccak256_hex_lower.toLowerCase(),
    );
    // Re-derive keccak from the label utf-8 hex and confirm it matches
    expect(keccak256(toHex(fx.label)).toLowerCase()).toBe(
      fx.keccak256_hex_lower.toLowerCase(),
    );
    // Byte length is 32 (keccak output)
    const hexNoPrefix = fx.keccak256_hex_lower.startsWith("0x")
      ? fx.keccak256_hex_lower.slice(2)
      : fx.keccak256_hex_lower;
    expect(hexNoPrefix.length / 2).toBe(fx.byte_length);
    expect(fx.byte_length).toBe(32);
    // The TS label string matches the fixture label
    expect(DOMAIN_LABEL_SIMULATE).toBe(fx.label);
  });

  it("the set of separators in TS matches the set in the fixture", () => {
    const tsKeys = new Set(Object.keys(allDomainSeparators()));
    const fxKeys = new Set(
      Object.keys(fixture).filter((k) => !k.startsWith("_")),
    );
    expect(tsKeys).toEqual(fxKeys);
  });

  it("each fixture entry's label round-trips to the declared utf8 + keccak hex", () => {
    for (const [name, entry] of Object.entries(fixture)) {
      if (name.startsWith("_")) continue;
      const fx = entry as FixtureEntry;
      // utf8 hex of the label
      const actualUtf8Hex = toHex(fx.label).toLowerCase();
      expect(actualUtf8Hex).toBe(fx.label_utf8_hex_lower.toLowerCase());
      // keccak256 of the label
      const actualKeccak = keccak256(toHex(fx.label)).toLowerCase();
      expect(actualKeccak).toBe(fx.keccak256_hex_lower.toLowerCase());
    }
  });

  it("DOMAIN_LABEL_SIMULATE is exported and matches allDomainLabels", () => {
    expect(DOMAIN_LABEL_SIMULATE).toBe("PaladinFi/simulate/v2");
    expect(allDomainLabels()).toEqual({ DOMAIN_LABEL_SIMULATE });
  });
});
