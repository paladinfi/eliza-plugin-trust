# `@paladinfi/eliza-plugin-trust` v0.1.0 Implementation Plan

**Status:** AWAITING 3-ADVERSARY REVIEW
**Public deadline:** ≤ 2026-05-16 (per Eliza Discussion #7242 follow-up comment)
**Drafted:** 2026-05-02 night
**Tracking issue:** [#1](https://github.com/paladinfi/eliza-plugin-trust/issues/1)
**Reference plugin:** [`elizaos-plugins/plugin-evm`](https://github.com/elizaos-plugins/plugin-evm) (v2-alpha pattern, branch `alpha`, `transfer.ts` is the canonical)

---

## Goals (must-have for v0.1.0)

1. **LLM prompt-template extraction.** `paladin_trust_check` extracts `address` / `chainId` / `taker` from natural-language user messages via the v2-alpha pattern: `composePromptFromState` → `runtime.useModel(ModelType.TEXT_SMALL)` → `parseKeyValueXml`.
2. **Paid x402 settlement** in `PaladinTrustClient.paid()`. Resolves the 402 challenge from `/v1/trust-check` via EIP-3009 USDC signing on Base (chainId 8453) at $0.001/call. Currently throws.
3. **Mode default flips to `paid`.** Preview remains override-able via `PALADIN_TRUST_MODE=preview`.
4. **CHANGELOG entry for v0.1.0** (already drafted in Unreleased section).
5. **Bumped version**, published to npm, GitHub release tagged.

## Out of scope (defer to v0.2.0+)

- **Validator factory pattern** matching `createEvmActionValidator` — keep the v0.0.1 keyword-regex validator. Reason: it works for v0.1.0; refactor if a real bug surfaces.
- **Confirmation flow** (`confirmationRequired` / `isConfirmed`) — trust-check is read-only ($0.001 micropayment is small enough that pre-confirm friction is wrong UX).
- **Vitest unit + integration test suite** matching plugin-evm scope — skeleton smoke test exists; expand in v0.2.0.
- **Multi-chain support** — Base only at v0.1.0 (the underlying service is Base-only).
- **TOON-format compatibility / build:prompts script** — hand-write the template as a TS string constant; skip plugin-evm's Bun build infra.

## Architecture

### File structure changes

```
src/
├── actions/
│   └── trust-check.ts        [MODIFIED — wire LLM extraction]
├── templates/                [NEW — directory]
│   └── trust-check.ts        [NEW — prompt template + parsed-args type]
├── client.ts                 [MODIFIED — implement paid() with x402 + EIP-3009]
├── config.ts                 [MODIFIED — flip default mode to "paid"]
├── x402/                     [NEW — directory]
│   ├── settle.ts             [NEW — EIP-3009 signing + 402 challenge resolution]
│   └── types.ts              [NEW — x402 wire-format types]
├── types.ts                  [unchanged]
└── index.ts                  [MODIFIED — export new symbols]

CHANGELOG.md                  [MODIFIED — promote v0.1.0 from Unreleased]
README.md                     [MODIFIED — natural-language usage example, paid-mode docs]
package.json                  [MODIFIED — version bump, default mode in agentConfig]
```

### Component design

**1. Prompt template (`src/templates/trust-check.ts`)**

Hand-write as a string constant matching plugin-evm's TOON format:

```ts
export const trustCheckTemplate = `Given the recent messages below:

{{recentMessages}}

The user wants to verify a token contract before swapping into it. Extract:
- Buy-token contract address (EIP-55 hex address; required if mentioned)
- Chain ID (default 8453 / Base if not mentioned)
- Optional: agent wallet address (taker)

Respond using TOON format like this:
address: 0x... (EIP-55 hex address of the token to verify, or empty)
chainId: number (e.g. 8453)
taker: 0x... or empty

IMPORTANT: Your response must ONLY contain the TOON document above. No preamble or explanation.`;
```

**2. Action handler (`src/actions/trust-check.ts`)**

Replace the v0.0.1 `pickRequest()` (which just reads `options.address`) with:

```ts
async function buildTrustCheckArgs(
  state: State,
  message: Memory,
  runtime: IAgentRuntime,
  config: PaladinTrustConfig,
): Promise<TrustCheckRequest> {
  state = await runtime.composeState(message, ["RECENT_MESSAGES"], true);

  const context = composePromptFromState({
    state,
    template: trustCheckTemplate,
  });

  const llmResponse = await runtime.useModel(ModelType.TEXT_SMALL, {
    prompt: context,
  });

  const parsed = parseKeyValueXml(llmResponse);
  if (!parsed) {
    throw new Error("paladin_trust_check: LLM response could not be parsed");
  }

  // Validate address
  const address = String(parsed.address ?? "").trim();
  if (!address || !isAddress(address as Address)) {
    throw new Error(
      `paladin_trust_check: extracted address is not valid EIP-55 hex: "${address}"`,
    );
  }

  // Default chainId
  const chainIdRaw = String(parsed.chainId ?? config.defaultChainId);
  const chainId = Number.parseInt(chainIdRaw, 10);

  // Optional taker
  const takerRaw = String(parsed.taker ?? "").trim();
  const taker =
    takerRaw && isAddress(takerRaw as Address) ? takerRaw : undefined;

  return trustCheckRequestSchema.parse({ address, chainId, taker });
}
```

The handler retains backwards-compat with `options.address` — if explicit `options.address` is provided, skip LLM extraction. This is important for programmatic callers.

**3. x402 settlement (`src/x402/settle.ts`)**

The flow:
1. POST to `/v1/trust-check` (no auth) → expect 402 Payment Required response with `payment-required` header
2. Decode `payment-required` per x402 spec (base64-encoded JSON)
3. Sign EIP-3009 `transferWithAuthorization` for USDC on Base ($0.001 = 1000 with 6 decimals)
4. Re-POST with `Authorization: x402 <signed>` header
5. Receive 200 with the live trust-check response

Wallet integration: the plugin's existing `runtime` doesn't directly expose a signer. **Critical question:** does Eliza's `IAgentRuntime` provide a wallet? Looking at plugin-evm, they import `initWalletProvider` from `./providers/wallet` — i.e., they wire their OWN wallet provider that wraps the runtime's settings.

For us, simplest path: accept a **viem `WalletClient`** as a config option, OR create a minimal `PaladinWalletProvider` that reads `EVM_PRIVATE_KEY` from runtime settings (matching plugin-evm convention).

**Design decision:** for v0.1.0, accept an optional `walletClient` in `PaladinTrustConfig`. If absent, paid mode throws with clear error. This keeps us out of the wallet-provider abstraction business while letting agents that already have viem wallets integrate.

```ts
export interface PaladinTrustConfig {
  apiBase: string;
  mode: "preview" | "paid";
  defaultChainId: number;
  walletClient?: WalletClient; // NEW in v0.1.0; required for paid mode
}
```

**4. Paid client (`src/client.ts`)**

```ts
async paid(req: TrustCheckRequest): Promise<TrustCheckResponse> {
  if (!this.config.walletClient) {
    throw new Error(
      "paid mode requires `walletClient` in PaladinTrustConfig (viem WalletClient on Base)",
    );
  }

  // Step 1: trigger 402
  const url = `${this.config.apiBase}/v1/trust-check`;
  const challenge = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(req),
  });

  if (challenge.status !== 402) {
    // Either 200 (somehow free?) or unexpected error
    if (challenge.ok) {
      const json: unknown = await challenge.json();
      return trustCheckResponseSchema.parse(json);
    }
    throw new Error(`paid HTTP ${challenge.status}`);
  }

  // Step 2: resolve x402 challenge
  const paymentHeader = challenge.headers.get("payment-required");
  if (!paymentHeader) {
    throw new Error("paid: 402 response missing payment-required header");
  }

  const auth = await signX402Authorization(
    this.config.walletClient,
    paymentHeader,
  );

  // Step 3: re-request with Authorization
  const settled = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `x402 ${auth}`,
    },
    body: JSON.stringify(req),
  });

  if (!settled.ok) {
    const body = await settled.text().catch(() => "<unreadable>");
    throw new Error(`paid (after settlement) HTTP ${settled.status}: ${body.slice(0, 500)}`);
  }

  const json: unknown = await settled.json();
  return trustCheckResponseSchema.parse(json);
}
```

The `signX402Authorization()` helper lives in `src/x402/settle.ts` and uses viem to sign the EIP-3009 `transferWithAuthorization` typed-data message.

### Testing strategy

- **Smoke test extension** (no new test framework): extend `smoke-test.mjs` to add a paid-mode case, gated behind `PALADIN_TRUST_LIVE_PAID=1` env var. Default invocation runs only preview-mode checks (no wallet required).
- **Manual integration**: against the live `/v1/trust-check` endpoint with a small Base testnet wallet (Sepolia for non-cost validation? or just real Base with $0.001 throwaway).
- **Vitest tests deferred to v0.2.0** — smoke-test covers the must-have for v0.1.0.

### Sequencing (estimated ~6-10 hours)

1. **Prompt template + LLM extraction** (~2 hr)
   - Write `src/templates/trust-check.ts`
   - Modify `src/actions/trust-check.ts` to wire `composePromptFromState` + `runtime.useModel` + `parseKeyValueXml` (with options.address backwards-compat)
   - Smoke-test: stub the runtime's `useModel` to return a fixed TOON response, verify args parse correctly
   - Typecheck + build clean

2. **x402 settlement** (~3-5 hr — most uncertain)
   - Write `src/x402/types.ts` with the wire-format types (decoded payment-required header)
   - Write `src/x402/settle.ts` with the EIP-3009 signing function (uses viem's `signTypedData`)
   - Modify `src/client.ts` `paid()` to do the 402 → sign → retry flow
   - Add `walletClient?` to `PaladinTrustConfig`

3. **Mode default flip + config** (~30 min)
   - `src/types.ts` `DEFAULT_CONFIG.mode` = `"paid"`
   - `package.json` `agentConfig.pluginParameters.PALADIN_TRUST_MODE.default` = `"paid"`
   - README: update Configuration section + add wallet-required-for-paid disclosure

4. **Documentation + release prep** (~1 hr)
   - README "Use in a character" section: natural-language example showing the agent extracting buy-token from chat
   - CHANGELOG.md: promote v0.1.0 from Unreleased
   - Bump `package.json` version to `0.1.0`
   - Update `src/index.ts` exports if new symbols
   - Test reproducibility line in README

5. **Smoke test + publish** (~30 min)
   - Run `npm run build` clean
   - Run `node smoke-test.mjs` — 7+/7+ pass
   - `npm publish --access public`
   - Verify via `curl https://registry.npmjs.org/@paladinfi/eliza-plugin-trust/0.1.0`
   - Tag v0.1.0 GitHub release with notes
   - Post follow-up comment on Eliza Discussion #7242 announcing v0.1.0
   - Post Tweet 6 (Draft B in TWITTER_QUEUE)
   - Close tracking issue #1 with a "shipped" comment

### Risks

- **R1 [HIGH]: x402 spec details I don't know precisely.** The signing flow is documented but I haven't implemented it before. Mitigation: study x402 spec + AgentKit's `x402ActionProvider/utils.ts` (in-tree at coinbase/agentkit) which implements exactly this flow on the agent side. We can model our signing after their code (MIT-compatible with attribution).

- **R2 [MED]: LLM extraction reliability.** If the model fails to produce valid TOON or omits required fields, the user gets a confusing error. Mitigation: explicit error messages naming what was missing/malformed, fall back to `options.address` if explicit, log the LLM's raw response on parse failure.

- **R3 [MED]: Backwards-compatibility break.** v0.0.1 users pass `options.address` explicitly. v0.1.0 adds LLM extraction as the primary path. Mitigation: handler tries `options.address` FIRST (if provided); falls back to LLM only if absent. Programmatic callers continue to work without changes.

- **R4 [LOW]: Default mode flip.** v0.0.1 was `preview`. v0.1.0 default is `paid`. Existing users who set up against v0.0.1 with no mode override will SUDDENLY hit paid endpoint and need a wallet. Mitigation: clear CHANGELOG entry under "Breaking changes" section + README "Migration from v0.0.1" section noting the flip.

- **R5 [LOW]: Wallet provider abstraction limited.** v0.1.0 requires the user to construct a viem `WalletClient` and pass it into config. This is explicit but more friction than auto-resolving from runtime settings (plugin-evm's pattern). Mitigation: this is acceptable for v0.1.0; v0.2.0 adds `EVM_PRIVATE_KEY` auto-resolution from runtime.

### Definition of done

- [ ] `npm run typecheck` clean
- [ ] `npm run build` produces clean dist
- [ ] `npm pack --dry-run` produces clean tarball (no junk; size ≤ 25 kB)
- [ ] `node smoke-test.mjs` all checks pass (preview + paid-with-stub)
- [ ] Manual paid-mode test with real Base wallet against live `/v1/trust-check`
- [ ] CHANGELOG.md v0.1.0 entry promoted from Unreleased
- [ ] README updated: Use in a character, Configuration, Cost, Roadmap, Migration sections
- [ ] `package.json` version `0.0.1` → `0.1.0`, `agentConfig.pluginParameters.PALADIN_TRUST_MODE.default` flipped
- [ ] Published to npm at `https://www.npmjs.com/package/@paladinfi/eliza-plugin-trust/v/0.1.0`
- [ ] GitHub release `v0.1.0` tagged with release notes
- [ ] Eliza Discussion #7242 follow-up comment posted announcing v0.1.0
- [ ] Tracking issue #1 closed with "shipped" comment
- [ ] Tweet 6 posted to `@paladin_fi`

---

## Pre-flight cite verification

| Cited surface | Status |
|---|---|
| `elizaos-plugins/plugin-evm/typescript/actions/transfer.ts` | LIVE (verified earlier this session) |
| `elizaos-plugins/plugin-evm/prompts/transfer.txt` | LIVE (verified earlier; format is TOON not XML) |
| `composePromptFromState` from `@elizaos/core` | EXISTS (used by transfer.ts; need to verify exact import path is stable in alpha.77) |
| `parseKeyValueXml` from `@elizaos/core` | EXISTS (used by transfer.ts) |
| `ModelType.TEXT_SMALL` | EXISTS (used by transfer.ts) |
| `coinbase/agentkit/typescript/agentkit/src/action-providers/x402/utils.ts` | LIVE (read this session — has full x402 settlement code we can model) |
| viem `signTypedData` for EIP-3009 | STANDARD viem usage; well-documented |
| Base USDC EIP-3009 contract | `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` (verified) |
| `https://swap.paladinfi.com/v1/trust-check` returns 402 with `payment-required` header | NOT YET VERIFIED — must probe before implementing client; if shape differs from x402 spec, plan adjusts |

**Action required before implementation starts:** probe `POST /v1/trust-check` with no auth, decode the 402 response, confirm x402-compliant payment-required header is returned. If the live endpoint differs from the standard x402 spec, the settlement code adjusts.

---

## Adversarial review gate

3 reviewers, parallel, each unforgiving:

1. **Engineering reviewer** — is the architecture sound? Are there bugs in the design? Is the v2-alpha pattern correctly mirrored? Any structural mistakes that will cost rewrite later?

2. **Security reviewer** — x402 settlement = real money signing. Any leak vectors in EIP-3009 signing? Replay vulnerabilities? Wallet exposure in error messages? Race conditions in the 402-then-retry flow?

3. **Maintainer / community moderator perspective** — is this what real Eliza plugin authors would build? Any cargo-culting from plugin-evm that doesn't apply to a read-only-API-call plugin? Is the scope right (not over-engineered, not under-engineered)?

Output per reviewer: APPROVE-AS-IS / APPROVE-WITH-MINOR-FIXES / REQUIRES-MAJOR-REWRITE / REJECT-PAUSE-AND-REPLAN.
