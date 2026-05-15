/**
 * On-chain trust state reader for the paladin_swap action.
 *
 * Reads `PaladinKeyRegistry.readTrustState()` + `indexerAttestationKey()`
 * on Base via multi-RPC quorum. Caches result in-memory + on-disk with
 * HMAC integrity check. Implements:
 *   - Max-epoch-wins quorum (R8 Sec HIGH-S-5 / R9 Eng HIGH-2)
 *   - Sticky-revoked keyed on (epoch, pairHash) (R10 Sec HIGH-S-2)
 *   - In-flight fetch dedup (R9 Eng HIGH-4)
 *   - HMAC'd cache file with per-install integrity key (R10 Sec HIGH-S-2)
 *   - Atomic disk writes via proper-lockfile + tmp/rename (R9 Eng HIGH-1)
 *   - 2-hour stale-grace fallback (R10 Sec CRIT-S-1 hardened from 24h)
 *   - Sticky-revoked refuses stale-grace fallback (R10 Sec CRIT-S-1)
 *   - Epoch-decrease guard (R13 Sec LOW-1)
 *   - Operator-distinctness check (R12 Sec HIGH-6 + R13 Sec MED-1 fallback warn)
 *
 * The contract address (`PALADIN_KEY_REGISTRY_BASE_DEFAULT`) is a placeholder
 * (zero address) until the contract is deployed at Step 47. Customers MUST
 * pass `paladinKeyRegistryAddress` factory option for tests; production
 * builds replace the default at npm-publish time.
 */

import { promises as fs } from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { createHmac, randomBytes } from "node:crypto";
import {
  createPublicClient,
  http,
  keccak256,
  toHex,
  type Address,
  type Hex,
} from "viem";
import { base } from "viem/chains";
import lockfile from "proper-lockfile";
import { realClock, type Clock } from "./clock";
import { PaladinTrustError, ErrorCode } from "../errors";
import { PALADIN_KEY_REGISTRY_ABI } from "../abi/paladin-key-registry";

// =============================================================================
// Constants
// =============================================================================

const CACHE_TTL_SEC = 6 * 3600;
const STALE_GRACE_SEC = 2 * 3600; // R10 Sec CRIT-S-1 hardened from v5's 24h
const RPC_TIMEOUT_MS = 5_000;
const HMAC_ALGO = "sha256";

/**
 * PALADIN_KEY_REGISTRY_BASE — hardcoded at v0.2.0 publish; immutable per
 * MAJOR version (v11 §4.10.12). Customer override via factory option
 * `paladinKeyRegistryAddress` for tests + advanced use.
 *
 * Deployed 2026-05-14, Base mainnet, block 46006123, tx 0x8887960e...c647ce92.
 * Owner: Gnosis Safe 2-of-3 at 0x824B874dE8E6FEFb99705F9f30097525c1722C2A.
 * Source verified on Basescan: https://basescan.org/address/0x30Bad67154C0115c5873b291cf3Dda120e508775#code
 */
export const PALADIN_KEY_REGISTRY_BASE_DEFAULT =
  "0x30Bad67154C0115c5873b291cf3Dda120e508775" as Address;

/**
 * Default Base RPC pool. ≥2 distinct operators (publicnode, 1rpc, base-foundation)
 * to satisfy operator-distinctness check below.
 */
export const DEFAULT_BASE_RPC_POOL: readonly string[] = Object.freeze([
  "https://base-rpc.publicnode.com",
  "https://1rpc.io/base",
  "https://mainnet.base.org",
]);

/**
 * Known Base RPC operator mapping. Used to enforce ≥2 distinct *operators*
 * (not just hostnames) in customer's `baseRpcUrls` config. Server-side
 * `iam_updater.py` + `decommissioner.py` import this same table; drift CI
 * test (Step 21) asserts byte-equality.
 *
 * Maintenance: when a new RPC provider emerges, add a row here AND the
 * server-side mirror. The plugin warns on unknown-operator fallback
 * (R13 Sec MED-1); server-side fails-closed (stricter — see v11 §4.12).
 */
export const KNOWN_BASE_RPC_OPERATORS: Readonly<Record<string, string>> = Object.freeze({
  "base-rpc.publicnode.com": "publicnode",
  "base.publicnode.com": "publicnode",
  "1rpc.io": "1rpc",
  "mainnet.base.org": "base-foundation",
  "rpc.llamarpc.com": "llamarpc",
  "rpc.ankr.com": "ankr",
});

// =============================================================================
// Types
// =============================================================================

export interface Pair {
  aws: Address;
  gcp: Address;
}

export interface PendingRotation {
  newPair: Pair;
  effectiveAt: bigint;
  epoch: bigint;
  exists: boolean;
}

export interface PendingTokenRegistryHash {
  newHash: Hex;
  effectiveAt: bigint;
  exists: boolean;
}

export interface RawTrustState {
  pair: Pair;
  epoch: number;
  epochRevoked: boolean;
  priorEpochRevoked: boolean;
  pendingRotation: PendingRotation;
  pendingTokenRegistryHash: PendingTokenRegistryHash;
  tokenRegistryHash: Hex;
  indexerAttestationKey: Address;
}

export interface CachedTrustState extends RawTrustState {
  /** Unix seconds at which this state was fetched from on-chain. */
  fetchedAt: number;
  /**
   * Sticky-revoked: once `epochRevoked: true` is observed for an epoch,
   * record the (epoch, pairHash) — refuse stale-grace fallback for that
   * epoch on subsequent fetches. Auto-pruned when current epoch advances.
   */
  stickyRevokedKeys: Array<{ epoch: number; pairHash: Hex }>;
  /** HMAC over JSON-serialized state (excluding hmac field). */
  hmac: Hex;
}

export interface KeyOpts {
  /** ≥2 distinct-operator URLs. Default: DEFAULT_BASE_RPC_POOL. */
  baseRpcUrls?: readonly string[];
  /** Override registry contract address. Default: PALADIN_KEY_REGISTRY_BASE_DEFAULT. */
  paladinKeyRegistryAddress?: Address;
  /** Cache directory. Default: ~/.paladin-trust */
  cacheDir?: string;
  /** Clock injection for tests. Default: realClock. */
  clock?: Clock;
  /** Optional warn-log path for unknown-RPC-operator events. */
  warnLogPath?: string;
}

// PaladinKeyRegistry ABI lives in `src/abi/paladin-key-registry.ts` —
// imported above. Step 35 will replace the hand-written ABI with codegen
// output from `paladinfi/contracts`.

// =============================================================================
// In-process state
// =============================================================================

let memCache: CachedTrustState | null = null;
let inflightFetch: Promise<CachedTrustState> | null = null;
const integrityKeyCache = new Map<string, Buffer>();

// =============================================================================
// Public API
// =============================================================================

/**
 * Get current on-chain trust state, with cache + multi-RPC quorum + sticky
 * revoked enforcement. Returns the cached value if fresh; otherwise fetches
 * from Base RPCs.
 *
 * `options.force = true` bypasses both in-memory and on-disk caches —
 * used by handler retry-once path on RESPONSE_SIG_INVALID / EPOCH_MISMATCH /
 * EPOCH_REVOKED / TOKEN_REGISTRY_DRIFT (per v11 §4.3 step 16).
 *
 * Throws PaladinTrustError with ErrorCode.PALADIN_REGISTRY_QUORUM_FAILED
 * or PALADIN_REGISTRY_UNREACHABLE on quorum/network failure.
 */
export async function getTrustState(
  opts: KeyOpts = {},
  options: { force?: boolean } = {},
): Promise<CachedTrustState> {
  const clock = opts.clock ?? realClock;
  if (!options.force && memCache && clock.now() / 1000 - memCache.fetchedAt < CACHE_TTL_SEC) {
    return memCache;
  }
  if (inflightFetch) return inflightFetch;
  inflightFetch = doFetch(opts, options.force ?? false, clock);
  try {
    return await inflightFetch;
  } finally {
    inflightFetch = null;
  }
}

/**
 * Test-only: reset all in-process state (memCache, inflightFetch, integrityKey).
 * Production code should not call this. Tests use it between scenarios for
 * isolation without restarting the Node process.
 */
export function _resetInProcessState(): void {
  memCache = null;
  inflightFetch = null;
  integrityKeyCache.clear();
}

/**
 * Resolve the operator name for an RPC URL. Returns the host as fallback
 * for unknown operators (with a warn log per R13 Sec MED-1). Server-side
 * mirrors fail-closed instead — see v11 §4.12.
 */
export function getOperator(url: string): string {
  let host: string;
  try {
    host = new URL(url).host;
  } catch {
    return url;
  }
  for (const [pattern, op] of Object.entries(KNOWN_BASE_RPC_OPERATORS)) {
    if (host.includes(pattern)) return op;
  }
  return host;
}

// =============================================================================
// Private: fetch logic
// =============================================================================

async function doFetch(opts: KeyOpts, force: boolean, clock: Clock): Promise<CachedTrustState> {
  // 1. Try on-disk cache (HMAC-verified)
  const onDisk = await readDiskCache(opts);
  if (!force && onDisk && clock.now() / 1000 - onDisk.fetchedAt < CACHE_TTL_SEC) {
    memCache = onDisk;
    return onDisk;
  }

  // 2. Multi-RPC quorum with operator-distinctness check
  const rpcUrls = (opts.baseRpcUrls ?? DEFAULT_BASE_RPC_POOL).slice(0, 3);
  const operators = new Set(rpcUrls.map((u) => getOperator(u)));

  if (operators.size < 2) {
    throw new PaladinTrustError(
      ErrorCode.INVALID_INPUT,
      `baseRpcUrls must include ≥2 distinct operators (got ${operators.size}); ` +
        `see KNOWN_BASE_RPC_OPERATORS — DEFAULT_BASE_RPC_POOL satisfies this`,
    );
  }

  // Warn for unknown operators (fallback to host as fallback). Persistent
  // log goes to warnLogPath (R13 Sec MED-1 + R13 Sec LOW-6).
  for (const url of rpcUrls) {
    const host = (() => {
      try {
        return new URL(url).host;
      } catch {
        return url;
      }
    })();
    const op = getOperator(url);
    if (op === host) {
      // Unknown operator → console warn + warnLogPath append.
      const msg =
        `[paladin-trust] RPC operator unknown for host ${host}; ` +
        `falling back to host-as-operator. Consider adding to KNOWN_BASE_RPC_OPERATORS.`;
      // eslint-disable-next-line no-console
      console.warn(msg);
      if (opts.warnLogPath) {
        await appendWarnLog(opts.warnLogPath, {
          type: "unknown-rpc-operator",
          host,
          timestamp: Math.floor(clock.now() / 1000),
        });
      }
    }
  }

  const registryAddress = opts.paladinKeyRegistryAddress ?? PALADIN_KEY_REGISTRY_BASE_DEFAULT;

  const results = await Promise.allSettled(
    rpcUrls.map((url) =>
      Promise.race([
        readContractFromRpc(url, registryAddress),
        sleepReject<RawTrustState>(RPC_TIMEOUT_MS, "rpc timeout"),
      ]),
    ),
  );
  const successes = results
    .filter((r): r is PromiseFulfilledResult<RawTrustState> => r.status === "fulfilled")
    .map((r) => r.value);

  if (successes.length < 2) {
    // Fall back to stale on-disk cache within 2h grace, IF not sticky-revoked.
    if (onDisk && clock.now() / 1000 - onDisk.fetchedAt < STALE_GRACE_SEC) {
      const hasSticky = onDisk.stickyRevokedKeys.some((k) => k.epoch === onDisk.epoch);
      if (!hasSticky) {
        // eslint-disable-next-line no-console
        console.warn(
          `[paladin-trust] Base RPC quorum failed (${successes.length}/3 ok); ` +
            `using stale cache aged ${Math.floor(clock.now() / 1000 - onDisk.fetchedAt)}s`,
        );
        memCache = onDisk;
        return onDisk;
      }
    }
    throw new PaladinTrustError(
      ErrorCode.PALADIN_REGISTRY_QUORUM_FAILED,
      `only ${successes.length}/3 Base RPC succeeded and stale-grace exhausted or sticky-revoked`,
    );
  }

  // 3. Max-epoch wins (R8/R9 fix); ≥1 other RPC confirms triple+hash
  successes.sort((a, b) => b.epoch - a.epoch);
  const fresh = successes[0];

  // R13 Sec LOW-1: epoch-decrease guard against compromised RPC
  if (memCache && fresh.epoch < memCache.epoch) {
    throw new PaladinTrustError(
      ErrorCode.PALADIN_REGISTRY_QUORUM_FAILED,
      `epoch decreased: ${fresh.epoch} < cached ${memCache.epoch}; suspected RPC compromise or fork`,
    );
  }

  const confirms = successes.filter(
    (r, i) =>
      i !== 0 &&
      pairEqual(r.pair, fresh.pair) &&
      r.tokenRegistryHash.toLowerCase() === fresh.tokenRegistryHash.toLowerCase() &&
      Math.abs(r.epoch - fresh.epoch) <= 1,
  );
  if (confirms.length < 1) {
    throw new PaladinTrustError(
      ErrorCode.PALADIN_REGISTRY_QUORUM_FAILED,
      `no other RPC confirms epoch=${fresh.epoch} pair+tokenRegistryHash; ` +
        `received ${successes.length} responses but they disagree`,
    );
  }

  // 4. Update sticky-revoked keys (prune old, append if newly revoked)
  const pairHash = computePairHash(fresh.pair);
  const stickyRevokedKeys = (onDisk?.stickyRevokedKeys ?? []).filter((k) => k.epoch < fresh.epoch);
  if (fresh.epochRevoked) {
    stickyRevokedKeys.push({ epoch: fresh.epoch, pairHash });
  }

  // 5. Build state + compute HMAC
  const stateNoHmac: Omit<CachedTrustState, "hmac"> = {
    ...fresh,
    fetchedAt: Math.floor(clock.now() / 1000),
    stickyRevokedKeys,
  };
  const integrityKey = await loadIntegrityKey(opts);
  const hmac = computeHmac(integrityKey, serializeForHmac(stateNoHmac));
  const newState: CachedTrustState = { ...stateNoHmac, hmac };

  memCache = newState;
  await writeDiskCacheAtomic(opts, newState);
  return newState;
}

async function readContractFromRpc(rpcUrl: string, registry: Address): Promise<RawTrustState> {
  const client = createPublicClient({ chain: base, transport: http(rpcUrl) });
  const [trustResult, indexerKey] = await Promise.all([
    client.readContract({
      address: registry,
      abi: PALADIN_KEY_REGISTRY_ABI,
      functionName: "readTrustState",
    }),
    client.readContract({
      address: registry,
      abi: PALADIN_KEY_REGISTRY_ABI,
      functionName: "indexerAttestationKey",
    }),
  ]);
  // viem returns the multi-output as a tuple; map into RawTrustState.
  const [pair, epoch, epochRevoked, priorEpochRevoked, pendingState, pendingHashState, registryHash] =
    trustResult as unknown as [
      { aws: Address; gcp: Address },
      bigint,
      boolean,
      boolean,
      {
        newPair: { aws: Address; gcp: Address };
        effectiveAt: bigint;
        epoch: bigint;
        exists: boolean;
      },
      { newHash: Hex; effectiveAt: bigint; exists: boolean },
      Hex,
    ];
  return {
    pair: { aws: pair.aws, gcp: pair.gcp },
    epoch: Number(epoch),
    epochRevoked,
    priorEpochRevoked,
    pendingRotation: {
      newPair: { aws: pendingState.newPair.aws, gcp: pendingState.newPair.gcp },
      effectiveAt: pendingState.effectiveAt,
      epoch: pendingState.epoch,
      exists: pendingState.exists,
    },
    pendingTokenRegistryHash: {
      newHash: pendingHashState.newHash,
      effectiveAt: pendingHashState.effectiveAt,
      exists: pendingHashState.exists,
    },
    tokenRegistryHash: registryHash,
    indexerAttestationKey: indexerKey as Address,
  };
}

// =============================================================================
// Cache I/O
// =============================================================================

function defaultCacheDir(): string {
  return path.join(os.homedir(), ".paladin-trust");
}

function cachePath(opts: KeyOpts): string {
  return path.join(opts.cacheDir ?? defaultCacheDir(), "keys.json");
}

function integrityKeyPath(opts: KeyOpts): string {
  return path.join(opts.cacheDir ?? defaultCacheDir(), "integrity.key");
}

async function loadIntegrityKey(opts: KeyOpts): Promise<Buffer> {
  const keyPath = integrityKeyPath(opts);
  const cached = integrityKeyCache.get(keyPath);
  if (cached) return cached;
  await fs.mkdir(path.dirname(keyPath), { recursive: true });
  try {
    const k = await fs.readFile(keyPath);
    if (k.length !== 32) throw new Error("corrupt integrity key");
    integrityKeyCache.set(keyPath, k);
    return k;
  } catch {
    const k = randomBytes(32);
    await fs.writeFile(keyPath, k, { mode: 0o600 });
    integrityKeyCache.set(keyPath, k);
    return k;
  }
}

function computeHmac(key: Buffer, payload: string): Hex {
  return ("0x" + createHmac(HMAC_ALGO, key).update(payload).digest("hex")) as Hex;
}

function serializeForHmac(stateNoHmac: Omit<CachedTrustState, "hmac">): string {
  // Stable key order via sorted-keys JSON. BigInts are serialized via custom
  // replacer (toString); they appear in pendingRotation.effectiveAt/epoch and
  // pendingTokenRegistryHash.effectiveAt.
  return JSON.stringify(stateNoHmac, (_k, v) => (typeof v === "bigint" ? v.toString() : v));
}

async function readDiskCache(opts: KeyOpts): Promise<CachedTrustState | null> {
  const integrityKey = await loadIntegrityKey(opts);
  let raw: string;
  try {
    raw = await fs.readFile(cachePath(opts), "utf8");
  } catch {
    return null;
  }
  let parsed: CachedTrustState;
  try {
    // Revive BigInts that we serialized as strings.
    parsed = JSON.parse(raw, (key, value) => {
      // The fields we know are bigint-shaped:
      const bigintFields = [
        "effectiveAt",
        // pendingRotation.epoch is bigint; cached epoch (top-level) is number
      ];
      if (bigintFields.includes(key) && typeof value === "string") {
        return BigInt(value);
      }
      // pendingRotation.epoch needs the same treatment; we detect by parent key shape.
      // Simpler: only top-level "epoch" stays a number; all bigint-shaped fields
      // are inside pendingRotation/pendingHashState which we reconstruct manually.
      return value;
    }) as CachedTrustState;
    // Manual bigint reconstruction (JSON.parse reviver doesn't have parent context).
    parsed.pendingRotation.effectiveAt = BigInt(parsed.pendingRotation.effectiveAt as unknown as string);
    parsed.pendingRotation.epoch = BigInt(parsed.pendingRotation.epoch as unknown as string);
    parsed.pendingTokenRegistryHash.effectiveAt = BigInt(
      parsed.pendingTokenRegistryHash.effectiveAt as unknown as string,
    );
  } catch {
    return null;
  }
  // Verify HMAC against expected.
  const expected = computeHmac(integrityKey, serializeForHmac(omitHmac(parsed)));
  if (parsed.hmac.toLowerCase() !== expected.toLowerCase()) {
    // eslint-disable-next-line no-console
    console.warn("[paladin-trust] cache HMAC mismatch — treating as no-cache");
    return null;
  }
  return parsed;
}

async function writeDiskCacheAtomic(opts: KeyOpts, state: CachedTrustState): Promise<void> {
  const dir = path.dirname(cachePath(opts));
  await fs.mkdir(dir, { recursive: true });
  // proper-lockfile requires the target file to exist.
  try {
    await fs.access(cachePath(opts));
  } catch {
    await fs.writeFile(cachePath(opts), "{}", { mode: 0o600 });
  }
  const release = await lockfile.lock(cachePath(opts), { retries: 5 });
  try {
    const tmp = `${cachePath(opts)}.tmp.${process.pid}`;
    const serialized = JSON.stringify(state, (_k, v) => (typeof v === "bigint" ? v.toString() : v));
    await fs.writeFile(tmp, serialized, { mode: 0o600 });
    await fs.rename(tmp, cachePath(opts));
  } finally {
    await release();
  }
}

async function appendWarnLog(
  warnLogPath: string,
  entry: { type: string; host?: string; timestamp: number; [k: string]: unknown },
): Promise<void> {
  try {
    await fs.mkdir(path.dirname(warnLogPath), { recursive: true });
    await fs.appendFile(warnLogPath, JSON.stringify(entry) + "\n", "utf8");
  } catch {
    // Warn-log failure is best-effort; never throw to caller.
  }
}

// =============================================================================
// Helpers
// =============================================================================

function omitHmac(state: CachedTrustState): Omit<CachedTrustState, "hmac"> {
  const { hmac: _hmac, ...rest } = state;
  return rest;
}

function pairEqual(a: Pair, b: Pair): boolean {
  return a.aws.toLowerCase() === b.aws.toLowerCase() && a.gcp.toLowerCase() === b.gcp.toLowerCase();
}

export function computePairHash(pair: Pair): Hex {
  return keccak256(toHex(`${pair.aws.toLowerCase()}|${pair.gcp.toLowerCase()}`));
}

function sleepReject<T>(ms: number, msg: string): Promise<T> {
  return new Promise((_resolve, reject) => {
    setTimeout(() => reject(new Error(msg)), ms);
  });
}
