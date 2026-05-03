import { describe, expect, it } from "vitest";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { createPaladinTrustPlugin } from "../src/index.js";
import { PaladinTrustClient } from "../src/client.js";

describe("createPaladinTrustPlugin boot-time validation", () => {
  it("succeeds in preview mode without options", () => {
    const plugin = createPaladinTrustPlugin();
    expect(plugin.name).toBe("paladin-trust");
    expect(plugin.actions).toBeDefined();
    expect(plugin.actions?.length).toBe(1);
  });

  it("succeeds in paid mode with a LocalAccount", () => {
    const account = privateKeyToAccount(generatePrivateKey());
    const plugin = createPaladinTrustPlugin({ walletClientAccount: account });
    expect(plugin.name).toBe("paladin-trust");
    expect(plugin.actions?.length).toBe(1);
  });

  it("throws when paid mode is requested without walletClientAccount", () => {
    expect(() => createPaladinTrustPlugin({ mode: "paid" })).toThrow(
      /paid mode requires walletClientAccount/,
    );
  });

  it("throws when walletClientAccount lacks signTypedData", () => {
    const fakeAccount = { address: "0xabc" } as unknown as Parameters<
      typeof createPaladinTrustPlugin
    >[0]["walletClientAccount"];
    expect(() =>
      createPaladinTrustPlugin({ mode: "paid", walletClientAccount: fakeAccount }),
    ).toThrow(/must be a LocalAccount with signTypedData/);
  });

  it("infers paid mode from walletClientAccount presence", () => {
    const account = privateKeyToAccount(generatePrivateKey());
    // No explicit mode, but walletClientAccount provided → mode should be paid
    expect(() => createPaladinTrustPlugin({ walletClientAccount: account })).not.toThrow();
  });

  it("rejects non-HTTPS apiBase in paid mode", () => {
    const account = privateKeyToAccount(generatePrivateKey());
    expect(() =>
      createPaladinTrustPlugin({
        walletClientAccount: account,
        apiBase: "http://swap.paladinfi.com",
      }),
    ).toThrow(/paid mode requires https/);
  });

  it("allows non-HTTPS apiBase in preview mode (no walletClientAccount)", () => {
    expect(() =>
      createPaladinTrustPlugin({ apiBase: "http://localhost:3000" }),
    ).not.toThrow();
  });
});

describe("PaladinTrustClient HTTPS gate (defense in depth)", () => {
  it("throws when constructed in paid mode with non-HTTPS apiBase", () => {
    const account = privateKeyToAccount(generatePrivateKey());
    expect(
      () =>
        new PaladinTrustClient({
          apiBase: "http://attacker.example",
          mode: "paid",
          defaultChainId: 8453,
          walletClientAccount: account,
        }),
    ).toThrow(/paid mode requires https/);
  });

  it("allows non-HTTPS apiBase in preview mode (PaladinTrustClient direct)", () => {
    expect(
      () =>
        new PaladinTrustClient({
          apiBase: "http://localhost:3000",
          mode: "preview",
          defaultChainId: 8453,
        }),
    ).not.toThrow();
  });
});
