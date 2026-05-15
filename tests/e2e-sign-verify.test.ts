/**
 * Cross-language end-to-end sign-then-verify test.
 *
 * R16 HIGH-A/B/C insurance: the bug those findings caught (plugin and server
 * could not interoperate at the wire level) was invisible to the existing
 * test suite because both sides mocked the integration boundary. This test
 * exercises the FULL signing protocol on the TypeScript side using the same
 * primitives the production server uses (keccak256 of DOMAIN_SEPARATOR ||
 * canonical bytes; ECDSA over secp256k1 with low-s normalization; flat
 * response shape with awsSignature + gcpSignature at top level).
 *
 * If the server changes its signing protocol (different domain separator,
 * different shape, different canonicalization), this test should fail
 * immediately. Cross-language byte-equality of the DIGEST PREFIX is
 * structurally enforced by `tests/fixtures/domain-separators-parity.json`
 * + the Python parity test at
 * `paladin-server/tests/test_domain_separator_parity.py`. A Python sibling
 * that signs the SAME envelope with the SAME keys is a follow-up backlog
 * item (R16 Eng MED-2 ish).
 */
import { describe, it, expect } from "vitest";
import {
  privateKeyToAccount,
  type PrivateKeyAccount,
} from "viem/accounts";
import { sign } from "viem/accounts";
import { keccak256, toHex, concat, type Hex } from "viem";

import { canonicalize } from "../src/utils/paladin-canonical";
import {
  verifyAndExtract,
  type SignedSimulateResponse,
  type VerifyOpts,
  DEFAULT_FRESHNESS_WINDOW_SEC,
  DEFAULT_ACCEPT_VERSIONS,
} from "../src/utils/paladin-verify";
import { DOMAIN_SEPARATOR_SIMULATE } from "../src/shared/domain-separators";
import { TOKEN_REGISTRY_HASH } from "../src/utils/sell-caps";
import type { CachedTrustState } from "../src/utils/paladin-keys";
import type { Clock } from "../src/utils/clock";
import { ErrorCode, PaladinTrustError } from "../src/errors";

// =============================================================================
// Fixed deterministic keys (TEST ONLY — never used in production).
// =============================================================================

const AWS_PK: Hex =
  "0x1111111111111111111111111111111111111111111111111111111111111111";
const GCP_PK: Hex =
  "0x2222222222222222222222222222222222222222222222222222222222222222";

const AWS_ACCOUNT: PrivateKeyAccount = privateKeyToAccount(AWS_PK);
const GCP_ACCOUNT: PrivateKeyAccount = privateKeyToAccount(GCP_PK);

const FROZEN_NOW_MS = 1_700_000_000_000;
const fixedClock: Clock = { now: () => FROZEN_NOW_MS };

const SECP256K1_N =
  0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
const SECP256K1_HALF_N = SECP256K1_N / 2n;

/**
 * Sign a digest with low-s normalization, returning a 65-byte compact
 * (r || s || v). Matches the server's CompactSignature.bytes output exactly.
 */
async function signCompactLowS(digest: Hex, privateKey: Hex): Promise<Hex> {
  const sigObj = await sign({
    hash: digest,
    privateKey,
  });
  let { r, s, yParity } = sigObj;
  let sBig = BigInt(s);
  if (sBig > SECP256K1_HALF_N) {
    sBig = SECP256K1_N - sBig;
    yParity = (yParity ^ 1) as 0 | 1;
  }
  const rHex = BigInt(r).toString(16).padStart(64, "0");
  const sHex = sBig.toString(16).padStart(64, "0");
  const v = yParity === 0 ? 27 : 28;
  const vHex = v.toString(16).padStart(2, "0");
  return `0x${rHex}${sHex}${vHex}` as Hex;
}

/**
 * Build a signed envelope mirroring the server's response_body construction.
 * Critical: the canonical bytes the digest covers must EXCLUDE the signature
 * fields, mirroring server's
 * `paladin_simulator_service.py:592-595` (canonicalize THEN add sigs).
 */
async function buildSignedFlatEnvelope(args: {
  apiVersion: string;
  epoch: number;
  requestHash: Hex;
  clientNonce: Hex;
  signedAt: number;
  serverObservedTokenRegistryHash: Hex;
  ok: boolean;
  result?: SignedSimulateResponse["result"];
  error?: string;
}): Promise<SignedSimulateResponse> {
  const signingInput: Omit<
    SignedSimulateResponse,
    "awsSignature" | "gcpSignature"
  > = {
    apiVersion: args.apiVersion,
    epoch: args.epoch,
    requestHash: args.requestHash,
    clientNonce: args.clientNonce,
    signedAt: args.signedAt,
    serverObservedTokenRegistryHash: args.serverObservedTokenRegistryHash,
    ok: args.ok,
    ...(args.result ? { result: args.result } : {}),
    ...(args.error !== undefined ? { error: args.error } : {}),
  };

  const canonical = canonicalize(signingInput);
  // v2 (2026-05-15 hardening): digest = keccak256(DOMAIN_HASH || keccak256(JCS(body)))
  // where DOMAIN_HASH is the 32-byte keccak256("PaladinFi/simulate/v2").
  // Mirror of src/utils/paladin-verify.ts:319-322.
  const bodyHash = keccak256(toHex(canonical));
  const digest = keccak256(
    concat([DOMAIN_SEPARATOR_SIMULATE, bodyHash]),
  );
  const awsSignature = await signCompactLowS(digest, AWS_PK);
  const gcpSignature = await signCompactLowS(digest, GCP_PK);

  return {
    ...signingInput,
    awsSignature,
    gcpSignature,
  };
}

// =============================================================================
// Test cases
// =============================================================================

describe("E2E sign-then-verify (R16 cross-language insurance)", () => {
  const trustState: CachedTrustState = {
    epoch: 0,
    epochRevoked: false,
    priorEpochRevoked: false,
    pair: {
      aws: AWS_ACCOUNT.address,
      gcp: GCP_ACCOUNT.address,
    },
    indexerAttestationKey: "0x0000000000000000000000000000000000000003",
    tokenRegistryHash: TOKEN_REGISTRY_HASH,
    pendingRotation: {
      newPair: { aws: "0x" + "0".repeat(40), gcp: "0x" + "0".repeat(40) } as {
        aws: `0x${string}`;
        gcp: `0x${string}`;
      },
      effectiveAt: 0n,
      epoch: 0n,
      exists: false,
    },
    pendingTokenRegistryHash: {
      newHash: "0x" + "0".repeat(64) as Hex,
      effectiveAt: 0n,
      exists: false,
    },
    fetchedAt: FROZEN_NOW_MS,
    stickyRevokedKeys: [],
    hmac: "0x" + "0".repeat(64) as Hex,
  };

  const expectedRequestHash =
    "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" as Hex;
  const expectedClientNonce =
    "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" as Hex;

  function makeOpts(signed: SignedSimulateResponse): VerifyOpts {
    return {
      signed,
      trustState,
      expectedRequestHash,
      expectedClientNonce,
      freshnessWindowSec: DEFAULT_FRESHNESS_WINDOW_SEC,
      acceptVersions: DEFAULT_ACCEPT_VERSIONS,
      highestVersionEverSeen: { value: "paladin-simulate-v2" },
      clock: fixedClock,
    };
  }

  it("verifies a fresh server-shape ok=true response signed with both keys", async () => {
    const signed = await buildSignedFlatEnvelope({
      apiVersion: "paladin-simulate-v2",
      epoch: 0,
      requestHash: expectedRequestHash,
      clientNonce: expectedClientNonce,
      signedAt: Math.floor(FROZEN_NOW_MS / 1000) - 10,
      serverObservedTokenRegistryHash: TOKEN_REGISTRY_HASH,
      ok: true,
      result: {
        senderBalanceBeforeToken: "1000000",
        senderBalanceAfterToken: "0",
        expectedBalanceChange: "999000",
        ethBalanceBefore: "1000000000000000000",
        ethBalanceAfter: "999000000000000000",
        gasUsed: 250000,
        deltas: {
          "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913": "-1000000",
          "0x4200000000000000000000000000000000000006": "999000",
        },
        ethDelta: "-1000000000000000000",
        forkAge: 0,
      },
    });

    const extract = await verifyAndExtract(makeOpts(signed));
    expect(extract.ok).toBe(true);
    expect(extract.apiVersion).toBe("paladin-simulate-v2");
    expect(extract.epoch).toBe(0);
    expect(extract.result).toBeDefined();
    expect(extract.result?.gasUsed).toBe(250000);
  });

  it("verifies a fresh ok=false response with error string", async () => {
    const signed = await buildSignedFlatEnvelope({
      apiVersion: "paladin-simulate-v2",
      epoch: 0,
      requestHash: expectedRequestHash,
      clientNonce: expectedClientNonce,
      signedAt: Math.floor(FROZEN_NOW_MS / 1000) - 10,
      serverObservedTokenRegistryHash: TOKEN_REGISTRY_HASH,
      ok: false,
      error: "tx_reverted_at_block_12345",
    });

    const extract = await verifyAndExtract(makeOpts(signed));
    expect(extract.ok).toBe(false);
    expect(extract.error).toBe("tx_reverted_at_block_12345");
    expect(extract.result).toBeUndefined();
  });

  it("rejects when AWS signature is tampered (single byte flip)", async () => {
    const signed = await buildSignedFlatEnvelope({
      apiVersion: "paladin-simulate-v2",
      epoch: 0,
      requestHash: expectedRequestHash,
      clientNonce: expectedClientNonce,
      signedAt: Math.floor(FROZEN_NOW_MS / 1000) - 10,
      serverObservedTokenRegistryHash: TOKEN_REGISTRY_HASH,
      ok: true,
      result: {
        senderBalanceBeforeToken: "0",
        senderBalanceAfterToken: "0",
        expectedBalanceChange: "0",
        ethBalanceBefore: "0",
        ethBalanceAfter: "0",
        gasUsed: 0,
        deltas: {},
        ethDelta: "0",
        forkAge: 0,
      },
    });

    // Flip the FIRST hex char after 0x in awsSignature (changes r by ~1 byte).
    const orig = signed.awsSignature;
    const flipped = `0x${orig[2] === "f" ? "0" : "f"}${orig.slice(3)}` as Hex;
    const tampered: SignedSimulateResponse = {
      ...signed,
      awsSignature: flipped,
    };

    await expect(verifyAndExtract(makeOpts(tampered))).rejects.toThrow(
      PaladinTrustError,
    );
  });

  it("rejects when payload field is mutated post-signing", async () => {
    const signed = await buildSignedFlatEnvelope({
      apiVersion: "paladin-simulate-v2",
      epoch: 0,
      requestHash: expectedRequestHash,
      clientNonce: expectedClientNonce,
      signedAt: Math.floor(FROZEN_NOW_MS / 1000) - 10,
      serverObservedTokenRegistryHash: TOKEN_REGISTRY_HASH,
      ok: true,
      result: {
        senderBalanceBeforeToken: "0",
        senderBalanceAfterToken: "0",
        expectedBalanceChange: "0",
        ethBalanceBefore: "0",
        ethBalanceAfter: "0",
        gasUsed: 0,
        deltas: {},
        ethDelta: "0",
        forkAge: 0,
      },
    });

    // Attacker changes `epoch` after sigs — hash mismatch should reject.
    const mutated: SignedSimulateResponse = {
      ...signed,
      epoch: 99,
    };

    // The epoch-mismatch check fires before signature verification because
    // verifier checks epoch == trustState.epoch first. That's fine — both
    // paths reject the tampering.
    await expect(verifyAndExtract(makeOpts(mutated))).rejects.toThrow(
      PaladinTrustError,
    );
  });

  it("rejects when canonical-input was signed without the domain separator", async () => {
    const signingInput = {
      apiVersion: "paladin-simulate-v2",
      epoch: 0,
      requestHash: expectedRequestHash,
      clientNonce: expectedClientNonce,
      signedAt: Math.floor(FROZEN_NOW_MS / 1000) - 10,
      serverObservedTokenRegistryHash: TOKEN_REGISTRY_HASH,
      ok: true,
      result: {
        senderBalanceBeforeToken: "0",
        senderBalanceAfterToken: "0",
        expectedBalanceChange: "0",
        ethBalanceBefore: "0",
        ethBalanceAfter: "0",
        gasUsed: 0,
        deltas: {},
        ethDelta: "0",
        forkAge: 0,
      },
    };

    const canonical = canonicalize(signingInput);
    // Compute digest WITHOUT the domain separator (the pre-R16 server bug).
    const wrongDigest = keccak256(toHex(canonical));
    const awsSignature = await signCompactLowS(wrongDigest, AWS_PK);
    const gcpSignature = await signCompactLowS(wrongDigest, GCP_PK);

    const signed: SignedSimulateResponse = {
      ...signingInput,
      awsSignature,
      gcpSignature,
    };

    // Verifier prepends the domain separator → recovered address mismatches.
    await expect(verifyAndExtract(makeOpts(signed))).rejects.toThrow(
      PaladinTrustError,
    );
  });

  it("low-s normalization: signing returns s ≤ N/2", async () => {
    const digest =
      "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" as Hex;
    const compact = await signCompactLowS(digest, AWS_PK);
    const sHex = compact.slice(66, 130); // bytes 32-63 of compact
    const sBig = BigInt("0x" + sHex);
    expect(sBig <= SECP256K1_HALF_N).toBe(true);
  });
});
