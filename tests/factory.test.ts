/**
 * Factory construction-time gates — v0.2.0 `paladinSwapEnabled` opt-in path.
 *
 * v0.1.0 paid-mode gates are covered by `boot-validation.test.ts`. This
 * file owns the v0.2.0 paladin_swap-specific construction-time invariants
 * documented in v11 §4.2 + index.ts JSDoc:
 *   - clockOverride + NODE_ENV=production guard (R11 Sec MED-1 supply-chain)
 *   - paladinSwapEnabled requires walletClientAccount
 *   - paladinSwapEnabled requires acknowledgeRisks=true
 *   - simulationVerifier='tenderly'|'both' requires tenderlyConfig
 *   - tenderlyConfig with mismatched accountChecksum throws (typosquatting defense)
 *   - keyTrustMode='pinned' requires pinnedPair
 *   - paladinSwapEnabled=false produces a plugin without paladin_swap action
 */

import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { privateKeyToAccount } from "viem/accounts";
import { keccak256, toHex, type Hex } from "viem";
import { createPaladinTrustPlugin } from "../src";

const TEST_PK: Hex = "0x" + "11".repeat(32) as Hex;
const ACCOUNT = privateKeyToAccount(TEST_PK);

function tenderlyConfigFor(user: string, project: string) {
  return {
    user,
    project,
    accessKey: "test-access-key",
    accountChecksum: keccak256(toHex(`${user}:${project}`)) as Hex,
  };
}

describe("createPaladinTrustPlugin — v0.2.0 paladinSwapEnabled gates", () => {
  describe("clockOverride production guardrail (R11 Sec MED-1)", () => {
    let originalNodeEnv: string | undefined;

    beforeEach(() => {
      originalNodeEnv = process.env.NODE_ENV;
    });

    afterEach(() => {
      if (originalNodeEnv === undefined) {
        delete process.env.NODE_ENV;
      } else {
        process.env.NODE_ENV = originalNodeEnv;
      }
    });

    it("throws when clockOverride is set with NODE_ENV=production", () => {
      process.env.NODE_ENV = "production";
      const fakeClock = { now: () => 1717000000_000 };
      expect(() =>
        createPaladinTrustPlugin({
          mode: "preview",
          clockOverride: fakeClock,
        }),
      ).toThrow(/clockOverride is TEST-ONLY/);
    });

    it("allows clockOverride when NODE_ENV is unset", () => {
      delete process.env.NODE_ENV;
      const fakeClock = { now: () => 1717000000_000 };
      expect(() =>
        createPaladinTrustPlugin({
          mode: "preview",
          clockOverride: fakeClock,
        }),
      ).not.toThrow();
    });

    it("allows clockOverride when NODE_ENV=development", () => {
      process.env.NODE_ENV = "development";
      const fakeClock = { now: () => 1717000000_000 };
      expect(() =>
        createPaladinTrustPlugin({
          mode: "preview",
          clockOverride: fakeClock,
        }),
      ).not.toThrow();
    });

    it("allows clockOverride when NODE_ENV=test", () => {
      process.env.NODE_ENV = "test";
      const fakeClock = { now: () => 1717000000_000 };
      expect(() =>
        createPaladinTrustPlugin({
          mode: "preview",
          clockOverride: fakeClock,
        }),
      ).not.toThrow();
    });
  });

  describe("paladinSwapEnabled wallet + acknowledgement gates", () => {
    it("paladinSwapEnabled=true throws WALLET_MISSING without walletClientAccount", () => {
      expect(() =>
        createPaladinTrustPlugin({
          paladinSwapEnabled: true,
          acknowledgeRisks: true,
        }),
      ).toThrow(/requires walletClientAccount/);
    });

    it("paladinSwapEnabled=true throws RESIDUAL_NOT_ACKNOWLEDGED without acknowledgeRisks=true", () => {
      expect(() =>
        createPaladinTrustPlugin({
          paladinSwapEnabled: true,
          walletClientAccount: ACCOUNT,
        }),
      ).toThrow(/requires acknowledgeRisks=true/);
    });

    it("paladinSwapEnabled=true with acknowledgeRisks=false throws", () => {
      expect(() =>
        createPaladinTrustPlugin({
          paladinSwapEnabled: true,
          walletClientAccount: ACCOUNT,
          acknowledgeRisks: false,
        }),
      ).toThrow(/requires acknowledgeRisks=true/);
    });

    it("paladinSwapEnabled=true succeeds with wallet + acknowledgement", () => {
      const plugin = createPaladinTrustPlugin({
        paladinSwapEnabled: true,
        walletClientAccount: ACCOUNT,
        acknowledgeRisks: true,
      });
      expect(plugin.actions?.length ?? 0).toBeGreaterThanOrEqual(2);
    });
  });

  describe("paladinSwapEnabled=false leaves paladin_swap unwired", () => {
    it("plugin without paladinSwapEnabled has only trust-check action", () => {
      const plugin = createPaladinTrustPlugin({
        mode: "preview",
      });
      const actionNames = (plugin.actions ?? []).map((a) => a.name);
      // Trust-check action ships in v0.1.0; only its own action is present.
      expect(actionNames.some((n) => /trust/i.test(n))).toBe(true);
      expect(actionNames.some((n) => /paladin_swap|paladin-swap/i.test(n))).toBe(false);
    });

    it("paid-mode plugin without paladinSwapEnabled has only trust-check action", () => {
      const plugin = createPaladinTrustPlugin({
        walletClientAccount: ACCOUNT,
      });
      const actionNames = (plugin.actions ?? []).map((a) => a.name);
      expect(actionNames.some((n) => /paladin_swap|paladin-swap/i.test(n))).toBe(false);
    });

    it("paladinSwapEnabled=true adds paladin_swap to actions", () => {
      const plugin = createPaladinTrustPlugin({
        paladinSwapEnabled: true,
        walletClientAccount: ACCOUNT,
        acknowledgeRisks: true,
      });
      const actionNames = (plugin.actions ?? []).map((a) => a.name);
      expect(actionNames.some((n) => /paladin_swap|PALADIN_SWAP/i.test(n))).toBe(true);
    });
  });

  describe("simulationVerifier requires tenderlyConfig", () => {
    it("simulationVerifier='tenderly' without tenderlyConfig throws", () => {
      expect(() =>
        createPaladinTrustPlugin({
          paladinSwapEnabled: true,
          walletClientAccount: ACCOUNT,
          acknowledgeRisks: true,
          simulationVerifier: "tenderly",
        }),
      ).toThrow(/tenderlyConfig/);
    });

    it("simulationVerifier='both' without tenderlyConfig throws", () => {
      expect(() =>
        createPaladinTrustPlugin({
          paladinSwapEnabled: true,
          walletClientAccount: ACCOUNT,
          acknowledgeRisks: true,
          simulationVerifier: "both",
        }),
      ).toThrow(/tenderlyConfig/);
    });

    it("simulationVerifier='paladin-multikey' (default) does not require tenderlyConfig", () => {
      expect(() =>
        createPaladinTrustPlugin({
          paladinSwapEnabled: true,
          walletClientAccount: ACCOUNT,
          acknowledgeRisks: true,
          simulationVerifier: "paladin-multikey",
        }),
      ).not.toThrow();
    });

    it("simulationVerifier='tenderly' with valid tenderlyConfig succeeds", () => {
      expect(() =>
        createPaladinTrustPlugin({
          paladinSwapEnabled: true,
          walletClientAccount: ACCOUNT,
          acknowledgeRisks: true,
          simulationVerifier: "tenderly",
          tenderlyConfig: tenderlyConfigFor("alice", "myproject"),
        }),
      ).not.toThrow();
    });
  });

  describe("tenderlyConfig accountChecksum (typosquatting defense)", () => {
    it("rejects tenderlyConfig with mismatched accountChecksum", () => {
      const config = tenderlyConfigFor("alice", "real-project");
      // Corrupt the checksum — caller's claim doesn't match user/project.
      const tampered = {
        ...config,
        accountChecksum:
          ("0x" + "ff".repeat(32)) as Hex,
      };
      expect(() =>
        createPaladinTrustPlugin({
          paladinSwapEnabled: true,
          walletClientAccount: ACCOUNT,
          acknowledgeRisks: true,
          simulationVerifier: "tenderly",
          tenderlyConfig: tampered,
        }),
      ).toThrow();
    });

    it("rejects when user changes but checksum stale", () => {
      // accountChecksum was computed for ('alice', 'project') — but user is
      // now 'eve'. Checksum doesn't recompute to match → typosquatting flag.
      const original = tenderlyConfigFor("alice", "project");
      const swapped = { ...original, user: "eve" };
      expect(() =>
        createPaladinTrustPlugin({
          paladinSwapEnabled: true,
          walletClientAccount: ACCOUNT,
          acknowledgeRisks: true,
          simulationVerifier: "tenderly",
          tenderlyConfig: swapped,
        }),
      ).toThrow();
    });

    it("accepts tenderlyConfig where checksum matches keccak256(user:project)", () => {
      expect(() =>
        createPaladinTrustPlugin({
          paladinSwapEnabled: true,
          walletClientAccount: ACCOUNT,
          acknowledgeRisks: true,
          simulationVerifier: "tenderly",
          tenderlyConfig: tenderlyConfigFor("paladinfi-prod", "swap-router"),
        }),
      ).not.toThrow();
    });
  });

  describe("keyTrustMode='pinned' requires pinnedPair", () => {
    it("keyTrustMode='pinned' without pinnedPair throws", () => {
      expect(() =>
        createPaladinTrustPlugin({
          paladinSwapEnabled: true,
          walletClientAccount: ACCOUNT,
          acknowledgeRisks: true,
          keyTrustMode: "pinned",
        }),
      ).toThrow(/pinnedPair/);
    });

    it("keyTrustMode='pinned' with pinnedPair succeeds", () => {
      expect(() =>
        createPaladinTrustPlugin({
          paladinSwapEnabled: true,
          walletClientAccount: ACCOUNT,
          acknowledgeRisks: true,
          keyTrustMode: "pinned",
          pinnedPair: {
            aws: "0x1111111111111111111111111111111111111111" as Hex,
            gcp: "0x2222222222222222222222222222222222222222" as Hex,
          },
        }),
      ).not.toThrow();
    });

    it("keyTrustMode='auto-rotate' (default) does not require pinnedPair", () => {
      expect(() =>
        createPaladinTrustPlugin({
          paladinSwapEnabled: true,
          walletClientAccount: ACCOUNT,
          acknowledgeRisks: true,
          keyTrustMode: "auto-rotate",
        }),
      ).not.toThrow();
    });
  });

  describe("apiBase HTTPS enforcement (extends from v0.1.0 to v0.2.0 paid)", () => {
    it("paladinSwapEnabled=true with non-HTTPS apiBase throws", () => {
      expect(() =>
        createPaladinTrustPlugin({
          paladinSwapEnabled: true,
          walletClientAccount: ACCOUNT,
          acknowledgeRisks: true,
          apiBase: "http://insecure.local",
        }),
      ).toThrow(/https/i);
    });
  });
});
