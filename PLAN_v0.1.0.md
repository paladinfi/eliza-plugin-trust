# `@paladinfi/eliza-plugin-trust` v0.1.0 Implementation Plan — v3.1

**Status:** APPROVED-WITH-MINOR-FIXES (v3 reviews convergent; v3.1 incorporates Engineering + Security + Maintainer polish)
**Public deadline:** ≤ 2026-05-16 (per Eliza Discussion #7242 follow-up comment)
**Drafted:** 2026-05-03 (v3 after v1 + v2 both REJECTED at adversarial review; v3 informed by 30-min `@x402/fetch@2.11.0` spike against live `/v1/trust-check`; v3.1 polish 2026-05-04)
**Tracking issue:** [#1](https://github.com/paladinfi/eliza-plugin-trust/issues/1)

## Spike confirmation (empirical, 2026-05-03)

Ran `@x402/fetch@2.11.0` + `@x402/evm` + `@x402/core` against live `https://swap.paladinfi.com/v1/trust-check`. All assumptions verified:

- ✅ `wrapFetchWithPayment(fetch, client)` API exists; takes `x402Client` instance (not viem WalletClient)
- ✅ `client.onBeforePaymentCreation(hook)` fires BEFORE any signing, with `context.selectedRequirements` containing parsed challenge
- ✅ `selectedRequirements` shape matches PaladinFi server byte-for-byte:
  - `scheme: "exact"`, `network: "eip155:8453"`
  - `asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"` (USDC)
  - `amount: "1000"` ($0.001), `payTo: "0xeA8C33d0...834b4"` (treasury)
  - `extra.name: "USD Coin"`, `extra.version: "2"`, `maxTimeoutSeconds: 300`
- ✅ Hook can abort via `return { abort: true, reason: string }` to prevent signing
- ✅ Hook can return `undefined` to permit signing; library handles nonce + validity window via `@x402/evm`

The spike used a random-key account (no balance) — pre-sign flow completed correctly; settlement returned 500 (expected, 0 USDC). With a funded wallet, settlement succeeds.

## What changed from v2 to v3 (14 convergent fixes)

1. ✅ **Use `@x402/fetch@2.11.0`** (not deprecated `x402-fetch@1`). Confirmed: v2 reads challenge from `payment-required` header (matches live server); v1 read from body and would throw.
2. ✅ **`onBeforePaymentCreation` hook for pre-sign validation.** Closes the F1 wallet-drain footgun properly — validation runs against the actual `selectedRequirements` the library is about to sign, not a separate probe.
3. ✅ **Pin `@x402/fetch` exact** + `@x402/evm` exact + `@x402/core` exact. No caret. Plus `npm audit signatures` in CI.
4. ✅ **Dedicated plugin-test wallet** — generate fresh EOA, fund with $0.05 USDC + dust ETH on Base. Key in `.env.local` (gitignored). NEVER use the EC2 trading wallet `0xF6c99CEc...`.
5. ✅ **Boot-time validation in `resolveConfig`** — throw synchronously if `mode === "paid"` but `walletClient` (or its account/chain) is wrong. Not lazy at first `paid()` call.
6. ✅ **`PALADIN_TRUST_ALLOW_INSECURE` ignored in paid mode** — paid is HTTPS-only, always.
7. ✅ **`apiBase` hard-coded production URL constant.** Override requires `PALADIN_TRUST_API_BASE_OVERRIDE_ACK=1` env.
8. ✅ **`walletClient` non-enumerable / private** in `PaladinTrustClient`. Document "do not stringify the client" in README.
9. ✅ **`scrubViemError(e: unknown): string` helper** for paid-path error sites; never propagate raw `error.cause` (could leak signed payload via viem's debug chain).
10. ✅ **Validate `extra.name === "USD Coin"` and `extra.version === "2"`** in the hook (EIP-712 domain integrity).
11. ✅ **Tests in project-root `tests/`**, NOT `src/`. Update tsconfig + add vitest config. Avoids shipping test source in tarball.
12. ✅ **Fix `composeState` third-arg** — it's `onlyInclude` (filter), not "run providers". Comment the call accordingly.
13. ✅ **`walletClient` injection path: factory pattern.** Plan exports `createPaladinTrustPlugin({ walletClient })` returning Plugin with closure. Plugin object lacks `walletClient` (it's encapsulated in the closure). Runtime `EVM_PRIVATE_KEY` resolution deferred to v0.2.0 — README "Migration from v0.0.x" makes this explicit.
14. ✅ **Pre-implementation 30-min spike DONE** — confirmed wire format + API. Plan is now empirical, not speculative.

## Goals (must-have for v0.1.0)

1. **LLM prompt-template extraction** — `paladin_trust_check` extracts `address` / `chainId` / `taker` from natural-language messages via `composePromptFromState` + `runtime.useModel(ModelType.TEXT_SMALL)` + `parseKeyValueXml`.

2. **Paid x402 settlement** in `PaladinTrustClient.paid()` via `@x402/fetch@2.11.0` + `onBeforePaymentCreation` hook running `validatePaladinChallenge()` for client-side equality checks against TREASURY/ASSET/NETWORK/MAX_AMOUNT before signing.

3. **Wallet client injection via factory** — `createPaladinTrustPlugin({ walletClient })` returns `Plugin` object. Default plugin export (`paladinTrustPlugin`) remains available with paid mode disabled.

4. **Validator wallet-readiness gate** in paid mode (mirror plugin-evm's `hasEvmPrivateKey`).

5. **Bumped version** `0.0.2` → `0.1.0`, published to npm, GitHub release tagged.

## Out of scope (defer to v0.2.0+)

- Multi-chain support — Base only at v0.1.0.
- Full validator factory pattern (`createTrustCheckActionValidator`) — keep regex + wallet-readiness inline.
- Confirmation flow (`confirmationRequired` / `isConfirmed`) — $0.001 micropayment doesn't warrant pre-confirm friction.
- Vitest broad test suite — ship targeted tests for x402 validation + boot-time check.
- TOON-format compatibility / build:prompts script.
- Runtime `EVM_PRIVATE_KEY` auto-resolution (defer to v0.2.0).

## Architecture

### File structure

```
src/
├── actions/
│   └── trust-check.ts        [MODIFIED — wire LLM extraction; remove paid-mode degrade]
├── templates/
│   └── trust-check.ts        [NEW — prompt template string constant]
├── client.ts                 [MODIFIED — implement paid() via @x402/fetch + hook]
├── config.ts                 [MODIFIED — add walletClient param; boot-time validation; HTTPS-only-in-paid]
├── x402/
│   ├── constants.ts          [NEW — TREASURY, ASSET, NETWORK, MAX_AMOUNT, X402_VERSION, USDC_DOMAIN_NAME, USDC_DOMAIN_VERSION]
│   └── validate.ts           [NEW — validatePaladinChallenge(reqs) used inside the onBeforePaymentCreation hook]
├── errors.ts                 [NEW — scrubViemError helper + sanitized error class]
├── types.ts                  [MODIFIED — add walletClient to PaladinTrustConfig type]
└── index.ts                  [MODIFIED — export createPaladinTrustPlugin factory + symbols]

tests/                        [NEW — directory at project root]
├── x402-validate.test.ts     [vitest test for validatePaladinChallenge]
└── boot-validation.test.ts   [vitest test for resolveConfig throwing in paid mode w/o walletClient]

vitest.config.ts              [NEW — minimal vitest config]
CHANGELOG.md                  [MODIFIED — promote v0.1.0]
README.md                     [MODIFIED — natural-language example, paid-mode wiring docs, v0.0.x→v0.1.0 migration]
package.json                  [MODIFIED — version 0.1.0, exact pin @elizaos/core, add @x402/fetch + @x402/evm + @x402/core deps, vitest devDep, test script]
```

### Component design

**1. Prompt template (`src/templates/trust-check.ts`)** — same as v2 plan.

**2. x402 constants (`src/x402/constants.ts`)**

```ts
export const PALADIN_TREASURY = "0xeA8C33d018760D034384e92D1B2a7cf0338834b4" as const;
export const BASE_USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" as const;
export const BASE_NETWORK = "eip155:8453" as const;
export const MAX_TRUST_CHECK_AMOUNT = 10_000n; // $0.01 cap, 10× expected $0.001
export const X402_VERSION = 2 as const;
export const USDC_DOMAIN_NAME = "USD Coin" as const;
export const USDC_DOMAIN_VERSION = "2" as const;
export const PALADIN_API_DEFAULT = "https://swap.paladinfi.com" as const;
```

**3. x402 validator (`src/x402/validate.ts`) — v3.1 hardened post-review**

Validates BOTH `paymentRequired` (top-level) AND `selectedRequirements` (the actual fields about to be signed). Closes Permit2 downgrade, v1 downgrade, long-lived-signature vectors.

```ts
import { PALADIN_TREASURY, BASE_USDC, BASE_NETWORK, MAX_TRUST_CHECK_AMOUNT, USDC_DOMAIN_NAME, USDC_DOMAIN_VERSION, X402_VERSION, MAX_VALIDITY_SECONDS } from "./constants.js";

export interface ValidationResult {
  ok: boolean;
  reason?: string;
}

/** Runs inside onBeforePaymentCreation hook. Receives full context (paymentRequired + selectedRequirements). */
export function validatePaladinContext(context: any): ValidationResult {
  // 1. Protocol version — reject anything other than v2 (v1 has different field shape, v3 is unbounded)
  const wireVersion = context?.paymentRequired?.x402Version;
  if (wireVersion !== X402_VERSION) {
    return { ok: false, reason: `x402Version=${wireVersion} not allowed (expected ${X402_VERSION})` };
  }

  const reqs = context?.selectedRequirements;
  if (!reqs || typeof reqs !== "object") return { ok: false, reason: "no selectedRequirements" };

  // 2. Asset transfer method — reject Permit2 (different signing semantics, allows arbitrary spender)
  const method = reqs.extra?.assetTransferMethod ?? "eip3009";
  if (method !== "eip3009") {
    return { ok: false, reason: `assetTransferMethod=${method} not allowed (expected eip3009)` };
  }

  // 3. Scheme + network + asset + payTo — equality with hard-coded constants
  if (reqs.scheme !== "exact") return { ok: false, reason: `scheme=${reqs.scheme} (expected exact)` };
  if (reqs.network !== BASE_NETWORK) return { ok: false, reason: `network=${reqs.network} (expected ${BASE_NETWORK})` };
  if (String(reqs.asset).toLowerCase() !== BASE_USDC.toLowerCase()) return { ok: false, reason: `asset=${reqs.asset} (expected USDC)` };
  if (String(reqs.payTo).toLowerCase() !== PALADIN_TREASURY.toLowerCase()) return { ok: false, reason: `payTo=${reqs.payTo} (expected PaladinFi treasury)` };

  // 4. Amount cap — $0.01 max
  let amount: bigint;
  try { amount = BigInt(reqs.amount); } catch { return { ok: false, reason: `amount=${reqs.amount} (not a valid bigint)` }; }
  if (amount > MAX_TRUST_CHECK_AMOUNT) return { ok: false, reason: `amount=${amount} exceeds cap ${MAX_TRUST_CHECK_AMOUNT}` };

  // 5. Validity window — server controls maxTimeoutSeconds (used as validBefore in EIP-3009).
  // Reject long-lived-signature vector: an attacker server could request a 1-year valid sig.
  const t = Number(reqs.maxTimeoutSeconds);
  if (!Number.isFinite(t) || t <= 0 || t > MAX_VALIDITY_SECONDS) {
    return { ok: false, reason: `maxTimeoutSeconds=${reqs.maxTimeoutSeconds} out of bounds [1, ${MAX_VALIDITY_SECONDS}]` };
  }

  // 6. EIP-712 domain integrity
  if (reqs.extra?.name !== USDC_DOMAIN_NAME) return { ok: false, reason: `extra.name=${reqs.extra?.name} (expected ${USDC_DOMAIN_NAME})` };
  if (reqs.extra?.version !== USDC_DOMAIN_VERSION) return { ok: false, reason: `extra.version=${reqs.extra?.version} (expected ${USDC_DOMAIN_VERSION})` };

  return { ok: true };
}
```

Add to `constants.ts`:
```ts
export const MAX_VALIDITY_SECONDS = 600; // 10-min cap; PaladinFi sends 300s
```

**4. Paid client (`src/client.ts`) — v3.1 hardened**

```ts
import { x402Client, wrapFetchWithPayment } from "@x402/fetch";
import { registerExactEvmScheme } from "@x402/evm/exact/client";
import type { LocalAccount } from "viem/accounts"; // NOT viem `Account` — that includes JsonRpcAccount which lacks signTypedData
import { validatePaladinContext } from "./x402/validate.js";
import { scrubViemError } from "./errors.js";
import { BASE_NETWORK } from "./x402/constants.js";

export class PaladinTrustClient {
  readonly #config: PaladinTrustConfig;
  readonly #paidFetch: typeof globalThis.fetch | undefined;

  constructor(config: PaladinTrustConfig) {
    this.#config = config;

    if (config.mode === "paid" && config.walletClientAccount) {
      const x402 = new x402Client();
      // Pin to Base ONLY — defense-in-depth so a bypass of the hook can't sign for any other EVM
      registerExactEvmScheme(x402, {
        signer: config.walletClientAccount,
        networks: [BASE_NETWORK],
      });
      // ASYNC hook (TS contract requires Promise<void | { abort, reason }>)
      x402.onBeforePaymentCreation(async (context: any) => {
        const r = validatePaladinContext(context); // validates paymentRequired + selectedRequirements
        if (!r.ok) return { abort: true, reason: `paladin-trust pre-sign rejected: ${r.reason}` };
        return undefined;
      });
      // Note: do NOT register onPaymentCreationFailure — could swallow abort + supply forged payload
      this.#paidFetch = wrapFetchWithPayment(globalThis.fetch, x402);
    }
  }

  async preview(req: TrustCheckRequest): Promise<TrustCheckResponse> { /* unchanged from v0.0.2 */ }

  async paid(req: TrustCheckRequest): Promise<TrustCheckResponse> {
    if (!this.#paidFetch) {
      throw new Error("paladin-trust paid mode not initialized: pass `walletClientAccount` in config");
    }
    const url = `${this.#config.apiBase}/v1/trust-check`;
    let r: Response;
    try {
      r = await this.#paidFetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(req),
      });
    } catch (e) {
      throw new Error(`paladin-trust paid call failed: ${scrubViemError(e)}`);
    }
    if (!r.ok) {
      throw new Error(`paladin-trust paid HTTP ${r.status}`);
    }
    let json: unknown;
    try {
      json = await r.json();
    } catch (e) {
      throw new Error(`paladin-trust paid response parse failed: ${scrubViemError(e)}`);
    }
    // Use safeParse so a malicious server response doesn't leak via ZodError messages
    const parsed = trustCheckResponseSchema.safeParse(json);
    if (!parsed.success) {
      throw new Error("paladin-trust paid response failed schema validation");
    }
    return parsed.data;
  }
}
```

Note: `walletClientAccount: LocalAccount` (e.g., from `privateKeyToAccount(...)`). NOT `Account` (viem's union includes `JsonRpcAccount` which lacks `signTypedData` — would type-check at the boundary but explode at first sign).

**5. Errors (`src/errors.ts`) — v3.1 hardened**

```ts
export function scrubViemError(e: unknown): string {
  if (e instanceof Error) {
    // viem errors include `shortMessage` for human-readable; stringify of full err can leak
    // request init (auth headers, body) via .cause chain or .details field
    const short = (e as any).shortMessage;
    if (short && typeof short === "string") return short.slice(0, 200);
    // Fallback: truncate raw message to bounded length, never propagate cause/details
    return (e.message ?? "").slice(0, 200) || "redacted error";
  }
  return String(e).slice(0, 200);
}
```

**6. Action handler (`src/actions/trust-check.ts`)** — same v2-plan structure for LLM extraction. Plus:
- Calls `client.paid(req)` if `config.mode === "paid"`, else `client.preview(req)`
- Validator wallet-readiness gate: in paid mode, `validate` returns false if no `walletClientAccount` in config

**7. Factory (`src/index.ts`) — v3.1 with TRUE boot-time validation**

```ts
import type { LocalAccount } from "viem/accounts";

export interface CreatePaladinTrustPluginOptions {
  walletClientAccount?: LocalAccount; // for paid mode; NOT Account (which includes JsonRpcAccount)
  apiBase?: string;
  defaultChainId?: number;
  mode?: "preview" | "paid"; // explicit override; otherwise inferred from walletClientAccount presence
}

export function createPaladinTrustPlugin(opts: CreatePaladinTrustPluginOptions = {}): Plugin {
  // BOOT-TIME validation — runs at module load, NOT at first message.
  // Fails fast so misconfiguration surfaces at agent startup.
  const intendedMode = opts.mode ?? (opts.walletClientAccount ? "paid" : "preview");

  if (intendedMode === "paid") {
    if (!opts.walletClientAccount) {
      throw new Error(
        "[paladin-trust] paid mode requires walletClientAccount. " +
        "Construct via `privateKeyToAccount(...)` from viem/accounts.",
      );
    }
    // Verify it's a LocalAccount (has signTypedData)
    if (typeof opts.walletClientAccount.signTypedData !== "function") {
      throw new Error(
        "[paladin-trust] walletClientAccount must be a LocalAccount with signTypedData; " +
        "JsonRpcAccount/SmartAccount not supported in v0.1.0",
      );
    }
  }

  // Closure over opts; all actions/validators read from this scoped config
  // ...
  return { /* Plugin object */ };
}

// Default export: preview-mode-only plugin (no walletClientAccount; matches v0.0.2 use)
export const paladinTrustPlugin: Plugin = createPaladinTrustPlugin();
```

**Note on validation layers (defense in depth):**
- **Boot-time** (this factory) — fails at module load if paid mode misconfigured
- **Per-message** (`resolveConfig`) — defense-in-depth for runtime config drift
- **Pre-sign** (`onBeforePaymentCreation` hook) — final gate against tampered/malicious server

### Pre-flight cite verification (all VERIFIED)

| Cited surface | Status |
|---|---|
| `@x402/fetch@2.11.0` `wrapFetchWithPayment(fetch, x402Client)` | VERIFIED via spike + TS types |
| `@x402/core` `x402Client.onBeforePaymentCreation((ctx) => ...)` | VERIFIED via spike + TS types |
| `@x402/evm/exact/client` `registerExactEvmScheme(client, { signer })` | VERIFIED via spike |
| Live `/v1/trust-check` 402 challenge shape | VERIFIED via spike |
| `composePromptFromState`, `parseKeyValueXml`, `ModelType.TEXT_SMALL` from `@elizaos/core@2.0.0-alpha.77` | VERIFIED earlier (retrospective reviewer) |
| `IAgentRuntime.composeState(message, includeList, onlyInclude, skipCache)` — third arg is `onlyInclude` | VERIFIED |

### Sequencing (revised: 6-9 hours)

1. **Add deps + scaffold** (~15 min) — install pinned `@x402/fetch@2.11.0`, `@x402/evm`, `@x402/core`, `vitest@^2`. Pin `@elizaos/core` exact `2.0.0-alpha.77`. Bump version `0.0.2` → `0.1.0`.

2. **Prompt template + LLM extraction** (~1 hr) — write `templates/trust-check.ts`, modify `actions/trust-check.ts` `buildTrustCheckArgs` (LLM with options.address bypass).

3. **x402 constants + validation** (~30 min) — write `x402/constants.ts`, `x402/validate.ts`.

4. **Errors helper** (~10 min) — `errors.ts` `scrubViemError`.

5. **Paid client** (~1 hr) — modify `client.ts` `paid()` to use `@x402/fetch` + hook. Add `walletClientAccount?: Account` to `PaladinTrustConfig`.

6. **Factory pattern** (~30 min) — `createPaladinTrustPlugin({...})` factory in `index.ts`. Default export remains `paladinTrustPlugin` (preview-only).

7. **Boot-time validation** (~15 min) — in `resolveConfig`, throw synchronously when paid mode + missing `walletClientAccount` or wrong chain.

8. **Validator wallet-readiness gate** (~15 min) — `hasWalletReady(config)` check in `validate`.

9. **Tests** (~45 min) — `tests/x402-validate.test.ts` (6+ assertions) + `tests/boot-validation.test.ts` (paid-mode constructor throws).

10. **Documentation** (~45 min) — README expanded into 4 named subsections (full content per "README structure" section below).

11a. **Provision permanent test wallet — DONE 2026-05-04.** MetaMask Account 4 / `0x18779E54787320aE9Ab997F2ba3fC6E31D2A0aC1` repurposed from decommissioned UniswapX filler ladder rung 1 (per `feedback_test_wallet_permanent.md`). Encrypted key at EC2 `.wallet_keys/metamask_eth_4.enc` (perms 600); plaintext copy in plugin repo `.env.local` (gitignored) as `PALADIN_TRUST_KEY`. Address verified by viem. Funding pending: top up to $0.05 USDC + $0.50 ETH on Base from EC2 trading wallet `0xF6c99CEc...` (Account 1) — NOT from Coinbase (blocked per `coinbase_account_hold_2026-04-28.md`).

11b. **Build + smoke + manual test** (~45-90 min, AFTER all code complete) — typecheck, build, vitest, smoke-test extension, manual paid test with the wallet provisioned in 11a (settled tx visible on Basescan).

12. **3-adversary review on IMPLEMENTATION** (~60-90 min) — Engineering + Security + Maintainer reviewers on the actual code, not just the plan. Apply fixes.

13. **Publish + release** (~30 min) — npm publish, GitHub release tagged, Eliza Discussion #7242 follow-up comment, Tweet 6, close tracking issue #1.

**Realistic total: 6-9 hours**, comfortably inside 13 days slack to 2026-05-16.

### README structure (v0.1.0)

The README must contain these 4 named subsections in this order. Copy-pasteable code blocks; no name-drops of competitors.

#### `### Why this vs. other agent-trust plugins?`

One paragraph (~5-7 lines):

> Most agent-trust plugins focus on *agent identity* — proving that the entity you're talking to is who they claim. `@paladinfi/eliza-plugin-trust` is different: it grades the **token contract risk** of an asset before your agent transacts it. Given an EVM token address, it returns a recommendation (`allow` / `caution` / `block`) plus structured factors covering honeypot signals, ownership concentration, mint/blacklist powers, and liquidity profile. Use this plugin alongside agent-identity tooling, not instead of it. Preview mode is free and unauthenticated; paid mode settles $0.001 USDC per check via x402 to enable higher rate limits and signed responses.

(Frame: token-contract-risk vs agent-identity. No mention of Vaultfire or other plugins by name — buyer reviewer flagged that name-drops invite comparison drift and date the README.)

#### `### Quick start (preview mode)`

```bash
npm install @paladinfi/eliza-plugin-trust
```

```ts
// character.json or programmatic agent setup
import { paladinTrustPlugin } from "@paladinfi/eliza-plugin-trust";

export const character = {
  name: "MyAgent",
  plugins: [paladinTrustPlugin], // preview-mode by default; no wallet required
  // ...
};
```

Then in chat: *"check 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913 on Base"* — the agent extracts address + chainId via LLM and returns the trust verdict.

#### `### Paid mode wiring`

Paid mode settles $0.001 USDC per call on Base via x402 for higher rate limits + signed responses. Requires a viem `LocalAccount` with a USDC + ETH balance on Base.

```ts
import { privateKeyToAccount } from "viem/accounts";
import { createPaladinTrustPlugin } from "@paladinfi/eliza-plugin-trust";

// Use a DEDICATED plugin wallet — never your main treasury key.
// Fund with ~$0.10 USDC + dust ETH on Base.
const account = privateKeyToAccount(process.env.PALADIN_TRUST_KEY as `0x${string}`);

export const character = {
  name: "MyAgent",
  plugins: [
    createPaladinTrustPlugin({
      walletClientAccount: account, // LocalAccount; enables paid mode
      // mode: "paid" is inferred when walletClientAccount is present
    }),
  ],
};
```

Pre-sign safety: every paid call validates the server's 402 challenge against hard-coded constants (Base USDC contract, PaladinFi treasury address, $0.01 max amount, EIP-3009 only — no Permit2). The signing call is aborted client-side before viem signs anything if any field deviates.

**Do not stringify the plugin or its config** — the `walletClientAccount` is held in a closure to avoid accidental serialization, but defensive logging in your own code should still skip the plugins array.

#### `### Migration from v0.0.x`

- **Default export still works** — `import { paladinTrustPlugin }` continues to give you preview mode with no config changes.
- **Paid mode now requires explicit wallet injection.** v0.0.x had a placeholder paid path; v0.1.0 makes it real and requires `createPaladinTrustPlugin({ walletClientAccount })`. The plugin does **not** auto-resolve `EVM_PRIVATE_KEY` from `runtime.getSetting()` — that's deferred to v0.2.0 to avoid surprising key reuse with `@elizaos/plugin-evm`. If you've been setting `PALADIN_TRUST_MODE=paid` expecting it to work without a wallet, it now throws at agent boot — switch to the factory above.
- **Action name unchanged** — `paladin_trust_check` continues to register; existing character configs that reference it by name still work.
- **`@elizaos/core` is now a peerDep, pinned exact to `2.0.0-alpha.77`.** Match this in your project's deps.

### Risks (revised post-spike)

- **R1 [LOW] `@x402/fetch@2.11.0` library trust.** Coinbase, Apache-2.0, unaudited security-critical signing code. Mitigation: pin exact + `npm audit signatures` in CI + treat library compromise as residual risk.
- **R2 [LOW] LLM extraction reliability.** Same as v2 plan. Mitigation: explicit error messages, options.address bypass for programmatic.
- **R3 [LOW] Manual paid test cost.** ~$0.05 USDC for ~50 calls. Acceptable.
- **R4 [MED] Eliza alpha API drift between `@elizaos/core@2.0.0-alpha.77` and current alpha.** v2-alpha is unstable; symbols like `composePromptFromState`, `parseKeyValueXml`, `ModelType.TEXT_SMALL`, `composeState` third-arg semantics, and `Plugin` shape can shift between alphas without major-version bumps. Mitigation: pin `@elizaos/core` exact `2.0.0-alpha.77` (peerDep + devDep); CI runs `npm install` against the pin; document in README "Tested against alpha.77; newer alphas may require plugin update". Add a 2026-05-16 reminder to re-test against latest alpha and tag a v0.1.x update if drift detected.

### Definition of done

- [ ] `npm run typecheck` clean
- [ ] `npm run build` clean
- [ ] `npm run test` (vitest) — `tests/x402-validate.test.ts` (≥6 assertions) + `tests/boot-validation.test.ts` (≥3 assertions) pass
- [ ] `node smoke-test.mjs` extended to test challenge-validation logic; passes
- [x] **Permanent test wallet provisioned** — Account 4 / `0x18779E54787320aE9Ab997F2ba3fC6E31D2A0aC1`, key in `.env.local`, viem-verified 2026-05-04. Funding: pending top-up from Account 1.
- [x] **Manual paid test from permanent test wallet** Account 4 (`0x18779E5478...0aC1`, NOT EC2 trading wallet) against live `/v1/trust-check` succeeded 2026-05-04. Hook fired once, all 6 validation checks passed, EIP-3009 signed via viem, $0.001 USDC settled to treasury. Tx: [`0x6c083d0b...82b3`](https://basescan.org/tx/0x6c083d0b35e67a9884d4defec92322913276062940bb2559bf57e9193584fc45). Schema bugs (request_id/real fields) caught + fixed during smoke.
- [x] **3-adversary review on IMPLEMENTATION done 2026-05-04**. All three reviewers returned APPROVE-WITH-MINOR-FIXES; no HIGH/CRITICAL/REJECT. All MED-sev fixes applied: architectural refactor (closure-bound action factory replacing symbol-slot decoration to fix load-order race), client.ts HTTPS gate, BASE_NETWORK filter policy, hook-abort grep prefix, parseKeyValueXml zod validation, taker fail-loud, isAddress strict:false, WeakSet warn tracking, preview safeParse, action returns {success:false} on error. Review reports captured in CHANGELOG. Smoke re-run post-fix; settled tx `0xe08f3636d2cbbac2eab95cb1685c670369311e4a4e560a743f40719ddd9db1a1`.
- [ ] CHANGELOG v0.1.0 promoted from Unreleased
- [ ] README updated: natural-language example, paid-mode wiring (factory + walletClientAccount), Migration from v0.0.x section explicit on `EVM_PRIVATE_KEY` not auto-resolved
- [ ] `package.json` version `0.0.2` → `0.1.0`; `@elizaos/core` pinned exact; `@x402/fetch` + `@x402/evm` + `@x402/core` pinned exact; vitest devDep + test script
- [ ] `agentConfig.pluginParameters.PALADIN_TRUST_MODE.default` confirmed `"preview"` (NOT flipped per security review)
- [ ] Published to npm at `v/0.1.0`
- [ ] GitHub release `v0.1.0` tagged
- [ ] Eliza Discussion #7242 follow-up comment posted
- [ ] Tracking issue #1 closed with shipped comment
- [ ] Tweet 6 posted to `@paladin_fi`

---

## Adversarial review gate

**v3 plan review (2026-05-03): COMPLETE.** All three reviewers (Engineering + Security + Maintainer) returned APPROVE-WITH-MINOR-FIXES, no REJECT verdicts. Convergent fixes incorporated into this v3.1:

- **Engineering polish:** `validatePaladinContext` now validates `paymentRequired` + `selectedRequirements` (not just selectedRequirements); added `assetTransferMethod`, `x402Version`, and `maxTimeoutSeconds` checks; `LocalAccount` (not `Account`) typing pinned; `safeParse` instead of `parse`; bounded `scrubViemError` truncation; `networks: [BASE_NETWORK]` pinned in scheme registration; async hook signature.
- **Security polish:** Permit2/v1-downgrade and long-lived-signature vectors closed in `validate.ts`; `MAX_VALIDITY_SECONDS = 600` cap added; HTTPS-only-in-paid kept; treasury address triple-validated (boot-time + per-message + pre-sign).
- **Maintainer polish:** README expanded to 4 named subsections (Why-this / Quick-start-preview / Paid-mode-wiring / Migration); R4 added for Eliza alpha API drift; sequencing 11 split into 11a (provision wallet first) + 11b (manual test after code complete); DoD adds "test wallet funded from known-funded source" + "settled tx hash documented"; effort 6-9 hours.

**Implementation gate:** v3.1 may proceed to implementation. After implementation, run a SECOND 3-adversary review on the actual code BEFORE `npm publish`. That second review is non-negotiable per `feedback_no_deploy_without_adversarial_review.md`.
