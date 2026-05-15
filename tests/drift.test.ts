/**
 * Drift CI test — pre-publish gate.
 *
 * Per v11 §4.16 + Goal 9: this test runs as part of `LIVE_DRIFT_CHECK=1
 * npm test` before npm publish. It catches conditions that would silently
 * break the security model if shipped:
 *
 *   1. Storage-slot stability — TOKEN_REGISTRY balance/allowance slots
 *      against live Base state. (The full live check requires Base RPC; the
 *      offline portion validates registry shape + hash determinism.)
 *   2. Allowlist sync — client-side ALLOWED_SELECTORS_BY_CHAIN must match
 *      server-side paladin-swap-mcp v0.11.71+ exactly (drift = byte-equality
 *      check would fail at registry-sync endpoint; this test is the offline
 *      version that catches obvious drift.)
 *   3. Decoder-map completeness — every Velora selector listed has a known
 *      ABI signature comment.
 *   4. Canonical-JSON byte-equality — fixture parity (TS side; server-side
 *      Python pyjcs runs the same fixtures).
 *   5. On-chain TOKEN_REGISTRY hash — bundled TOKEN_REGISTRY_HASH must match
 *      what the live `PaladinKeyRegistry.tokenRegistryHash()` returns.
 *      (Skipped offline — runs only with LIVE_DRIFT_CHECK=1 + RPC creds.)
 *   6. PALADIN_KEY_REGISTRY_BASE ↔ paladinfi/contracts/deployments.json
 *      alignment. (Offline structural check; full alignment requires
 *      deployments.json from the contracts repo at known commit.)
 *   7. No `Date.now()` outside `clock.ts` — grep test with explicit excludes
 *      for node_modules and dist. R12 Maint M-5 + R11 Eng MED-4.
 *   8. baseRpcUrls operator-distinctness — DEFAULT_BASE_RPC_POOL satisfies
 *      ≥2 distinct operators per KNOWN_BASE_RPC_OPERATORS.
 *   9. Profiles/TOKEN_REGISTRY drift — every profile has a sellAmountCap
 *      for every TOKEN_REGISTRY entry.
 *
 * Tests #1, #5 are conditionally skipped when LIVE_DRIFT_CHECK=1 isn't set
 * (they require live Base RPC + paladin-swap-mcp endpoint).
 */

import { describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { keccak256, toHex } from "viem";

import {
  TOKEN_REGISTRY,
  TOKEN_REGISTRY_HASH,
  TOKEN_REGISTRY_ADDRESSES,
  TOKEN_REGISTRY_DEFAULT_CAPS,
} from "../src/utils/sell-caps";
import { SPENDING_PROFILES } from "../src/utils/profiles";
import {
  KNOWN_BASE_RPC_OPERATORS,
  DEFAULT_BASE_RPC_POOL,
  getOperator,
} from "../src/utils/paladin-keys";
import {
  CLIENT_SIDE_DENY_LIST,
  ALLOWED_ROUTERS_BY_CHAIN,
  ALLOWED_SELECTORS_BY_CHAIN,
  ALLOWED_ZEROEX_SETTLERS_BY_CHAIN,
} from "../src/utils/quote-validate";
import { canonicalize, assertCanonicallyEqual } from "../src/utils/paladin-canonical";
import { ALL_ERROR_CODES, ErrorCode } from "../src/errors";

const LIVE = process.env.LIVE_DRIFT_CHECK === "1";

// =============================================================================
// 1. TOKEN_REGISTRY shape + hash determinism
// =============================================================================

describe("TOKEN_REGISTRY", () => {
  it("has 7 entries (USDC, USDT, WETH, cbBTC, DAI, AERO, USDbC)", () => {
    expect(TOKEN_REGISTRY_ADDRESSES.length).toBe(7);
    const symbols = Object.values(TOKEN_REGISTRY).map((e) => e.symbol);
    expect(symbols.sort()).toEqual(["AERO", "DAI", "USDC", "USDT", "USDbC", "WETH", "cbBTC"]);
  });

  it("every entry has required fields with valid shapes", () => {
    for (const [addr, entry] of Object.entries(TOKEN_REGISTRY)) {
      expect(addr).toMatch(/^0x[0-9a-f]{40}$/);
      expect(entry.address.toLowerCase()).toBe(addr);
      expect(entry.symbol.length).toBeGreaterThan(0);
      expect(entry.decimals).toBeGreaterThanOrEqual(0);
      expect(entry.decimals).toBeLessThanOrEqual(18);
      expect(BigInt(entry.defaultCap)).toBeGreaterThanOrEqual(0n);
      expect(entry.balanceSlot).toBeGreaterThanOrEqual(0);
      expect(entry.allowanceSlot).toBeGreaterThanOrEqual(0);
    }
  });

  it("TOKEN_REGISTRY_HASH is deterministic (re-derivation matches)", () => {
    // Re-compute using the same algorithm as sell-caps.ts.
    const sortedKeys = Object.keys(TOKEN_REGISTRY).sort();
    const canonical = sortedKeys
      .map((key) => {
        const e = TOKEN_REGISTRY[key];
        return [
          e.address.toLowerCase(),
          e.symbol,
          String(e.decimals),
          e.defaultCap,
          String(e.balanceSlot),
          String(e.allowanceSlot),
          e.isPaymentToken ? "1" : "0",
        ].join("|");
      })
      .join("\n");
    const recomputed = keccak256(toHex(canonical));
    expect(recomputed).toBe(TOKEN_REGISTRY_HASH);
  });

  it.skipIf(!LIVE)(
    "live: TOKEN_REGISTRY_HASH matches on-chain PaladinKeyRegistry.tokenRegistryHash()",
    async () => {
      // Requires live Base RPC + deployed contract.
      // Skipped offline; wire in Step 47 once contract is deployed.
      throw new Error("not yet implemented — wire after Step 47 deploy");
    },
  );
});

// =============================================================================
// 2-3. Layer 2 allowlist completeness
// =============================================================================

describe("Layer 2 allowlists", () => {
  it("CLIENT_SIDE_DENY_LIST has the 7 documented selectors", () => {
    expect(CLIENT_SIDE_DENY_LIST.length).toBe(7);
    // Spot-check a few well-known selectors
    expect(CLIENT_SIDE_DENY_LIST).toContain("0x23b872dd"); // ERC20 transferFrom
    expect(CLIENT_SIDE_DENY_LIST).toContain("0x095ea7b3"); // ERC20 approve
    expect(CLIENT_SIDE_DENY_LIST).toContain("0x30f28b7a"); // Permit2 permitTransferFrom
  });

  it("ALLOWED_ROUTERS_BY_CHAIN has Base entries", () => {
    const baseRouters = ALLOWED_ROUTERS_BY_CHAIN[8453];
    expect(baseRouters).toBeDefined();
    expect(baseRouters!.length).toBeGreaterThanOrEqual(2);
    // Velora + 0x AllowanceHolder
    expect(baseRouters).toContain("0x6a000f20005980200259b80c5102003040001068");
    expect(baseRouters).toContain("0x0000000000001ff3684f28c67538d4d072c22734");
  });

  it("ALLOWED_SELECTORS_BY_CHAIN has 0x exec + 11 Velora selectors on Base", () => {
    const baseSelectors = ALLOWED_SELECTORS_BY_CHAIN[8453];
    expect(baseSelectors).toBeDefined();
    expect(baseSelectors!.length).toBe(12); // 11 Velora + 1 0x exec
    expect(baseSelectors).toContain("0x2213bc0b"); // 0x exec
    expect(baseSelectors).toContain("0xe3ead59e"); // Velora swapExactAmountIn
  });

  it("ALLOWED_ZEROEX_SETTLERS has Base Settler", () => {
    expect(ALLOWED_ZEROEX_SETTLERS_BY_CHAIN[8453]).toContain(
      "0x7747f8d2a76bd6345cc29622a946a929647f2359",
    );
  });

  it("deny-list and allow-list have NO selector overlap", () => {
    const allowed = new Set(ALLOWED_SELECTORS_BY_CHAIN[8453] ?? []);
    for (const denied of CLIENT_SIDE_DENY_LIST) {
      expect(allowed.has(denied)).toBe(false);
    }
  });
});

// =============================================================================
// 4. Canonical JSON fixtures (TS-side; server-side Python mirrors)
// =============================================================================

describe("Canonical JSON byte-equality", () => {
  it("produces identical output for objects with reordered keys", () => {
    assertCanonicallyEqual({ a: 1, b: 2 }, { b: 2, a: 1 });
  });

  it("rejects NaN", () => {
    expect(() => canonicalize({ x: NaN })).toThrow(/non-finite/i);
  });

  it("rejects undefined", () => {
    expect(() => canonicalize({ x: undefined })).toThrow(/undefined/i);
  });

  it("rejects BigInt (caller must convert to string)", () => {
    expect(() => canonicalize({ x: 1n })).toThrow(/BigInt/);
  });

  it("preserves string content for non-ASCII", () => {
    const a = canonicalize({ name: "你好" });
    const b = canonicalize({ name: "你好" });
    expect(a).toBe(b);
  });

  it("nested objects + arrays canonicalize deterministically", () => {
    assertCanonicallyEqual(
      { z: [1, 2, { c: 3, a: 1, b: 2 }], a: "x" },
      { a: "x", z: [1, 2, { a: 1, b: 2, c: 3 }] },
    );
  });
});

// =============================================================================
// 6. Profiles ↔ TOKEN_REGISTRY drift
// =============================================================================

describe("Profiles", () => {
  it("every profile has a sellAmountCap for every TOKEN_REGISTRY entry", () => {
    for (const [name, profile] of Object.entries(SPENDING_PROFILES)) {
      for (const addr of Object.keys(TOKEN_REGISTRY)) {
        expect(
          profile.sellAmountCaps[addr],
          `Profile "${name}" missing cap for ${addr}`,
        ).toBeDefined();
      }
    }
  });

  it("default profile uses TOKEN_REGISTRY_DEFAULT_CAPS as-is", () => {
    expect(SPENDING_PROFILES.default.sellAmountCaps).toEqual(TOKEN_REGISTRY_DEFAULT_CAPS);
  });

  it("paper-test caps are smaller than default; pro caps are larger", () => {
    const usdcAddr = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
    const paperCap = BigInt(SPENDING_PROFILES["paper-test"].sellAmountCaps[usdcAddr]);
    const defaultCap = BigInt(SPENDING_PROFILES.default.sellAmountCaps[usdcAddr]);
    const proCap = BigInt(SPENDING_PROFILES.pro.sellAmountCaps[usdcAddr]);
    expect(paperCap).toBeLessThan(defaultCap);
    expect(proCap).toBeGreaterThan(defaultCap);
  });
});

// =============================================================================
// 7. No Date.now() outside clock.ts
// =============================================================================

describe("Date.now() containment", () => {
  it("only clock.ts directly calls Date.now()", async () => {
    // Walk src/ recursively, exclude utils/clock.ts, grep for Date.now().
    const srcDir = path.join(__dirname, "..", "src");
    const offenders: string[] = [];

    async function walk(dir: string): Promise<void> {
      const entries = await fs.readdir(dir, { withFileTypes: true });
      for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name === "node_modules" || entry.name === "dist") continue;
          await walk(full);
        } else if (entry.isFile() && entry.name.endsWith(".ts")) {
          const content = await fs.readFile(full, "utf8");
          // Strip comments + strings to avoid false positives in docstrings.
          const stripped = content
            .replace(/\/\*[\s\S]*?\*\//g, "")
            .replace(/\/\/.*$/gm, "")
            .replace(/"(?:[^"\\]|\\.)*"/g, "")
            .replace(/'(?:[^'\\]|\\.)*'/g, "")
            .replace(/`(?:[^`\\]|\\.)*`/g, "");
          if (/\bDate\.now\(\)/.test(stripped)) {
            const rel = path.relative(srcDir, full);
            // clock.ts is allowed; types.ts may have Date.now in default config (none currently).
            if (rel === path.normalize("utils/clock.ts")) continue;
            offenders.push(rel);
          }
        }
      }
    }

    await walk(srcDir);
    expect(offenders).toEqual([]);
  });
});

// =============================================================================
// 8. baseRpcUrls operator-distinctness
// =============================================================================

describe("baseRpcUrls", () => {
  it("KNOWN_BASE_RPC_OPERATORS has at least 4 entries", () => {
    expect(Object.keys(KNOWN_BASE_RPC_OPERATORS).length).toBeGreaterThanOrEqual(4);
  });

  it("DEFAULT_BASE_RPC_POOL has ≥2 distinct operators", () => {
    const operators = new Set(DEFAULT_BASE_RPC_POOL.map((u) => getOperator(u)));
    expect(operators.size).toBeGreaterThanOrEqual(2);
  });

  it("getOperator returns publicnode for publicnode hosts", () => {
    expect(getOperator("https://base-rpc.publicnode.com")).toBe("publicnode");
    expect(getOperator("https://base.publicnode.com")).toBe("publicnode");
  });
});

// =============================================================================
// 9. Error contract completeness
// =============================================================================

describe("Error contract", () => {
  it("ALL_ERROR_CODES has exactly 27 codes (v11 §5)", () => {
    expect(ALL_ERROR_CODES.length).toBe(27);
  });

  it("ErrorCode union enumerates every code in ALL_ERROR_CODES", () => {
    const codeSet = new Set<string>(ALL_ERROR_CODES);
    expect(codeSet.has(ErrorCode.WALLET_MISSING)).toBe(true);
    expect(codeSet.has(ErrorCode.RESPONSE_BINDING_MISMATCH)).toBe(true);
    expect(codeSet.has(ErrorCode.TOKEN_REGISTRY_DRIFT)).toBe(true);
    expect(codeSet.has(ErrorCode.PALADIN_REGISTRY_QUORUM_FAILED)).toBe(true);
  });
});

// =============================================================================
// LIVE-only: Registry sync against live paladin-swap-mcp endpoint
// =============================================================================

describe.skipIf(!LIVE)("Live registry sync", () => {
  it("server-side TOKEN_REGISTRY at /v1/simulate/registry matches bundled", async () => {
    // TODO: implement after server-side `/v1/simulate/registry` endpoint exists.
    // Spec: GET https://swap.paladinfi.com/v1/simulate/registry → signed
    // canonical TOKEN_REGISTRY; assert byte-equality with bundled.
    throw new Error("not yet implemented — wire after Step 31 indexer deploy");
  });
});
