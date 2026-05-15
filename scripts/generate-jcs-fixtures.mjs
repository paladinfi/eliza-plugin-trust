// Generate the cross-language JCS fixture file.
//
// Produces tests/fixtures/jcs-fixtures.json containing 50 named fixtures,
// each with `input` (the value to canonicalize) and `expected_canonical`
// (the byte-identical RFC 8785 JSON string both TS @truestamp/canonify
// and Python pyjcs MUST produce).
//
// Generator uses TS @truestamp/canonify as the ground truth. Python side's
// paladin_simulator_canonical (which wraps pyjcs) MUST match every entry —
// drift indicates a real RFC 8785 implementation divergence between the
// two languages.
//
// Run: node scripts/generate-jcs-fixtures.mjs
// Output: tests/fixtures/jcs-fixtures.json + a copy to ../paladin-server/tests/fixtures/

import { canonify } from "@truestamp/canonify";
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = resolve(__dirname, "..");
const SERVER_FIXTURES = resolve(REPO_ROOT, "..", "paladin-server", "tests", "fixtures");

const USDC = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
const WETH = "0x4200000000000000000000000000000000000006";
const USDT = "0xfde4c96c8593536e31f229ea8f37b2ada2699bb2";
const TAKER = "0xea8c33d018760d034384e92d1b2a7cf0338834b4";
const JS_MAX_SAFE_INT = 9007199254740991; // 2^53 - 1

// ----------------------------------------------------------------------------
// Fixture definitions — 50 entries spanning RFC 8785 edge cases + production
// payload shapes. Each entry is {name, input}; expected_canonical is computed
// below by canonify(input).
// ----------------------------------------------------------------------------

const fixtures = [
  // -- Primitives (10) -----------------------------------------------------
  { name: "primitive/null", input: null },
  { name: "primitive/true", input: true },
  { name: "primitive/false", input: false },
  { name: "primitive/empty-string", input: "" },
  { name: "primitive/simple-string", input: "hello" },
  { name: "primitive/zero", input: 0 },
  { name: "primitive/positive-int", input: 1 },
  { name: "primitive/negative-int", input: -1 },
  { name: "primitive/js-max-safe-int", input: JS_MAX_SAFE_INT },
  { name: "primitive/negative-js-max-safe-int", input: -JS_MAX_SAFE_INT },

  // -- Strings: unicode + escaping (10) ------------------------------------
  // (Unicode literals are kept as inline characters where they're printable;
  // control characters use \u escape sequences explicitly to avoid invalid
  // source-file bytes.)
  { name: "string/emoji", input: "\u{1F44D}" }, // 👍
  { name: "string/cjk", input: "你好" }, // 你好
  { name: "string/quote-escape", input: 'has "quote" inside' },
  { name: "string/backslash-escape", input: "has \\ backslash" },
  { name: "string/tab-control", input: "a\tb" },
  { name: "string/newline-control", input: "a\nb" },
  { name: "string/carriage-return", input: "a\rb" },
  { name: "string/form-feed", input: "a\fb" },
  { name: "string/zero-width-space", input: "a​b" },
  { name: "string/surrogate-pair-math-bold-A", input: "\u{1D400}" }, // U+1D400

  // -- Arrays (5) ----------------------------------------------------------
  { name: "array/empty", input: [] },
  { name: "array/single-null", input: [null] },
  { name: "array/mixed-primitives", input: [1, "two", true, null] },
  { name: "array/nested", input: [[1, 2], [3, 4]] },
  { name: "array/of-objects", input: [{ a: 1 }, { b: 2 }] },

  // -- Objects: key ordering + nesting (10) --------------------------------
  { name: "object/empty", input: {} },
  { name: "object/single-key", input: { a: 1 } },
  {
    name: "object/key-ordering-2",
    input: { b: 2, a: 1 },
  },
  {
    name: "object/key-ordering-5",
    input: { e: 5, c: 3, a: 1, d: 4, b: 2 },
  },
  {
    name: "object/nested",
    input: { outer: { inner: { deep: "value" } } },
  },
  {
    name: "object/address-key-lowercase",
    input: { [USDC]: "100000000" },
  },
  {
    name: "object/unicode-key-cjk",
    input: { "日本": 1, "中文": 2 }, // 日本, 中文
  },
  {
    name: "object/empty-values",
    input: { a: "", b: null, c: [], d: {} },
  },
  {
    name: "object/deeply-nested-5-levels",
    input: { l1: { l2: { l3: { l4: { l5: "deep" } } } } },
  },
  {
    name: "object/wide-20-keys",
    input: Object.fromEntries(
      "abcdefghijklmnopqrst".split("").map((k, i) => [k, i]),
    ),
  },

  // -- Production payload shapes (10) --------------------------------------
  {
    name: "production/trust-state-pair",
    input: {
      pair: {
        aws: "0x1111111111111111111111111111111111111111",
        gcp: "0x2222222222222222222222222222222222222222",
      },
      epoch: 5,
      tokenRegistryHash:
        "0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890",
    },
  },
  {
    name: "production/simulate-request-pre-bind",
    input: {
      apiVersion: "paladin-simulate-v1",
      takerAddress: TAKER,
      sellToken: USDC,
      buyToken: WETH,
      sellAmount: "1000000",
      minBuyAmount: "29700000000000000",
      chainId: 8453,
      routerAddress: "0x0000000000001ff3684f28c67538d4d072c22734",
      calldata: "0x2213bc0b" + "0".repeat(192),
      valueWei: "0",
    },
  },
  {
    name: "production/simulate-request-with-binding",
    input: {
      apiVersion: "paladin-simulate-v1",
      takerAddress: TAKER,
      sellToken: USDC,
      buyToken: WETH,
      sellAmount: "1000000",
      minBuyAmount: "29700000000000000",
      chainId: 8453,
      routerAddress: "0x0000000000001ff3684f28c67538d4d072c22734",
      calldata: "0x2213bc0b" + "0".repeat(192),
      valueWei: "0",
      clientNonce:
        "0xabababababababababababababababababababababababababababababababab",
      requestHash:
        "0xcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcd",
    },
  },
  {
    name: "production/signed-payload",
    input: {
      apiVersion: "paladin-simulate-v1",
      epoch: 5,
      requestHash:
        "0xcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcd",
      clientNonce:
        "0xabababababababababababababababababababababababababababababababab",
      signedAt: 1717000000,
      serverObservedTokenRegistryHash:
        "0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef",
      ok: true,
    },
  },
  {
    name: "production/multi-token-deltas",
    input: {
      [USDC]: "-1000000",
      [WETH]: "30000000000000000",
      [USDT]: "0",
      "0xcbb7c0000ab88b473b1f5afd9ef808440eed33bf": "0", // cbBTC
      "0x50c5725949a6f0c72e6c4a641f24049a917db0cb": "0", // DAI
      "0x940181a94a35a4569e4529a3cdfb74e38fd98631": "0", // AERO
      "0xd9aaec86b65d86f6a7b5b1b0c42ffa531710b6ca": "0", // USDbC
    },
  },
  {
    name: "production/trust-check-response",
    input: {
      address: USDC,
      chainId: 8453,
      trust: {
        recommendation: "allow",
        factors: [
          { source: "ofac", signal: "clear" },
          { source: "goplus", signal: "clear" },
          { source: "etherscan", signal: "verified-contract" },
        ],
      },
    },
  },
  {
    name: "production/spending-tracker-state",
    input: {
      hourly: { spent: "0.5", windowStart: 1717000000 },
      daily: { spent: "2.5", windowStart: 1717000000 },
    },
  },
  {
    name: "production/key-registry-deployment",
    input: {
      base: {
        address: "0x4444444444444444444444444444444444444444",
        deployBlock: 12345678,
        sourceCommitHash: "abc1234",
        kmsKeys: {
          simulatorAws: { address: "0x1111", keyArn: "arn:aws:kms:...", epoch: 0 },
          simulatorGcp: { address: "0x2222", keyName: "projects/...", epoch: 0 },
          indexerAttestationAws: {
            address: "0x3333",
            keyArn: "arn:aws:kms:us-west-2:...",
            epoch: 0,
          },
        },
      },
    },
  },
  {
    name: "production/tenderly-advisory",
    input: {
      newSpki: "PLACEHOLDER-set-at-publish",
      issuedAt: 1717000000,
      validUntil: 1717604800,
      reason: "scheduled cert rotation",
      epoch: 5,
    },
  },
  {
    name: "production/quote-response",
    input: {
      router: "0x6a000f20005980200259b80c5102003040001068",
      sellToken: USDC,
      buyToken: WETH,
      sellAmount: "1000000",
      buyAmount: "30000000000000000",
      minBuyAmount: "29700000000000000",
      calldata: "0xe3ead59e" + "0".repeat(56),
      source: "velora",
    },
  },

  // -- Edge cases + RFC 8785 details (5) -----------------------------------
  {
    name: "edge/number-boundary-js-safe",
    input: { value: JS_MAX_SAFE_INT },
  },
  {
    name: "edge/long-string-1024-bytes",
    input: { data: "x".repeat(1024) },
  },
  {
    name: "edge/preserve-mixed-case-hex",
    // Addresses are lowercased by callers BEFORE canonicalize per PaladinFi
    // convention. canonicalize itself preserves whatever case is given —
    // this fixture verifies that mixed-case input is passed through verbatim
    // (i.e., canonicalize does NOT silently lowercase user-supplied strings).
    input: { address: "0xAbCdEf1234567890aBcDeF1234567890AbCdEf12" },
  },
  {
    name: "edge/control-chars-jcs-escaping",
    // RFC 8259/8785 require \u00XX escapes for control chars 0x00-0x1F.
    // Build the boundary-set string at runtime via String.fromCharCode to
    // avoid invalid bytes in this source file. Covers: NUL, BEL, BS, HT,
    // LF, VT, FF, CR, ESC, US (highest control), and DEL (0x7F is NOT a
    // control char per RFC 8259, must pass through unescaped).
    input: {
      controls: [
        0x00, 0x07, 0x08, 0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x1b, 0x1f, 0x7f,
      ]
        .map((c) => String.fromCharCode(c))
        .join(""),
    },
  },
  {
    name: "edge/key-ordering-with-numeric-prefixed-keys",
    // Lex codepoint ordering: digits (0x30-0x39) sort before letters (0x61+).
    // Keys with leading digits MUST sort before letter-leading keys.
    input: { z_key: "z", "1_key": "one", a_key: "a", "0_key": "zero" },
  },
];

// ----------------------------------------------------------------------------
// Generate canonical strings + write JSON file
// ----------------------------------------------------------------------------

if (fixtures.length !== 50) {
  console.error(`Expected exactly 50 fixtures, got ${fixtures.length}`);
  process.exit(1);
}

const generated = fixtures.map(({ name, input }, i) => {
  const expected = canonify(input);
  if (expected === undefined) {
    console.error(`Fixture #${i} (${name}): canonify returned undefined`);
    process.exit(1);
  }
  return { name, input, expected_canonical: expected };
});

// Verify all names are unique
const names = generated.map((f) => f.name);
if (new Set(names).size !== names.length) {
  const dupes = names.filter((n, i) => names.indexOf(n) !== i);
  console.error(`Duplicate fixture names: ${dupes.join(", ")}`);
  process.exit(1);
}

const json = JSON.stringify(generated, null, 2) + "\n";

const tsTarget = resolve(REPO_ROOT, "tests", "fixtures", "jcs-fixtures.json");
mkdirSync(dirname(tsTarget), { recursive: true });
writeFileSync(tsTarget, json, "utf8");
console.log(`Wrote ${generated.length} fixtures to ${tsTarget}`);

const pyTarget = resolve(SERVER_FIXTURES, "jcs-fixtures.json");
mkdirSync(SERVER_FIXTURES, { recursive: true });
writeFileSync(pyTarget, json, "utf8");
console.log(`Wrote ${generated.length} fixtures to ${pyTarget}`);
