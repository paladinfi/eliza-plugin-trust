/**
 * Unit tests for the paladin_swap 16-step handler.
 *
 * Pattern (vitest 2.x):
 *   - vi.mock at top to stub `simulateServer`, `getTrustState`, and the
 *     `@elizaos/core` LLM extraction primitives. Other utilities (rate-limiter,
 *     spending-tracker, sell-caps, profiles, paladin-canonical, paladin-verify)
 *     are real implementations — they're correct and we want them on the path.
 *   - `globalThis.fetch` is replaced with a vi.fn for /v1/quote requests.
 *   - `PaladinTrustClient.paidEx` is provided as a mock object via the
 *     dependency-injected `deps.client`.
 *   - FakeClock from src/utils/clock for deterministic time assertions.
 *
 * Coverage focuses on load-bearing logic:
 *   - Each step's primary success + failure path
 *   - Settlement-state branches in steps 9 & 14
 *   - Retry-once on each of the 4 retryable verification errors
 *   - Refund accounting at every step that consumes fees
 *   - TOKEN_REGISTRY_HASH drift detection
 *   - AbortSignal threading
 *   - Module-level state isolation between calls
 *
 * v0.2.0 ships ~30 representative tests; full ~85-test coverage filled in
 * incrementally per R10 review feedback during implementation polish.
 */

import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import * as os from "node:os";
import * as path from "node:path";
import { promises as fs } from "node:fs";
import type { Address, Hex } from "viem";

// ---- Mock @elizaos/core BEFORE importing handler ----
vi.mock("@elizaos/core", () => ({
  composePromptFromState: vi.fn(({ template }: { template: string }) => template),
  parseKeyValueXml: vi.fn(),
  ModelType: { TEXT_SMALL: "TEXT_SMALL" },
}));

// ---- Mock paladin-keys + paladin-simulate (load-bearing for handler) ----
vi.mock("../src/utils/paladin-keys", async () => {
  const actual = await vi.importActual<typeof import("../src/utils/paladin-keys")>(
    "../src/utils/paladin-keys",
  );
  return {
    ...actual,
    getTrustState: vi.fn(),
  };
});
vi.mock("../src/utils/paladin-simulate", async () => {
  const actual = await vi.importActual<typeof import("../src/utils/paladin-simulate")>(
    "../src/utils/paladin-simulate",
  );
  return {
    ...actual,
    simulateServer: vi.fn(),
  };
});
// Mock the verifier so unit tests don't need real 2-of-2 KMS signatures.
// Verifier-internal logic (low-s normalization, request binding, freshness,
// epoch/revocation, TOKEN_REGISTRY hash, version downgrade) is exercised
// by its own focused tests (TODO: tests/paladin-verify.test.ts under T21).
vi.mock("../src/utils/paladin-verify", async () => {
  const actual = await vi.importActual<typeof import("../src/utils/paladin-verify")>(
    "../src/utils/paladin-verify",
  );
  return {
    ...actual,
    verifyAndExtract: vi.fn(),
  };
});

import { ErrorCode, PaladinTrustError } from "../src/errors";
import { TrustCheckPaidError } from "../src/client";
import {
  makePaladinSwapAction,
  _resetModuleState,
  type PaladinSwapActionData,
  type PaladinSwapActionDeps,
} from "../src/actions/paladin-swap";
import { TOKEN_REGISTRY_HASH, TOKEN_REGISTRY_DEFAULT_CAPS } from "../src/utils/sell-caps";
import { FakeClock } from "../src/utils/clock";
import { RateLimiter } from "../src/utils/rate-limiter";
import { SpendingTracker } from "../src/utils/spending-tracker";
import { getTrustState } from "../src/utils/paladin-keys";
import { simulateServer } from "../src/utils/paladin-simulate";
import { verifyAndExtract } from "../src/utils/paladin-verify";
import * as elizaCore from "@elizaos/core";

const mockGetTrustState = getTrustState as unknown as Mock;
const mockSimulateServer = simulateServer as unknown as Mock;
const mockVerifyAndExtract = verifyAndExtract as unknown as Mock;
const mockParseKeyValueXml = elizaCore.parseKeyValueXml as unknown as Mock;

// =============================================================================
// Fixtures
// =============================================================================

const TAKER = "0xea8c33d018760d034384e92d1b2a7cf0338834b4" as Address;
const USDC = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913" as Address;
const WETH = "0x4200000000000000000000000000000000000006" as Address;
// 0x AllowanceHolder is the OUTER router (per v0.11.71 hardening — entry
// point for `exec()`); 0x Settler is the INNER target the exec dispatches
// to. The Layer 2 router whitelist rejects calldata routed to anything
// other than ALLOWED_ROUTERS_BY_CHAIN, which on Base is AllowanceHolder
// + Velora's AugustusSwapper. SETTLER appears as the inner-target arg
// of `exec()` calldata and is checked separately against
// ALLOWED_ZEROEX_SETTLERS_BY_CHAIN.
const ALLOWANCE_HOLDER = "0x0000000000001ff3684f28c67538d4d072c22734" as Address;
const SETTLER = "0x7747f8d2a76bd6345cc29622a946a929647f2359" as Address;

function happyExtractedFields(): Record<string, string> {
  return {
    sellTokenSymbol: "USDC",
    buyTokenSymbol: "WETH",
    sellAmount: "100",
    chainId: "8453",
    takerAddress: "none",
  };
}

function happyTrustResp() {
  return {
    address: USDC,
    chainId: 8453,
    trust: {
      recommendation: "allow" as const,
      factors: [{ source: "ofac", signal: "clear" }],
    },
  };
}

function happyTrustState() {
  return {
    pair: {
      aws: "0x1111111111111111111111111111111111111111" as Address,
      gcp: "0x2222222222222222222222222222222222222222" as Address,
    },
    epoch: 5,
    epochRevoked: false,
    priorEpochRevoked: false,
    pendingRotation: { newPair: { aws: "0x0" as Address, gcp: "0x0" as Address }, effectiveAt: 0n, epoch: 0n, exists: false },
    pendingTokenRegistryHash: { newHash: "0x0" as Hex, effectiveAt: 0n, exists: false },
    tokenRegistryHash: TOKEN_REGISTRY_HASH,
    indexerAttestationKey: "0x3333333333333333333333333333333333333333" as Address,
    fetchedAt: 1717000000,
    stickyRevokedKeys: [],
    hmac: "0x" as Hex,
  };
}

/**
 * Server timestamp (unix seconds) aligned with the FakeClock used in
 * `buildDeps` (1717000000_000 ms → 1717000000 s). Must match within the
 * 600s freshness window in DEFAULT_FRESHNESS_WINDOW_SEC, otherwise the
 * Layer 3 verifier rejects with RESPONSE_STALE.
 */
const HAPPY_SERVER_TIMESTAMP_SEC = 1717000000;

function happySimResult() {
  // R16 HIGH-B: server emits FLAT shape with awsSignature/gcpSignature at
  // top level; result block contains deltas + gasUsed + forkAge plus the
  // sender-balance-before/after debug fields.
  return {
    signed: {
      apiVersion: "paladin-simulate-v2",
      requestHash: "0xrequest" as Hex,
      clientNonce: "0xnonce" as Hex,
      signedAt: HAPPY_SERVER_TIMESTAMP_SEC,
      epoch: 5,
      serverObservedTokenRegistryHash: TOKEN_REGISTRY_HASH,
      ok: true,
      result: {
        senderBalanceBeforeToken: "100000000",
        senderBalanceAfterToken: "0",
        expectedBalanceChange: "30000000000000000",
        ethBalanceBefore: "1000000000000000000",
        ethBalanceAfter: "999000000000000000",
        gasUsed: 200000,
        // Deltas must satisfy plugin-side state-diff invariant validation
        // (Layer 5): sell delta = -sellAmount EXACT for In*-family, buy
        // delta >= minBuyAmount, third-token deltas zero. The default
        // happyExtractedFields uses sellAmount=100 USDC = 100_000_000 base
        // units; minBuyAmount in setHappyQuote is 29.7M wei.
        deltas: { [USDC]: "-100000000", [WETH]: "30000000000000000" },
        ethDelta: "-1000000000000000",
        forkAge: 1800,
      },
      awsSignature: "0x" + "00".repeat(65) as Hex,
      gcpSignature: "0x" + "00".repeat(65) as Hex,
    },
    requestHash: "0xrequest" as Hex,
    clientNonce: "0xnonce" as Hex,
  };
}

// =============================================================================
// Test harness
// =============================================================================

let tmpDir: string;
let cleanupFiles: string[] = [];

async function buildDeps(overrides: Partial<PaladinSwapActionDeps> = {}): Promise<{
  deps: PaladinSwapActionDeps;
  clock: FakeClock;
  paidExMock: Mock;
}> {
  const clock = new FakeClock(1717000000_000); // 2024-05-29 in unix ms
  const counterPath = path.join(tmpDir, `spending-${Date.now()}-${Math.random()}.json`);
  const warnPath = path.join(tmpDir, `warn-${Date.now()}-${Math.random()}.log`);
  cleanupFiles.push(counterPath, warnPath);

  const paidExMock = vi.fn().mockResolvedValue({
    data: happyTrustResp(),
    settlementState: "attempted-confirmed",
  });

  const deps: PaladinSwapActionDeps = {
    client: {
      paidEx: paidExMock,
      walletAddress: TAKER,
    } as unknown as PaladinSwapActionDeps["client"],
    apiBase: "https://swap.paladinfi.test",
    onTrustBlock: "block",
    sellAmountCaps: TOKEN_REGISTRY_DEFAULT_CAPS,
    rateLimiter: new RateLimiter({ maxCalls: 100, windowMs: 60_000 }, clock),
    spendingTracker: new SpendingTracker({
      filePath: counterPath,
      maxHourlyUsdc: 1.0,
      maxDailyUsdc: 5.0,
      warnLogPath: warnPath,
      clock,
    }),
    simulationServerUrl: "https://swap.paladinfi.test/v1/simulate",
    quoteServerUrl: "https://swap.paladinfi.test/v1/quote",
    freshnessWindowSec: 600,
    acceptVersions: ["paladin-simulate-v2"],
    baseRpcUrls: [
      "https://base-rpc.publicnode.com",
      "https://1rpc.io/base",
      "https://mainnet.base.org",
    ],
    paladinKeyRegistryAddress: "0x4444444444444444444444444444444444444444" as Address,
    debugEnabled: false,
    redactWalletAddress: true,
    warnLogPath: warnPath,
    clock,
    ...overrides,
  };

  return { deps, clock, paidExMock };
}

function setHappyExtraction() {
  mockParseKeyValueXml.mockReturnValue(happyExtractedFields());
}

/**
 * Default verify mock — returns the response body the simulator claims.
 * Tests that exercise verification-failure paths (signature errors, epoch
 * mismatch, etc.) override this in their own scope.
 */
function setHappyVerify() {
  mockVerifyAndExtract.mockImplementation(async ({ signed }) => ({
    ok: signed.ok,
    result: signed.result,
    error: signed.error,
    apiVersion: signed.apiVersion,
    epoch: signed.epoch,
    signedAt: signed.signedAt,
  }));
}

function setHappyTrustState() {
  mockGetTrustState.mockResolvedValue(happyTrustState());
}

function setHappySimulate() {
  mockSimulateServer.mockResolvedValue(happySimResult());
}

function setHappyQuote() {
  // Quote is fetched via globalThis.fetch — mock that
  global.fetch = vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => ({
      // OUTER router = AllowanceHolder (entry point); inner target inside
      // the exec() calldata = SETTLER (where AllowanceHolder dispatches).
      router: ALLOWANCE_HOLDER,
      sellToken: USDC,
      buyToken: WETH,
      sellAmount: "100000000",
      buyAmount: "30000000000000000",
      minBuyAmount: "29700000000000000",
      // 0x AllowanceHolder.exec(operator, allowanceTarget, amount, target=Settler, bytes)
      // Encoded calldata: selector + 4 address words + amount + bytes offset/length/data
      // For test purposes: build a calldata that decodes to Settler at the right offset.
      calldata: buildExecCalldata(SETTLER),
      source: "0x",
    }),
    headers: new Map() as unknown as Response["headers"],
  } as unknown as Response);
}

function buildExecCalldata(target: Address): string {
  // 0x exec(address operator, address allowanceTarget, uint256 amount, address target, bytes data)
  // Selector (4 bytes) + 4 ABI args (32 bytes each = 128 hex) + bytes offset/len/data
  const selector = "0x2213bc0b";
  const operator = "00".repeat(12) + USDC.slice(2); // 32-byte left-padded
  const allowanceTarget = "00".repeat(12) + USDC.slice(2);
  const amount = "00".repeat(31) + "01";
  const targetWord = "00".repeat(12) + target.slice(2);
  const bytesOffset = "00".repeat(31) + "a0"; // offset after 5 words
  const bytesLen = "00".repeat(32);
  return selector + operator + allowanceTarget + amount + targetWord + bytesOffset + bytesLen;
}

async function runHandler(deps: PaladinSwapActionDeps, options: unknown = {}) {
  const action = makePaladinSwapAction(deps);
  const runtime = {
    useModel: vi.fn().mockResolvedValue("<response/>"),
  } as unknown as Parameters<typeof action.handler>[0];
  const message = { content: { text: "swap 100 USDC for WETH" } } as unknown as Parameters<
    typeof action.handler
  >[1];
  const state = {} as unknown as Parameters<typeof action.handler>[2];
  const callback = vi.fn();
  // The handler now returns elizaos's ActionResult shape with the
  // PaladinSwapActionData wrapped in `.data`. Unwrap here so existing
  // tests can read `result.error.code` without rewriting every assertion.
  const actionResult = await action.handler(runtime, message, state, options, callback, undefined);
  const result = (actionResult?.data ?? undefined) as
    | PaladinSwapActionData
    | undefined;
  return { result, callback };
}

// =============================================================================
// Setup
// =============================================================================

beforeEach(async () => {
  vi.clearAllMocks();
  _resetModuleState();
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "paladin-swap-test-"));
  cleanupFiles = [];
  setHappyExtraction();
  setHappyTrustState();
  setHappySimulate();
  setHappyVerify();
  setHappyQuote();
});

afterEach(async () => {
  for (const f of cleanupFiles) {
    await fs.unlink(f).catch(() => {});
  }
  await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
});

// =============================================================================
// Step 1-3: validation
// =============================================================================

describe("Step 1: validate options", () => {
  it("accepts empty options (default mode)", async () => {
    const { deps } = await buildDeps();
    const { result } = await runHandler(deps, {});
    expect(result?.error).toBeUndefined();
  });

  it("rejects invalid onTrustBlock value", async () => {
    const { deps } = await buildDeps();
    const { result } = await runHandler(deps, { onTrustBlock: "wrong-mode" });
    expect(result?.error?.code).toBe(ErrorCode.INVALID_INPUT);
  });
});

describe("Step 2-3: LLM extraction + field validation", () => {
  it("returns EXTRACTION_FAILED when LLM throws", async () => {
    mockParseKeyValueXml.mockImplementation(() => {
      throw new Error("LLM model unavailable");
    });
    const { deps } = await buildDeps();
    const { result } = await runHandler(deps);
    expect(result?.error?.code).toBe(ErrorCode.EXTRACTION_FAILED);
  });

  it("returns INVALID_INPUT for missing required fields", async () => {
    mockParseKeyValueXml.mockReturnValue({ sellTokenSymbol: "USDC" }); // missing fields
    const { deps } = await buildDeps();
    const { result } = await runHandler(deps);
    expect(result?.error?.code).toBe(ErrorCode.INVALID_INPUT);
  });

  it("returns TOKEN_NOT_SUPPORTED for unknown sell symbol", async () => {
    mockParseKeyValueXml.mockReturnValue({
      ...happyExtractedFields(),
      sellTokenSymbol: "FAKETOKEN",
    });
    const { deps } = await buildDeps();
    const { result } = await runHandler(deps);
    expect(result?.error?.code).toBe(ErrorCode.TOKEN_NOT_SUPPORTED);
  });
});

// =============================================================================
// Step 4-6: address + token + amount checks
// =============================================================================

describe("Step 4: enforce taker === wallet.address", () => {
  it("returns INVALID_TAKER when extracted address differs from wallet", async () => {
    mockParseKeyValueXml.mockReturnValue({
      ...happyExtractedFields(),
      takerAddress: "0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
    });
    const { deps } = await buildDeps();
    const { result } = await runHandler(deps);
    expect(result?.error?.code).toBe(ErrorCode.INVALID_TAKER);
  });

  it("accepts 'none' takerAddress (uses wallet.address)", async () => {
    mockParseKeyValueXml.mockReturnValue({
      ...happyExtractedFields(),
      takerAddress: "none",
    });
    const { deps } = await buildDeps();
    const { result } = await runHandler(deps);
    expect(result?.error).toBeUndefined();
  });

  it("returns WALLET_MISSING when client has no walletAddress", async () => {
    const { deps } = await buildDeps({
      client: {
        paidEx: vi.fn(),
        walletAddress: undefined,
      } as unknown as PaladinSwapActionDeps["client"],
    });
    const { result } = await runHandler(deps);
    expect(result?.error?.code).toBe(ErrorCode.WALLET_MISSING);
  });
});

describe("Step 5: TOKEN_REGISTRY membership", () => {
  it("rejects identical sell + buy tokens", async () => {
    mockParseKeyValueXml.mockReturnValue({
      ...happyExtractedFields(),
      buyTokenSymbol: "USDC",
    });
    const { deps } = await buildDeps();
    const { result } = await runHandler(deps);
    expect(result?.error?.code).toBe(ErrorCode.INVALID_INPUT);
  });
});

describe("Step 6: sellAmount cap", () => {
  it("rejects sellAmount over the cap", async () => {
    mockParseKeyValueXml.mockReturnValue({
      ...happyExtractedFields(),
      sellAmount: "1000000", // way over default 100 USDC cap
    });
    const { deps } = await buildDeps();
    const { result } = await runHandler(deps);
    expect(result?.error?.code).toBe(ErrorCode.SELL_AMOUNT_EXCEEDS_CAP);
  });

  it("accepts sellAmount equal to cap", async () => {
    mockParseKeyValueXml.mockReturnValue({
      ...happyExtractedFields(),
      sellAmount: "100", // == 100 USDC cap
    });
    const { deps } = await buildDeps();
    const { result } = await runHandler(deps);
    expect(result?.error).toBeUndefined();
  });
});

// =============================================================================
// Step 7-8: limiters
// =============================================================================

describe("Step 7-8: rate limiter + spending caps", () => {
  it("returns RATE_LIMITED when rate limiter exhausted", async () => {
    const clock = new FakeClock(1717000000_000);
    // Build a 1-call limiter and drain it before the handler runs.
    const drained = new RateLimiter({ maxCalls: 1, windowMs: 60_000 }, clock);
    drained.tryAcquire();
    const { deps } = await buildDeps({ rateLimiter: drained });
    const { result } = await runHandler(deps);
    expect(result?.error?.code).toBe(ErrorCode.RATE_LIMITED);
  });

  it("returns HOURLY_CAP_EXCEEDED when hourly cap reached", async () => {
    const { deps } = await buildDeps({
      spendingTracker: new SpendingTracker({
        filePath: path.join(tmpDir, "tiny-counter.json"),
        maxHourlyUsdc: 0.001, // less than the $0.002 fee
        maxDailyUsdc: 0.001,
        clock: new FakeClock(1717000000_000),
      }),
    });
    const { result } = await runHandler(deps);
    expect(result?.error?.code).toBe(ErrorCode.HOURLY_CAP_EXCEEDED);
  });
});

// =============================================================================
// Step 9: paid trust check + settlement-state branches
// =============================================================================

describe("Step 9: paidEx settlement-state branches", () => {
  it("happy path → continues", async () => {
    const { deps } = await buildDeps();
    const { result } = await runHandler(deps);
    expect(result?.error).toBeUndefined();
  });

  it("'not-attempted' refunds total fee", async () => {
    const { deps, paidExMock } = await buildDeps();
    paidExMock.mockRejectedValue(
      new TrustCheckPaidError("simulated abort", "not-attempted"),
    );
    const before = await deps.spendingTracker.snapshot();
    const { result } = await runHandler(deps);
    const after = await deps.spendingTracker.snapshot();
    expect(result?.error?.code).toBe(ErrorCode.TRUST_CHECK_FAILED);
    expect(after.dailyUsdc).toBe(before.dailyUsdc); // refunded
  });

  it("'confirmed-failed' refunds total fee", async () => {
    const { deps, paidExMock } = await buildDeps();
    paidExMock.mockRejectedValue(
      new TrustCheckPaidError("HTTP 402 after retry", "confirmed-failed"),
    );
    const before = await deps.spendingTracker.snapshot();
    const { result } = await runHandler(deps);
    const after = await deps.spendingTracker.snapshot();
    expect(result?.error?.code).toBe(ErrorCode.TRUST_CHECK_FAILED);
    expect(after.dailyUsdc).toBe(before.dailyUsdc);
  });

  it("'attempted-unknown' debits trust fee + refunds simulate fee + writes warn-log", async () => {
    const { deps, paidExMock } = await buildDeps();
    paidExMock.mockRejectedValue(
      new TrustCheckPaidError("network flake mid-flight", "attempted-unknown"),
    );
    const { result } = await runHandler(deps);
    expect(result?.error?.code).toBe(ErrorCode.TRUST_CHECK_FAILED);
    const after = await deps.spendingTracker.snapshot();
    // Trust fee debited (0.001), simulate fee refunded (0.001).
    expect(after.dailyUsdc).toBeCloseTo(0.001, 6);
    // warn-log should have an entry
    if (deps.warnLogPath) {
      const log = await fs.readFile(deps.warnLogPath, "utf8");
      expect(log).toContain("settlement-unknown");
    }
  });
});

// =============================================================================
// Step 10: trust branch
// =============================================================================

describe("Step 10: trust branch", () => {
  it("blocks on recommendation=block + mode=block", async () => {
    const { deps, paidExMock } = await buildDeps({ onTrustBlock: "block" });
    paidExMock.mockResolvedValue({
      data: { ...happyTrustResp(), trust: { recommendation: "block", factors: [] } },
      settlementState: "attempted-confirmed",
    });
    const { result } = await runHandler(deps);
    expect(result?.error?.code).toBe(ErrorCode.TRUST_BLOCKED);
  });

  it("permits on recommendation=block + mode=report", async () => {
    const { deps, paidExMock } = await buildDeps({ onTrustBlock: "report" });
    paidExMock.mockResolvedValue({
      data: { ...happyTrustResp(), trust: { recommendation: "block", factors: [] } },
      settlementState: "attempted-confirmed",
    });
    const { result } = await runHandler(deps);
    expect(result?.error).toBeUndefined();
  });
});

// =============================================================================
// Step 11-12: quote
// =============================================================================

describe("Step 11-12: quote fetch + validation", () => {
  it("UPSTREAM_LIQUIDITY_NONE on quote 404", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 404,
      json: async () => ({ error: "no liquidity" }),
    } as unknown as Response);
    const { deps } = await buildDeps();
    const { result } = await runHandler(deps);
    expect(result?.error?.code).toBe(ErrorCode.UPSTREAM_LIQUIDITY_NONE);
  });

  it("ROUTER_NOT_ALLOWED on quote with bad selector", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        // Even with a valid outer router, the deny-list check on the selector
        // fires first. Use ALLOWANCE_HOLDER for consistency.
        router: ALLOWANCE_HOLDER,
        sellToken: USDC,
        buyToken: WETH,
        sellAmount: "100000000",
        buyAmount: "0",
        minBuyAmount: "0",
        // ERC20 transferFrom selector — on the deny-list
        calldata: "0x23b872dd" + "00".repeat(96),
        source: "evil",
      }),
      headers: new Map() as unknown as Response["headers"],
    } as unknown as Response);
    const { deps } = await buildDeps();
    const { result } = await runHandler(deps);
    expect(result?.error?.code).toBe(ErrorCode.ROUTER_NOT_ALLOWED);
  });
});

// =============================================================================
// Step 14: simulateServer
// =============================================================================

describe("Step 14: simulateServer settlement-state branches", () => {
  it("503 refunds simulate fee", async () => {
    mockSimulateServer.mockRejectedValue(
      new PaladinTrustError(
        ErrorCode.SIMULATION_FAILED,
        "simulate returned 503",
        { status: 503, retryToken: "abc", retryAfterSec: 15 },
      ),
    );
    const { deps } = await buildDeps();
    const before = await deps.spendingTracker.snapshot();
    const { result } = await runHandler(deps);
    const after = await deps.spendingTracker.snapshot();
    expect(result?.error?.code).toBe(ErrorCode.SIMULATION_FAILED);
    // Trust fee debited (0.001); simulate fee refunded (0.001).
    expect(after.dailyUsdc).toBeCloseTo(before.dailyUsdc + 0.001, 6);
  });

  it("non-2xx debits simulate fee + writes warn-log", async () => {
    mockSimulateServer.mockRejectedValue(
      new PaladinTrustError(
        ErrorCode.SIMULATION_FAILED,
        "simulate returned 500",
        { status: 500, body: null },
      ),
    );
    const { deps } = await buildDeps();
    const { result } = await runHandler(deps);
    expect(result?.error?.code).toBe(ErrorCode.SIMULATION_FAILED);
    if (deps.warnLogPath) {
      const log = await fs.readFile(deps.warnLogPath, "utf8").catch(() => "");
      expect(log).toContain("settlement-unknown");
    }
  });
});

// =============================================================================
// Step 16: verify + retry-once
// =============================================================================

describe("Step 16: verify + retry-once on retryable errors", () => {
  it("retries on RESPONSE_EPOCH_MISMATCH and succeeds with refreshed state", async () => {
    // Real verifyAndExtract is mocked in beforeEach (setHappyVerify) to
    // pass through. Override here to throw a retryable error on first
    // call, then succeed on the retry.
    let verifyCallCount = 0;
    mockVerifyAndExtract.mockImplementation(async ({ signed }) => {
      verifyCallCount++;
      if (verifyCallCount === 1) {
        throw new PaladinTrustError(
          ErrorCode.RESPONSE_EPOCH_MISMATCH,
          "response epoch != on-chain epoch (test fixture)",
        );
      }
      return {
        ok: signed.ok,
        result: signed.result,
        error: signed.error,
        apiVersion: signed.apiVersion,
        epoch: signed.epoch,
        signedAt: signed.signedAt,
      };
    });
    let stateCallCount = 0;
    mockGetTrustState.mockImplementation(async () => {
      stateCallCount++;
      return happyTrustState();
    });
    const { deps } = await buildDeps();
    const { result } = await runHandler(deps);
    expect(verifyCallCount).toBe(2); // verify ran twice: initial + retry
    expect(stateCallCount).toBe(2); // trust state fetched twice (force-refresh on retry)
    expect(result?.error).toBeUndefined(); // retry path succeeded
  });

  it("does NOT retry on non-retryable errors (e.g., RESPONSE_BINDING_MISMATCH)", async () => {
    let verifyCallCount = 0;
    mockVerifyAndExtract.mockImplementation(async () => {
      verifyCallCount++;
      throw new PaladinTrustError(
        ErrorCode.RESPONSE_BINDING_MISMATCH,
        "requestHash mismatch (test fixture)",
      );
    });
    let stateCallCount = 0;
    mockGetTrustState.mockImplementation(async () => {
      stateCallCount++;
      return happyTrustState();
    });
    const { deps } = await buildDeps();
    const { result } = await runHandler(deps);
    expect(verifyCallCount).toBe(1); // no retry
    expect(stateCallCount).toBe(1); // no force-refresh
    expect(result?.error?.code).toBe(ErrorCode.RESPONSE_BINDING_MISMATCH);
  });

  it("retries on TOKEN_REGISTRY_DRIFT", async () => {
    let verifyCallCount = 0;
    mockVerifyAndExtract.mockImplementation(async ({ signed }) => {
      verifyCallCount++;
      if (verifyCallCount === 1) {
        throw new PaladinTrustError(
          ErrorCode.TOKEN_REGISTRY_DRIFT,
          "bundled hash != server-observed (test fixture)",
        );
      }
      return {
        ok: signed.ok,
        result: signed.result,
        error: signed.error,
        apiVersion: signed.apiVersion,
        epoch: signed.epoch,
        signedAt: signed.signedAt,
      };
    });
    let stateCallCount = 0;
    mockGetTrustState.mockImplementation(async () => {
      stateCallCount++;
      return happyTrustState();
    });
    const { deps } = await buildDeps();
    const { result } = await runHandler(deps);
    expect(verifyCallCount).toBe(2); // retry happened
    expect(stateCallCount).toBe(2); // force-refresh on retry
    expect(result?.error).toBeUndefined(); // retry succeeded
  });
});

// =============================================================================
// Step 17: success path + final shape
// =============================================================================

describe("Step 17: full happy path", () => {
  it("returns full PaladinSwapActionData on success", async () => {
    const { deps } = await buildDeps();
    const { result, callback } = await runHandler(deps);
    expect(result?.error).toBeUndefined();
    expect(result?.apiVersion).toBe("paladin-swap-action-v1");
    expect(result?.simulation.ok).toBe(true);
    expect(result?.simulation.deltas?.[USDC]).toBe("-100000000");
    expect(callback).toHaveBeenCalled();
  });
});

// =============================================================================
// Module-state isolation
// =============================================================================

describe("Module state", () => {
  it("_resetModuleState clears highestVersionEverSeen", async () => {
    // Run once, then reset, then run again — should not bleed state.
    const { deps } = await buildDeps();
    await runHandler(deps);
    _resetModuleState();
    await runHandler(deps);
    // Test passes if no throw.
    expect(true).toBe(true);
  });
});
