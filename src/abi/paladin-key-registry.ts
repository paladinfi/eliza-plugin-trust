/**
 * PaladinKeyRegistry contract ABI — exported as a viem-friendly `as const`
 * tuple so `readContract` infers the return shape correctly.
 *
 * Shape mirrors `paladinfi/contracts/src/PaladinKeyRegistry.sol` per v11 §4.10.6:
 *   - readTrustState() → (Pair, uint256, bool, bool, PendingRotation,
 *                         PendingTokenRegistryHash, bytes32)
 *   - indexerAttestationKey() → address
 *
 * Additional functions (proposeRotation, finalizeRotation, cancelRotation,
 * revoke, transferOwnership, proposeTokenRegistryHashChange,
 * finalizeTokenRegistryHashChange, cancelTokenRegistryHashChange,
 * proposeIndexerKeyChange, finalizeIndexerKeyChange, cancelIndexerKeyChange)
 * are included for completeness — used by `scripts/rotate_key.py` and
 * `paladin-iam-updater` server-side, NOT by the plugin client.
 *
 * Drift CI test (Step 21): assert byte-equality with contract source's
 * compiled ABI at `paladinfi/contracts/dist/PaladinKeyRegistry.json`.
 *
 * Step 35 will replace this hand-written ABI with `paladinfi/contracts`-
 * sourced codegen output. Until then, this is the canonical client-side
 * contract surface.
 */

export const PALADIN_KEY_REGISTRY_ABI = [
  // -- view: readTrustState --------------------------------------------------
  {
    type: "function",
    name: "readTrustState",
    inputs: [],
    outputs: [
      {
        type: "tuple",
        name: "pair",
        components: [
          { type: "address", name: "aws" },
          { type: "address", name: "gcp" },
        ],
      },
      { type: "uint256", name: "epoch" },
      { type: "bool", name: "epochRevoked" },
      { type: "bool", name: "priorEpochRevoked" },
      {
        type: "tuple",
        name: "pendingState",
        components: [
          {
            type: "tuple",
            name: "newPair",
            components: [
              { type: "address", name: "aws" },
              { type: "address", name: "gcp" },
            ],
          },
          { type: "uint256", name: "effectiveAt" },
          { type: "uint256", name: "epoch" },
          { type: "bool", name: "exists" },
        ],
      },
      {
        type: "tuple",
        name: "pendingHashState",
        components: [
          { type: "bytes32", name: "newHash" },
          { type: "uint256", name: "effectiveAt" },
          { type: "bool", name: "exists" },
        ],
      },
      { type: "bytes32", name: "registryHash" },
    ],
    stateMutability: "view",
  },

  // -- view: indexerAttestationKey ------------------------------------------
  {
    type: "function",
    name: "indexerAttestationKey",
    inputs: [],
    outputs: [{ type: "address", name: "" }],
    stateMutability: "view",
  },

  // -- view: currentEpoch (convenience) -------------------------------------
  {
    type: "function",
    name: "currentEpoch",
    inputs: [],
    outputs: [{ type: "uint256", name: "" }],
    stateMutability: "view",
  },

  // -- view: revoked (mapping accessor) -------------------------------------
  {
    type: "function",
    name: "revoked",
    inputs: [{ type: "uint256", name: "epoch" }],
    outputs: [{ type: "bool", name: "" }],
    stateMutability: "view",
  },

  // -- events ---------------------------------------------------------------
  {
    type: "event",
    name: "RotationProposed",
    inputs: [
      { type: "uint256", name: "epoch", indexed: true },
      {
        type: "tuple",
        name: "newPair",
        indexed: false,
        components: [
          { type: "address", name: "aws" },
          { type: "address", name: "gcp" },
        ],
      },
      { type: "uint256", name: "effectiveAt", indexed: false },
    ],
    anonymous: false,
  },
  {
    type: "event",
    name: "RotationFinalized",
    inputs: [
      { type: "uint256", name: "epoch", indexed: true },
      {
        type: "tuple",
        name: "newPair",
        indexed: false,
        components: [
          { type: "address", name: "aws" },
          { type: "address", name: "gcp" },
        ],
      },
    ],
    anonymous: false,
  },
  {
    type: "event",
    name: "RotationCancelled",
    inputs: [{ type: "uint256", name: "epoch", indexed: true }],
    anonymous: false,
  },
  {
    type: "event",
    name: "Revoked",
    inputs: [
      { type: "uint256", name: "epoch", indexed: true },
      { type: "string", name: "reason", indexed: false },
    ],
    anonymous: false,
  },
  {
    type: "event",
    name: "TokenRegistryHashProposed",
    inputs: [
      { type: "bytes32", name: "newHash", indexed: false },
      { type: "uint256", name: "effectiveAt", indexed: false },
    ],
    anonymous: false,
  },
  {
    type: "event",
    name: "TokenRegistryHashFinalized",
    inputs: [
      { type: "bytes32", name: "oldHash", indexed: false },
      { type: "bytes32", name: "newHash", indexed: false },
    ],
    anonymous: false,
  },
  {
    type: "event",
    name: "TokenRegistryHashCancelled",
    inputs: [],
    anonymous: false,
  },
  {
    type: "event",
    name: "IndexerKeyFinalized",
    inputs: [
      { type: "address", name: "oldKey", indexed: false },
      { type: "address", name: "newKey", indexed: false },
    ],
    anonymous: false,
  },
  {
    type: "event",
    name: "OwnerChanged",
    inputs: [
      { type: "address", name: "previousOwner", indexed: true },
      { type: "address", name: "newOwner", indexed: true },
    ],
    anonymous: false,
  },
] as const;
