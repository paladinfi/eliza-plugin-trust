/**
 * Smoke variant: call /v1/trust-check via the production `PaladinTrustClient.paid()`
 * API directly (not the underlying x402 stack). Confirms the schema fix landed
 * in the codepath consumers will actually use.
 */
import { readFileSync } from "node:fs";
import { privateKeyToAccount } from "viem/accounts";
import { PaladinTrustClient } from "./dist/index.js";

const env = readFileSync(".env.local", "utf8");
const m = env.match(/^PALADIN_TRUST_KEY\s*=\s*(0x[0-9a-fA-F]+)/m);
const account = privateKeyToAccount(m[1]);

const client = new PaladinTrustClient({
  apiBase: "https://swap.paladinfi.com",
  mode: "paid",
  defaultChainId: 8453,
  walletClientAccount: account,
});

console.log("calling client.paid() against live /v1/trust-check ...");
const t0 = Date.now();
const res = await client.paid({
  address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  chainId: 8453,
});
console.log(`(${Date.now() - t0}ms)`);
console.log("recommendation:", res.trust.recommendation);
console.log("factors:", res.trust.factors.length);
console.log("all real:", res.trust.factors.every((f) => f.real === true));
console.log("✓ PaladinTrustClient.paid() API works end-to-end");
