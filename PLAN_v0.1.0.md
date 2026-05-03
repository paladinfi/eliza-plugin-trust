# `@paladinfi/eliza-plugin-trust` v0.1.0 Implementation Plan — v2

**Status:** AWAITING 3-ADVERSARY REVIEW (v2 incorporates all v1-review findings)
**Public deadline:** ≤ 2026-05-16 (per Eliza Discussion #7242 follow-up comment)
**Drafted:** 2026-05-03 early (v2; v1 paused at REQUIRES-MAJOR-REWRITE from Engineering + Security)
**Tracking issue:** [#1](https://github.com/paladinfi/eliza-plugin-trust/issues/1)
**Reference plugin:** [`elizaos-plugins/plugin-evm`](https://github.com/elizaos-plugins/plugin-evm) (v2-alpha, branch `alpha`, `transfer.ts` is the canonical)
**Baseline:** v0.0.2 already shipped (peerDep fix, HTTPS enforcement, Zod enum, paid-mode graceful degrade)

---

## What changed from v1 plan to v2

11 convergent findings from v1 review applied:

1. **Drop hand-rolled x402 settlement → depend on `x402-fetch`** (Coinbase, Apache-2.0). Same library AgentKit's `x402ActionProvider` uses internally. Drops EIP-3009 implementation surface (security-critical) entirely. Effort cut from 3-5hr → ~30 min for the settlement layer.

2. **Client-side validation of signed authorization** — hard-code `TREASURY` / `ASSET` / `NETWORK` / `MAX_AMOUNT` constants and assert equality before signing. Closes the wallet-drain footgun where a compromised server could request signing to an attacker address. Even with `x402-fetch` doing the heavy lifting, we wrap it with our own pre-sign assertions because library trust is one defense layer; client-side equality on the values is another.

3. **Keep default mode as `preview` in v0.1.0** (NOT flip to `paid`). Security review flagged that flipping default to `paid` means `npm update` silently activates wallet signing. v0.0.2 already keeps preview default with graceful-degrade; v0.1.0 keeps that, and `paid` requires explicit opt-in.

4. **HTTPS-only `apiBase`** with `PALADIN_TRUST_ALLOW_INSECURE=1` escape hatch — already shipped in v0.0.2, no work needed.

5. **Boot-time constructor validation** — if `mode === "paid"`, fail at `PaladinTrustClient` constructor (or factory) when `walletClient` is missing/lacks an account/wrong chain. Surface misconfiguration immediately at boot, not at first call.

6. **Validator wallet-readiness gate** — mirror `plugin-evm`'s `hasEvmPrivateKey` check in `createEvmActionValidator`. In paid mode, validator returns `false` if neither `walletClient` is in config nor `EVM_PRIVATE_KEY` is in runtime settings. The action doesn't surface in chat where it can't actually fire.

7. **Pin `@elizaos/core` to exact `2.0.0-alpha.77`** — caret pre-release rules float the version unexpectedly. v0.0.2 already moved to peerDep; v0.1.0 tightens the version pin.

8. **Strict response schema** — already shipped in v0.0.2 (`z.enum(TRUST_RECOMMENDATIONS)`).

9. **Fix retry header reference** — moot since we're using `x402-fetch` which handles correctly (`PAYMENT-SIGNATURE` for v2).

10. **Fix AgentKit `utils.ts` reference in plan** — `utils.ts` has discovery helpers, NOT signing code. The signing path is `@x402/fetch`'s `wrapFetchWithPayment`. Plan now correctly references this.

11. **Add 1 vitest test** for `signX402Authorization` typed-data shape — defensive depth even though `x402-fetch` does the signing. Verifies our preconditions (constants, validation) are correct.

---

## Goals (must-have for v0.1.0)

1. **LLM prompt-template extraction.** `paladin_trust_check` extracts `address` / `chainId` / `taker` from natural-language messages via `composePromptFromState` + `runtime.useModel(ModelType.TEXT_SMALL)` + `parseKeyValueXml`.

2. **Paid x402 settlement** in `PaladinTrustClient.paid()`. Wraps `x402-fetch`'s `wrapFetchWithPayment` with our own client-side validation (TREASURY / ASSET / NETWORK / MAX_AMOUNT assertions on the 402 challenge). Removes the v0.0.2 graceful-degrade for paid mode (paid mode now actually works).

3. **Wallet client integration**. Accept `walletClient: WalletClient` (account-bound, viem) in `PaladinTrustConfig`. Boot-time validation: paid mode requires non-undefined `walletClient.account` and `walletClient.chain?.id === 8453`.

4. **Validator wallet-readiness gate** in paid mode (mirror plugin-evm pattern).

5. **Bumped version** `0.0.2` → `0.1.0`, published to npm, GitHub release tagged.

## Out of scope (defer to v0.2.0+)

- Multi-chain support — Base only at v0.1.0 (the underlying service is Base-only).
- Full validator factory pattern (`createTrustCheckActionValidator`) — keep the v0.0.2 keyword-regex validator + the new wallet-readiness gate.
- Confirmation flow (`confirmationRequired` / `isConfirmed`) — $0.001 micropayment doesn't warrant pre-confirm friction.
- Vitest unit + integration test SUITE — ship 1 targeted test (typed-data shape); broader suite in v0.2.0.
- TOON-format compatibility / build:prompts script.

## Pre-flight cite verification (per `feedback_self_audit_before_review_2026-04-30.md`)

| Cited surface | Status |
|---|---|
| `elizaos-plugins/plugin-evm/typescript/actions/transfer.ts` | LIVE (verified earlier) |
| `elizaos-plugins/plugin-evm/prompts/transfer.txt` | LIVE (TOON format, verified) |
| `composePromptFromState` from `@elizaos/core@2.0.0-alpha.77` | EXPORTED (verified by retrospective reviewer reading tarball `dist/utils.d.ts`) |
| `parseKeyValueXml` from `@elizaos/core@2.0.0-alpha.77` | EXPORTED (verified, same path) |
| `ModelType.TEXT_SMALL` | EXPORTED (`dist/types/model.d.ts`) |
| `x402-fetch` npm package (Coinbase) | LIVE — `npm view x402-fetch` returns published package, Apache-2.0 |
| `@x402/fetch` npm package (Coinbase scoped) | LIVE — also published; check which is preferred — likely `x402-fetch` for v1, `@x402/fetch` for v2 |
| `viem` `signTypedData` | STANDARD viem usage |
| Base USDC EIP-3009 contract `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` | VERIFIED earlier via swap.paladinfi.com/health |
| **PaladinFi `/v1/trust-check` returns x402 v2 challenge** | VERIFIED 2026-05-03 by retrospective reviewer — `accepts[0]: { scheme: "exact", network: "eip155:8453", asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", amount: "1000", payTo: "0xeA8C33d018760D034384e92D1B2a7cf0338834b4", maxTimeoutSeconds: 300, extra: { name: "USD Coin", version: "2" } }` |

All cites resolve live. No "NOT YET VERIFIED" rows.

---

## Architecture

### File structure changes

```
src/
├── actions/
│   └── trust-check.ts        [MODIFIED — wire LLM extraction; remove paid-mode degrade (config still degrades, but handler now also handles paid mode)]
├── templates/                [NEW — directory]
│   └── trust-check.ts        [NEW — prompt template string constant]
├── client.ts                 [MODIFIED — implement paid() via x402-fetch wrapper + client-side validation]
├── config.ts                 [MODIFIED — add walletClient to config; add paid-mode boot-time validation]
├── x402/                     [NEW — directory]
│   ├── constants.ts          [NEW — hard-coded TREASURY, ASSET, NETWORK, MAX_AMOUNT]
│   └── validate.ts           [NEW — pre-sign 402-challenge assertion helper]
├── types.ts                  [MODIFIED — add walletClient to PaladinTrustConfig type]
├── index.ts                  [MODIFIED — export new symbols]
└── __tests__/                [NEW — directory]
    └── x402-validate.test.ts [NEW — vitest test for client-side challenge validation]

CHANGELOG.md                  [MODIFIED — promote v0.1.0 from Unreleased]
README.md                     [MODIFIED — natural-language usage example, paid-mode wiring docs, v0.0.x→v0.1.0 migration section]
package.json                  [MODIFIED — version bump, exact @elizaos/core pin, add x402-fetch, add vitest devDep, add test script]
```

### Component design

**1. Prompt template (`src/templates/trust-check.ts`)**

```ts
export const trustCheckTemplate = `Given the recent messages below:

{{recentMessages}}

The user wants to verify a token contract before swapping into it. Extract:
- Buy-token contract address (EIP-55 hex address)
- Chain ID (default 8453 / Base if not mentioned)
- Optional: agent wallet address (taker)

Respond using TOON format like this:
address: 0x... (EIP-55 hex address of the token to verify, or empty if not provided)
chainId: number (e.g. 8453)
taker: 0x... or empty

IMPORTANT: Your response must ONLY contain the TOON document above. No preamble or explanation.`;
```

**2. x402 constants (`src/x402/constants.ts`)**

Hard-coded values verified live; **the package signs only authorizations matching ALL of these:**

```ts
export const PALADIN_TREASURY = "0xeA8C33d018760D034384e92D1B2a7cf0338834b4" as const;
export const BASE_USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" as const;
export const BASE_NETWORK = "eip155:8453" as const;
export const MAX_TRUST_CHECK_AMOUNT = 10_000n; // $0.01 cap = 10× expected $0.001 (in USDC's 6 decimals)
export const X402_VERSION = 2 as const;
```

**3. x402 client-side validation (`src/x402/validate.ts`)**

Validator runs against the decoded `payment-required` challenge BEFORE `x402-fetch` signs anything. If `x402-fetch` doesn't expose a pre-sign hook, we wrap our own `paid()` to fetch the 402 first, validate, then call `x402-fetch` to settle:

```ts
import {
  PALADIN_TREASURY, BASE_USDC, BASE_NETWORK, MAX_TRUST_CHECK_AMOUNT, X402_VERSION,
} from "./constants.js";

export interface X402AcceptV2 {
  scheme: string;
  network: string;
  asset: string;
  amount: string;
  payTo: string;
  maxTimeoutSeconds?: number;
  extra?: { name?: string; version?: string };
}

export interface X402ChallengeV2 {
  x402Version: number;
  accepts: X402AcceptV2[];
}

export function validatePaladinChallenge(challenge: X402ChallengeV2): X402AcceptV2 {
  if (challenge.x402Version !== X402_VERSION) {
    throw new Error(`x402 version ${challenge.x402Version} not supported (expected ${X402_VERSION})`);
  }
  const accept = challenge.accepts?.[0];
  if (!accept) throw new Error("x402 challenge has no accepts[0]");

  if (accept.scheme !== "exact") {
    throw new Error(`x402 scheme "${accept.scheme}" not supported (expected "exact")`);
  }
  if (accept.network !== BASE_NETWORK) {
    throw new Error(`x402 network "${accept.network}" rejected (expected "${BASE_NETWORK}")`);
  }
  if (accept.asset.toLowerCase() !== BASE_USDC.toLowerCase()) {
    throw new Error(`x402 asset "${accept.asset}" rejected (expected USDC ${BASE_USDC})`);
  }
  if (accept.payTo.toLowerCase() !== PALADIN_TREASURY.toLowerCase()) {
    throw new Error(`x402 payTo "${accept.payTo}" rejected (expected PaladinFi treasury ${PALADIN_TREASURY})`);
  }
  const amount = BigInt(accept.amount);
  if (amount > MAX_TRUST_CHECK_AMOUNT) {
    throw new Error(`x402 amount ${accept.amount} exceeds cap ${MAX_TRUST_CHECK_AMOUNT}`);
  }
  return accept;
}
```

**4. Paid client (`src/client.ts`)**

```ts
import { wrapFetchWithPayment } from "x402-fetch";
import { validatePaladinChallenge, type X402ChallengeV2 } from "./x402/validate.js";
// ...

async paid(req: TrustCheckRequest): Promise<TrustCheckResponse> {
  if (!this.config.walletClient) {
    throw new Error("paid mode requires walletClient (viem account-bound WalletClient on Base)");
  }

  const url = `${this.config.apiBase}/v1/trust-check`;

  // Step 1: trigger 402 challenge ourselves so we can validate before signing
  const probe = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(req),
  });

  if (probe.status === 200) {
    // Server returned 200 without payment — verify trust block, return as-is
    return trustCheckResponseSchema.parse(await probe.json());
  }
  if (probe.status !== 402) {
    const body = await probe.text().catch(() => "<unreadable>");
    throw new Error(`paid expected 402 challenge, got ${probe.status}: ${body.slice(0, 200)}`);
  }

  const challengeHeader = probe.headers.get("payment-required");
  if (!challengeHeader) {
    throw new Error("paid: 402 response missing payment-required header");
  }
  const decoded = JSON.parse(Buffer.from(challengeHeader, "base64").toString("utf8")) as X402ChallengeV2;

  // CRITICAL: client-side validation BEFORE we let x402-fetch sign anything
  validatePaladinChallenge(decoded);

  // Step 2: now retry with x402-fetch handling the signing + retry
  const paidFetch = wrapFetchWithPayment(globalThis.fetch, this.config.walletClient);
  const settled = await paidFetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(req),
  });

  if (!settled.ok) {
    throw new Error(`paid (after settlement) HTTP ${settled.status}`);
  }
  return trustCheckResponseSchema.parse(await settled.json());
}
```

Note: this approach validates the challenge before letting `x402-fetch` sign. If `x402-fetch` exposes a pre-sign callback in a future version, we can simplify; for now, we make the 402 probe ourselves, validate, then hand off to `x402-fetch` for the second request.

**5. Action handler (`src/actions/trust-check.ts`)**

```ts
async function buildTrustCheckArgs(
  state: State,
  message: Memory,
  runtime: IAgentRuntime,
  config: PaladinTrustConfig,
  options?: TrustCheckOptions,
): Promise<TrustCheckRequest> {
  // v0.1.0 backward-compat: explicit options.address bypasses LLM extraction
  if (options?.address && isAddress(options.address as Address)) {
    return trustCheckRequestSchema.parse({
      address: options.address,
      chainId: typeof options.chainId === "number" ? options.chainId : config.defaultChainId,
      taker: typeof options.taker === "string" && isAddress(options.taker as Address) ? options.taker : undefined,
    });
  }

  // Otherwise extract from natural-language message
  state = await runtime.composeState(message, ["RECENT_MESSAGES"], true);
  const context = composePromptFromState({ state, template: trustCheckTemplate });
  const llmResponse = await runtime.useModel(ModelType.TEXT_SMALL, { prompt: context });
  const parsed = parseKeyValueXml(llmResponse);
  if (!parsed) {
    throw new Error("paladin_trust_check: LLM response could not be parsed");
  }

  const address = String(parsed.address ?? "").trim();
  if (!address || !isAddress(address as Address)) {
    throw new Error(`paladin_trust_check: extracted address invalid: "${address}"`);
  }

  const chainIdRaw = String(parsed.chainId ?? config.defaultChainId);
  const chainId = Number.parseInt(chainIdRaw, 10) || config.defaultChainId;

  const takerRaw = String(parsed.taker ?? "").trim();
  const taker = takerRaw && isAddress(takerRaw as Address) ? takerRaw : undefined;

  return trustCheckRequestSchema.parse({ address, chainId, taker });
}
```

**6. Validator wallet-readiness gate (`src/actions/trust-check.ts`)**

```ts
function hasWalletReady(runtime: IAgentRuntime, config: PaladinTrustConfig): boolean {
  if (config.mode !== "paid") return true; // preview mode doesn't need wallet
  if (config.walletClient?.account && config.walletClient?.chain?.id === 8453) return true;
  // Fall back to runtime setting check (future v0.2.0 will resolve key from settings)
  return false;
}

validate: async (runtime, message, _state) => {
  const text = (message?.content?.text ?? "").toString().toLowerCase();
  if (!text) return false;
  if (!/\b(trust[- ]?check|risk[- ]?gate|honeypot|ofac|sanctioned|verify[- ]?token|pre[- ]?trade)\b/.test(text)) {
    return false;
  }
  // In paid mode, gate on wallet readiness so the action doesn't surface where it can't fire
  const config = resolveConfig(runtime);
  return hasWalletReady(runtime, config);
}
```

### Testing strategy

- **Smoke-test extension**: `smoke-test.mjs` extends to test challenge validation logic with mock challenges (good + bad). No real wallet needed.
- **One vitest test** (`__tests__/x402-validate.test.ts`):
  - Valid challenge passes
  - Wrong network rejects
  - Wrong asset rejects
  - Wrong payTo rejects
  - Amount over cap rejects
  - Wrong x402Version rejects
- **Manual integration**: real Base wallet (MetaMask `0xF6c99CEc5bd639316a19d2F56AfC14bd046d3a90`, ~$0.05 USDC pre-funded) against live `/v1/trust-check`. Verify settled tx on Basescan.

### Sequencing (estimated 3-5 hours)

1. **Add deps + scaffold** (~15 min)
   - `npm install x402-fetch vitest --save-dev` (verify which package exact name; may be `@x402/fetch` for v2)
   - Bump `package.json` version 0.0.2 → 0.1.0
   - Pin `@elizaos/core` to exact `2.0.0-alpha.77`
   - Update tsconfig if needed for vitest

2. **Prompt template + LLM extraction** (~1 hr)
   - Write `src/templates/trust-check.ts`
   - Modify `src/actions/trust-check.ts` `buildTrustCheckArgs` (LLM extraction with options.address bypass)
   - Smoke-test with stubbed `runtime.useModel`

3. **x402 constants + validation** (~30 min)
   - Write `src/x402/constants.ts`
   - Write `src/x402/validate.ts`
   - Vitest test (`__tests__/x402-validate.test.ts`)

4. **Paid client implementation** (~1 hr)
   - Modify `src/client.ts` `paid()` to: probe 402 → decode → validate → handoff to `x402-fetch`
   - Add `walletClient?: WalletClient` to `PaladinTrustConfig`
   - Boot-time validation in `resolveConfig` or constructor

5. **Validator wallet-readiness gate** (~15 min)
   - Add `hasWalletReady` check to `validate`

6. **Documentation + release prep** (~45 min)
   - README natural-language example
   - README "Migration from v0.0.x" section
   - CHANGELOG: promote v0.1.0 from Unreleased
   - Update `agentConfig.pluginParameters` description for `PALADIN_TRUST_MODE` (paid mode now works)

7. **Build + smoke-test + manual paid test + publish** (~30-45 min)
   - `npm run typecheck` clean
   - `npm run build` clean
   - `npm run test` (vitest) clean
   - `node smoke-test.mjs` clean
   - Manual paid test from MetaMask wallet on Base — observe USDC settled tx
   - Re-run 3-adversary review on the IMPLEMENTATION (not just the plan)
   - Apply minor fixes
   - `npm publish --access public`
   - GitHub release tagged `v0.1.0`
   - Eliza Discussion #7242 follow-up comment announcing v0.1.0
   - Tweet 6 (Draft B in TWITTER_QUEUE)
   - Close tracking issue #1 with "shipped" comment + link to release

### Risks

- **R1 [HIGH]: `x402-fetch` library API may not match what we need.** Library is young (Coinbase, Apache-2.0). Mitigation: read its README + source before depending on it. If it doesn't expose a pre-sign validation hook, our probe-then-handoff approach works around that. Verify `wrapFetchWithPayment` actually settles correctly on Base USDC.

- **R2 [MED]: LLM extraction reliability.** If model fails to produce valid TOON or omits fields, user gets confusing error. Mitigation: explicit error messages, options.address bypass for programmatic callers, log raw LLM response on parse failure.

- **R3 [MED]: Wallet provider abstraction limited.** v0.1.0 requires user to construct viem `WalletClient` and pass it into config. Plugin-evm's `EVM_PRIVATE_KEY` runtime resolution is more user-friendly but more work; defer to v0.2.0.

- **R4 [LOW]: Manual paid test cost.** ~$0.05 USDC for ~50 calls during development. Acceptable.

### Definition of done

- [ ] `npm run typecheck` clean
- [ ] `npm run build` produces clean dist
- [ ] `npm run test` (vitest x402-validate suite) — all 6+ assertions pass
- [ ] `npm pack --dry-run` clean (size ≤ 30 kB; allowing for new x402/ dir + tests)
- [ ] `node smoke-test.mjs` all checks pass (preview + challenge-validation stubs)
- [ ] Manual paid-mode test from MetaMask wallet `0xF6c99CEc...` against live `/v1/trust-check` succeeds, settles USDC visible on Basescan
- [ ] **3-adversary review on IMPLEMENTATION** (not just plan) before publish — Engineering + Security + Maintainer
- [ ] All review HIGH/MED-sev fixes applied
- [ ] CHANGELOG.md v0.1.0 entry promoted from Unreleased
- [ ] README updated: natural-language example, paid-mode wiring, v0.0.x→v0.1.0 migration section
- [ ] `package.json` version `0.0.2` → `0.1.0`, `@elizaos/core` pinned to exact `2.0.0-alpha.77`, `agentConfig.pluginParameters.PALADIN_TRUST_MODE.default` confirmed `"preview"` (not flipped per security review)
- [ ] Published to npm at `v/0.1.0`
- [ ] GitHub release `v0.1.0` tagged with notes + linking to npm
- [ ] Eliza Discussion #7242 follow-up comment posted (uses Draft B from TWITTER_QUEUE.md)
- [ ] Tracking issue #1 closed with "shipped" comment + release link
- [ ] Tweet 6 posted to `@paladin_fi`

---

## Adversarial review gate

Per `feedback_no_deploy_without_adversarial_review.md` mandatory rule, this plan must pass 3-adversary review BEFORE implementation begins:

1. **Engineering reviewer** — verify x402-fetch integration is sound, LLM extraction matches plugin-evm canonical, validation flow correctness.
2. **Security reviewer** — verify TREASURY/ASSET/NETWORK/MAX_AMOUNT constants are correct, validation runs before signing, no leak vectors in error paths. **Reviewer prompt MUST include "treat as audit not code review; if anything could result in funds loss name it explicitly."**
3. **Maintainer / community reviewer** — verify scope cuts are appropriate, deadline is realistic, public commitment in Eliza Discussion #7242 is met by v0.1.0 deliverables.

If 2+ reviewers verdict APPROVE-AS-IS or APPROVE-WITH-MINOR-FIXES, apply minor fixes and proceed to implementation. If any reviewer verdicts REQUIRES-MAJOR-REWRITE, pause and revise to v3.

After implementation, run a SECOND 3-adversary review on the actual code (not just the plan) before npm publish.
