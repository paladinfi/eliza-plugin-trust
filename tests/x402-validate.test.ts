import { describe, expect, it } from "vitest";
import { validatePaladinContext } from "../src/x402/validate.js";
import {
  PALADIN_TREASURY,
  BASE_USDC,
  BASE_NETWORK,
  USDC_DOMAIN_NAME,
  USDC_DOMAIN_VERSION,
  X402_VERSION,
  MAX_VALIDITY_SECONDS,
  MAX_TRUST_CHECK_AMOUNT,
} from "../src/x402/constants.js";

/**
 * Build a happy-path context that mirrors PaladinFi's real /v1/trust-check
 * 402 challenge (verified empirically via the 2026-05-03 spike).
 */
function happyContext() {
  return {
    paymentRequired: { x402Version: X402_VERSION },
    selectedRequirements: {
      scheme: "exact",
      network: BASE_NETWORK,
      asset: BASE_USDC,
      payTo: PALADIN_TREASURY,
      amount: "1000",
      maxTimeoutSeconds: 300,
      extra: {
        name: USDC_DOMAIN_NAME,
        version: USDC_DOMAIN_VERSION,
      },
    },
  };
}

describe("validatePaladinContext", () => {
  it("accepts the happy-path PaladinFi challenge", () => {
    const r = validatePaladinContext(happyContext());
    expect(r.ok).toBe(true);
    expect(r.reason).toBeUndefined();
  });

  it("accepts EIP-55 mixed-case asset address (case insensitive)", () => {
    const c = happyContext();
    c.selectedRequirements.asset = BASE_USDC.toLowerCase() as typeof BASE_USDC;
    expect(validatePaladinContext(c).ok).toBe(true);
  });

  it("rejects wrong x402Version (downgrade to v1)", () => {
    const c = happyContext();
    c.paymentRequired.x402Version = 1;
    const r = validatePaladinContext(c);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/x402Version/);
  });

  it("rejects wrong x402Version (upgrade to v3)", () => {
    const c = happyContext();
    c.paymentRequired.x402Version = 3;
    expect(validatePaladinContext(c).ok).toBe(false);
  });

  it("rejects Permit2 assetTransferMethod (downgrade vector)", () => {
    const c = happyContext();
    (c.selectedRequirements.extra as Record<string, unknown>).assetTransferMethod = "permit2";
    const r = validatePaladinContext(c);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/assetTransferMethod/);
  });

  it("rejects wrong scheme", () => {
    const c = happyContext();
    (c.selectedRequirements as Record<string, unknown>).scheme = "upto";
    expect(validatePaladinContext(c).ok).toBe(false);
  });

  it("rejects wrong network (Ethereum mainnet instead of Base)", () => {
    const c = happyContext();
    (c.selectedRequirements as Record<string, unknown>).network = "eip155:1";
    const r = validatePaladinContext(c);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/network/);
  });

  it("rejects wrong asset (DAI instead of USDC)", () => {
    const c = happyContext();
    (c.selectedRequirements as Record<string, unknown>).asset =
      "0x6B175474E89094C44Da98b954EedeAC495271d0F"; // DAI mainnet — wrong asset and wrong chain
    const r = validatePaladinContext(c);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/asset/);
  });

  it("rejects wrong payTo (attacker treasury)", () => {
    const c = happyContext();
    (c.selectedRequirements as Record<string, unknown>).payTo =
      "0x0000000000000000000000000000000000000001";
    const r = validatePaladinContext(c);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/payTo/);
  });

  it("rejects amount over cap", () => {
    const c = happyContext();
    (c.selectedRequirements as Record<string, unknown>).amount = String(
      MAX_TRUST_CHECK_AMOUNT + 1n,
    );
    const r = validatePaladinContext(c);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/exceeds cap/);
  });

  it("rejects zero or negative amount", () => {
    const c = happyContext();
    (c.selectedRequirements as Record<string, unknown>).amount = "0";
    const r = validatePaladinContext(c);
    expect(r.ok).toBe(false);
  });

  it("rejects non-numeric amount", () => {
    const c = happyContext();
    (c.selectedRequirements as Record<string, unknown>).amount = "free";
    const r = validatePaladinContext(c);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/not a valid bigint/);
  });

  it("rejects long-lived validity (1 year)", () => {
    const c = happyContext();
    (c.selectedRequirements as Record<string, unknown>).maxTimeoutSeconds =
      365 * 24 * 60 * 60;
    const r = validatePaladinContext(c);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/maxTimeoutSeconds/);
  });

  it("accepts validity at the boundary", () => {
    const c = happyContext();
    (c.selectedRequirements as Record<string, unknown>).maxTimeoutSeconds =
      MAX_VALIDITY_SECONDS;
    expect(validatePaladinContext(c).ok).toBe(true);
  });

  it("rejects spoofed EIP-712 domain name", () => {
    const c = happyContext();
    (c.selectedRequirements.extra as Record<string, unknown>).name = "Tether USD";
    const r = validatePaladinContext(c);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/extra\.name/);
  });

  it("rejects spoofed EIP-712 domain version", () => {
    const c = happyContext();
    (c.selectedRequirements.extra as Record<string, unknown>).version = "1";
    const r = validatePaladinContext(c);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/extra\.version/);
  });

  it("rejects empty / undefined context", () => {
    expect(validatePaladinContext(undefined).ok).toBe(false);
    expect(validatePaladinContext({}).ok).toBe(false);
    expect(
      validatePaladinContext({
        paymentRequired: { x402Version: X402_VERSION },
      }).ok,
    ).toBe(false);
  });
});
