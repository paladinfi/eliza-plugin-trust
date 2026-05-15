/**
 * Foundry/Anvil test fixture for PaladinKeyRegistry.
 *
 * Provides helpers for unit tests that need an on-chain trust anchor:
 *   - `advanceTime(seconds)` advances both Anvil's `evm_increaseTime` AND
 *     the test's FakeClock atomically. This keeps cache-TTL checks (which
 *     use `Clock`) and timelock checks (which use `block.timestamp`) in sync.
 *   - `deployPaladinKeyRegistry(...)` deploys the contract to a running
 *     Anvil instance and returns address + ABI. The Solidity source lives
 *     in `paladinfi/contracts` (Step 35 of v11 §7); this fixture imports
 *     compiled artifacts from there.
 *   - `withFreshAnvil(testFn)` boots Anvil, deploys, runs the test, tears
 *     down. Use for tests that need full isolation (rotation flows,
 *     timelock advancement).
 *
 * Convention: tests do NOT spawn Anvil from this module — that's a test
 * runtime concern. Tests start Anvil via the package.json `anvil:start`
 * script or vitest globalSetup, then point at the resulting `rpcUrl` via
 * factory option `paladinKeyRegistryAddress` override.
 *
 * The PALADIN_KEY_REGISTRY_BASE production constant is overridden via
 * factory option in tests; we don't monkey-patch the import.
 *
 * Note: until Step 35 (paladinfi/contracts repo bootstrap), the ABI/bytecode
 * imports below are PLACEHOLDER stubs. Tests that need a real contract
 * deployment will fail at `deployPaladinKeyRegistry()` with a clear error
 * pointing at Step 35. Tests that don't need a live contract (e.g.,
 * pure verifier tests with mocked `getTrustState` return values) work fine.
 */

import {
  createPublicClient,
  createTestClient,
  createWalletClient,
  http,
  type Address,
  type Hex,
  type PublicClient,
  type TestClient,
  type WalletClient,
} from "viem";
import { foundry } from "viem/chains";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { FakeClock } from "../src/utils/clock";

// =============================================================================
// Anvil RPC URL — default matches `anvil --port 8545` (the Foundry default).
// Tests can override via PALADIN_TEST_ANVIL_URL env var.
// =============================================================================

export const DEFAULT_ANVIL_URL = process.env.PALADIN_TEST_ANVIL_URL ?? "http://127.0.0.1:8545";

/** Construct a viem public client pointed at the test Anvil instance. */
export function makeTestPublicClient(rpcUrl: string = DEFAULT_ANVIL_URL): PublicClient {
  return createPublicClient({ chain: foundry, transport: http(rpcUrl) });
}

/** Construct a viem test client (anvil-specific RPCs: setBalance, mine, etc.). */
export function makeTestClient(rpcUrl: string = DEFAULT_ANVIL_URL): TestClient {
  return createTestClient({ chain: foundry, transport: http(rpcUrl), mode: "anvil" });
}

/** Construct a wallet client backed by a deterministic private key. */
export function makeTestWalletClient(
  privateKey: Hex = generatePrivateKey(),
  rpcUrl: string = DEFAULT_ANVIL_URL,
): { client: WalletClient; account: Address } {
  const account = privateKeyToAccount(privateKey);
  const client = createWalletClient({ account, chain: foundry, transport: http(rpcUrl) });
  return { client, account: account.address };
}

// =============================================================================
// advanceTime — atomic dual-clock advancement (FakeClock + Anvil)
// =============================================================================

export interface AdvanceTimeContext {
  testClient: TestClient;
  fakeClock: FakeClock;
}

/**
 * Advance both Anvil's chain time AND the FakeClock by `seconds`. Atomic
 * within the test — both advance in the same async step.
 *
 * After advancing chain time, mines one block so subsequent `eth_call`
 * reads use the new timestamp. Without the mine, queries return the
 * old block's timestamp until something else triggers a block.
 */
export async function advanceTime(ctx: AdvanceTimeContext, seconds: number): Promise<void> {
  if (seconds <= 0 || !Number.isFinite(seconds)) {
    throw new Error("advanceTime: seconds must be a positive finite number");
  }
  const ms = Math.round(seconds * 1000);
  // Advance Anvil first; if it fails, the FakeClock stays put.
  await ctx.testClient.increaseTime({ seconds });
  await ctx.testClient.mine({ blocks: 1 });
  ctx.fakeClock.advance(ms);
}

// =============================================================================
// PaladinKeyRegistry deployment helpers (PLACEHOLDER until Step 35)
// =============================================================================

/**
 * Compiled artifacts for PaladinKeyRegistry. Imported from the
 * `paladinfi/contracts` repo (Step 35). Until that repo exists, this
 * is a placeholder that throws on use — tests that need a live
 * deployment must wait for Step 35.
 *
 * After Step 35 lands, replace this with:
 *   import { abi, bytecode } from "@paladinfi/contracts/dist/PaladinKeyRegistry";
 *   export const PALADIN_KEY_REGISTRY_ABI = abi;
 *   export const PALADIN_KEY_REGISTRY_BYTECODE = bytecode;
 */
export const PALADIN_KEY_REGISTRY_ABI = [] as const;
export const PALADIN_KEY_REGISTRY_BYTECODE: Hex = "0x" as const;

export interface DeployedPaladinKeyRegistry {
  address: Address;
  ownerAddress: Address;
  rpcUrl: string;
}

/**
 * Deploy PaladinKeyRegistry to a running Anvil instance.
 *
 * v11 contract constructor: `(Pair memory _initialPair, address _owner,
 * bytes32 _tokenRegistryHash, address _initialIndexerKey)`. See v11 §4.10.6.
 *
 * Throws until Step 35 lands. Tests that need this should be marked
 * `.skip` or use a mocked `getTrustState` return value via dependency
 * injection in `paladin-keys.ts` until then.
 */
export async function deployPaladinKeyRegistry(_opts: {
  initialPairAws: Address;
  initialPairGcp: Address;
  ownerAddress: Address;
  initialTokenRegistryHash: Hex;
  initialIndexerAttestationKey: Address;
  rpcUrl?: string;
}): Promise<DeployedPaladinKeyRegistry> {
  if (PALADIN_KEY_REGISTRY_BYTECODE === "0x") {
    throw new Error(
      "deployPaladinKeyRegistry: PaladinKeyRegistry compiled artifacts not yet available. " +
        "This depends on Step 35 (paladinfi/contracts repo bootstrap + Solidity compile). " +
        "Until then, mock getTrustState() at the unit-test boundary.",
    );
  }
  // Real deploy path — implemented after Step 35.
  throw new Error("deployPaladinKeyRegistry: implementation pending Step 35");
}

// =============================================================================
// withFreshAnvil — convenience for tests that want full isolation
// =============================================================================

export interface FreshAnvilContext {
  publicClient: PublicClient;
  testClient: TestClient;
  walletClient: WalletClient;
  ownerAddress: Address;
  registry: DeployedPaladinKeyRegistry;
  fakeClock: FakeClock;
  /** Atomic dual-clock advancement (Anvil + FakeClock). */
  advanceTime(seconds: number): Promise<void>;
}

/**
 * Boot a fresh Anvil-deployed registry, run `testFn` against it, tear down.
 * Uses `anvil_reset` between invocations rather than restarting the process,
 * for speed.
 *
 * Until Step 35 lands, this throws via the underlying `deployPaladinKeyRegistry`.
 */
export async function withFreshAnvil<T>(
  testFn: (ctx: FreshAnvilContext) => Promise<T>,
  opts: {
    rpcUrl?: string;
    initialClockMs?: number;
    initialPairAws?: Address;
    initialPairGcp?: Address;
    initialIndexerAttestationKey?: Address;
    initialTokenRegistryHash?: Hex;
  } = {},
): Promise<T> {
  const rpcUrl = opts.rpcUrl ?? DEFAULT_ANVIL_URL;
  const publicClient = makeTestPublicClient(rpcUrl);
  const testClient = makeTestClient(rpcUrl);
  const ownerPrivateKey = generatePrivateKey();
  const { client: walletClient, account: ownerAddress } = makeTestWalletClient(
    ownerPrivateKey,
    rpcUrl,
  );
  const fakeClock = new FakeClock(opts.initialClockMs ?? Date.now());

  // Reset Anvil state for test isolation.
  await testClient.reset();

  const registry = await deployPaladinKeyRegistry({
    initialPairAws:
      opts.initialPairAws ?? "0x0000000000000000000000000000000000000001",
    initialPairGcp:
      opts.initialPairGcp ?? "0x0000000000000000000000000000000000000002",
    initialIndexerAttestationKey:
      opts.initialIndexerAttestationKey ?? "0x0000000000000000000000000000000000000003",
    initialTokenRegistryHash:
      opts.initialTokenRegistryHash ??
      ("0x0000000000000000000000000000000000000000000000000000000000000000" as Hex),
    ownerAddress,
    rpcUrl,
  });

  const ctx: FreshAnvilContext = {
    publicClient,
    testClient,
    walletClient,
    ownerAddress,
    registry,
    fakeClock,
    advanceTime: (seconds) => advanceTime({ testClient, fakeClock }, seconds),
  };

  try {
    return await testFn(ctx);
  } finally {
    // Reset for next test.
    await testClient.reset();
  }
}
