// Smoke test: hit live /v1/trust-check/preview via the built package
// Run: node smoke-test.mjs

import { PaladinTrustClient } from "./dist/client.js";

const client = new PaladinTrustClient({
  apiBase: "https://swap.paladinfi.com",
  mode: "preview",
  defaultChainId: 8453,
});

const usdc = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";

try {
  const r = await client.preview({ address: usdc, chainId: 8453 });
  console.log("✓ smoke-test passed");
  console.log("  recommendation:", r.trust.recommendation);
  console.log("  factors:", r.trust.factors.length);
  console.log("  preview:", r.trust._preview);
  console.log("  request_id:", r.request_id);
  process.exit(0);
} catch (e) {
  console.error("✗ smoke-test failed:", e.message);
  process.exit(1);
}
