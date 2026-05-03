/**
 * Manual paid-mode smoke test against live https://swap.paladinfi.com/v1/trust-check.
 *
 * Uses dist/ output of @paladinfi/eliza-plugin-trust + permanent test wallet
 * (MetaMask Account 4, funded ~$0.10 USDC + dust ETH on Base).
 *
 * Also extracts the settled tx hash from the `payment-response` header (base64 JSON)
 * and prints the Basescan link for documentation. (PaladinTrustClient.paid() returns
 * just the parsed body; for tx hash recovery we call x402-fetch directly here.)
 *
 * Run: `node smoke-paid.mjs` (after `npm run build`, with .env.local populated).
 */

import { readFileSync } from "node:fs";
import { privateKeyToAccount } from "viem/accounts";
import { x402Client, wrapFetchWithPayment } from "@x402/fetch";
import { registerExactEvmScheme } from "@x402/evm/exact/client";
import {
  validatePaladinContext,
  PALADIN_TREASURY,
  BASE_NETWORK,
  BASE_USDC,
} from "./dist/index.js";
// Zod schema is internal; reach into types.js directly for smoke validation
import { trustCheckResponseSchema } from "./dist/types.js";

// --- load key + sanity ----------------------------------------------------
const env = readFileSync(".env.local", "utf8");
const m = env.match(/^PALADIN_TRUST_KEY\s*=\s*(0x[0-9a-fA-F]+)/m);
if (!m) {
  console.error("FAIL: PALADIN_TRUST_KEY not in .env.local");
  process.exit(1);
}
const account = privateKeyToAccount(m[1]);
const expected = "0x18779E54787320aE9Ab997F2ba3fC6E31D2A0aC1";
if (account.address.toLowerCase() !== expected.toLowerCase()) {
  console.error(`FAIL: wrong test wallet ${account.address} (want ${expected})`);
  process.exit(1);
}
console.log("test wallet:", account.address);

// --- build x402 client identical to PaladinTrustClient ---------------------
let hookFired = 0;
const x402 = new x402Client();
registerExactEvmScheme(x402, { signer: account, networks: [BASE_NETWORK] });
x402.onBeforePaymentCreation(async (ctx) => {
  hookFired++;
  const r = validatePaladinContext(ctx);
  if (!r.ok) {
    console.error("hook would abort:", r.reason);
    return { abort: true, reason: r.reason ?? "validation failed" };
  }
  return undefined;
});

const fetchPaid = wrapFetchWithPayment(globalThis.fetch, x402);

// --- live call -------------------------------------------------------------
const target = {
  address: BASE_USDC, // benign target: USDC contract on Base
  chainId: 8453,
};

console.log("\nCalling /v1/trust-check (paid) for", target.address);
const t0 = Date.now();
const res = await fetchPaid("https://swap.paladinfi.com/v1/trust-check", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(target),
});
const dt = Date.now() - t0;

if (!res.ok) {
  console.error(`FAIL: HTTP ${res.status}`);
  console.error(await res.text());
  process.exit(1);
}

// Decode payment-response header → settled tx hash
let settled = null;
const paymentHeader = res.headers.get("payment-response");
if (paymentHeader) {
  try {
    settled = JSON.parse(Buffer.from(paymentHeader, "base64").toString("utf8"));
  } catch {
    /* ignore */
  }
}

// Schema-validate the body
const body = await res.json();
const parsed = trustCheckResponseSchema.safeParse(body);
if (!parsed.success) {
  console.error("FAIL: response failed schema validation");
  console.error("issues:", JSON.stringify(parsed.error.issues, null, 2));
  console.error("raw body:", JSON.stringify(body, null, 2));
  process.exit(1);
}
const response = parsed.data;

console.log(`\n=== PAID CALL SUCCEEDED (${dt}ms) ===`);
console.log("hook invocations:", hookFired);
console.log("recommendation:  ", response.trust.recommendation);
console.log("factors:");
for (const f of response.trust.factors) {
  console.log(`  ${f.source} = ${f.signal} (real: ${f.real})`);
}

if (settled) {
  console.log("\n=== Settled on-chain ===");
  console.log("payer:    ", settled.payer);
  console.log("tx:       ", settled.transaction);
  console.log("network:  ", settled.network);
  console.log("Basescan: ", `https://basescan.org/tx/${settled.transaction}`);
}

// All factors must be real:true on paid (Zod default does this for missing field)
const allReal = response.trust.factors.every((f) => f.real === true);
const isSamplePrefix = String(response.trust.recommendation).startsWith("sample-");
if (!allReal) {
  console.error("\nFAIL: at least one factor real:false on paid path");
  process.exit(1);
}
if (isSamplePrefix) {
  console.error("\nFAIL: paid response should NOT have sample- prefix");
  process.exit(1);
}
if (hookFired !== 1) {
  console.error("\nFAIL: pre-sign hook fired", hookFired, "times (expected exactly 1)");
  process.exit(1);
}

console.log("\n✓ Paid path verified end-to-end (hook fired, real factors, no sample prefix)");
console.log("✓ Treasury for settlement:", PALADIN_TREASURY);
