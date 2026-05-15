# Threat model — `@paladinfi/eliza-plugin-trust` v0.2.0

This document is the full honest disclosure for `paladin_swap`. README §Threat model gives the executive summary; this is the unvarnished detail.

**Last updated:** 2026-05-05 (v0.2.0 release)

---

## Table of contents

1. [Defense layers — what each one catches](#1-defense-layers--what-each-one-catches)
2. [Documented narrow residual](#2-documented-narrow-residual)
3. [2-of-2 KMS signing pair (vs 3-of-3)](#3-2-of-2-kms-signing-pair-vs-3-of-3)
4. [Software-key custody (FIPS 140-2 L1)](#4-software-key-custody-fips-140-2-l1)
5. [Provider region disclosure](#5-provider-region-disclosure)
6. [Multisig owner is PaladinFi-controlled](#6-multisig-owner-is-paladinfi-controlled)
7. [The 7-day timelock IS the customer's defense](#7-the-7-day-timelock-is-the-customers-defense)
8. [Cloud-provider account suspension](#8-cloud-provider-account-suspension)
9. [No customer email list at v0.2.0](#9-no-customer-email-list-at-v020)
10. [Force-migration honesty](#10-force-migration-honesty)
11. [Hourly outage from drain-then-refresh](#11-hourly-outage-from-drain-then-refresh)
12. [v0.3.0 traction gate commitments](#12-v030-traction-gate-commitments)

---

## 1. Defense layers — what each one catches

`paladin_swap` runs through 6 layers before returning calldata. For an attacker to extract funds, ALL layers must be bypassed.

| Layer | What | Where | What it catches |
|---|---|---|---|
| 1 | Server-side router/selector/Settler-target whitelist (deployed v0.11.71) | Server | Aggregator returning calldata to an attacker-controlled router |
| 2 | Client-side mirror of layer 1 + 7-selector hard deny-list | Plugin | Compromised PaladinFi server returning attacker-routed quote |
| 3 | Cryptographic verification of /v1/simulate response (2-of-2 KMS + on-chain trust anchor) | Plugin | Compromised PaladinFi simulator returning forged "ok=true" — requires both AWS Key #1 + GCP Key #2 to forge, plus on-chain trust anchor + 7-day timelock to bypass |
| 4 | Server-side Anvil simulation with multi-token state-diff + per-selector In*/Out* family invariant + third-token drain check + native ETH delta sanity | Server | Attacker calldata that, when executed on-chain, would drain a third token (not sellToken/buyToken), spend more than sellAmount, receive less than minBuyAmount, or burn unexpected native ETH |
| 5 | Plugin-side independent state-diff invariant validation | Plugin | Compromised PaladinFi server returning ok=true with deltas that violate the swap shape — signature checks pass but invariant logic catches it client-side |
| 6 | Per-customer spending discipline (per-token cap + rate limit + hourly + daily $-cap) | Plugin | Caps blast radius if all 5 layers above somehow fail |

The layers compose: layers 1+4 are on the server; layers 2, 3, 5, 6 are in the plugin. Bypassing all 6 simultaneously requires compromising AWS account A + GCP project + at least one customer's local environment.

**Layer 5 honest framing.** Layer 5 is **independent re-validation of the server's claimed deltas**, not re-simulation. The plugin re-runs the same invariant logic the server applies (third-token drain check, In*/Out* family bounds, ETH sanity) using its own bundled TOKEN_REGISTRY + sellAmount + minBuyAmount from the quote it requested. If a compromised server returns a signed payload (with valid 2-of-2 KMS sigs) whose deltas claim "ok=true" but actually drain a third token, Layer 5 catches it. The two implementations (Python on server, TypeScript on plugin) are intentionally redundant — drift between them is detected by the cross-language fixture suite.

**Why Layer 5 is not full client-side simulation.** The original v3.4 R6 HIGH-4 fix specified additive client-side viem simulation as the second simulator. Empirically (v0.2.0 build-step-0 viability diagnostic), `eth_call + stateOverride` cannot generalize across aggregator paths: Velora's `swapOnUniswapV3` reverts with `CallbackTransferFailed()` because the actual transferFrom spender is the V3 *pool* (varies per quote), not any address that can be enumerated and mocked ahead of time. A truly independent client-side simulator (running on different infrastructure than PaladinFi) requires either a Tenderly fork (paid + customer-side trust in Tenderly's TLS) or a local Anvil child process (heavy npm package ask). Both are documented as v0.2.X follow-on options; until then, plugin-side independent invariant validation is the load-bearing client-side defense.

**What plugin-side invariant validation catches that server's doesn't:**
- Server-side invariant logic bug (T19's Python implementation has a defect that lets bad calldata through; TypeScript implementation catches independently)
- Compromised server with valid KMS sigs returning forged ok=true + deltas that lie about a drain
- Drift between server and plugin invariant logic — plugin's bundled invariant rules are the customer's claim about what's safe; if server returns deltas the plugin doesn't accept, the plugin refuses to sign

**What it does NOT catch (residual risk for v0.2.0):**
- Server simulating correctly but signing different calldata (defended by signed-payload requestHash binding, see paladin-verify.ts step 4)
- Server correctly simulating + signing, but returning a "wrong" but invariant-satisfying delta (e.g., low slippage that's still above minBuyAmount). This requires truly independent simulation infrastructure (Tenderly or local Anvil), planned for v0.2.X.

---

## 2. Documented narrow residual

The single class of risk `acknowledgeRisks: true` explicitly accepts: **block-divergence between simulate-time and execute-time.**

The Anvil simulator forks Base mainnet on an hourly cadence. The actual swap signed by the customer's wallet executes minutes later. In that gap, pool prices can move — the simulation said "you'll get 30M wei WETH" but on-chain execution gets 29.7M wei.

**Mitigation:** `minBuyAmount` is set in the calldata and on-chain slippage protection enforces the floor. The trade either fills at-or-above `minBuyAmount` or reverts. The customer never executes a trade at a price *worse* than minBuyAmount. They may simply revert — wasted gas, no fund movement.

**What this is NOT:** the simulator is not lying. The simulator returned what was true at simulate-time; the world moved. minBuyAmount is the customer's cushion against that movement.

**v0.3.0 addresses this** with real-time fork refresh < 60s (multi-region paladin-simulator).

---

## 3. 2-of-2 KMS signing pair (vs 3-of-3)

v0.2.0 uses **2-of-2** for /v1/simulate response signing — two KMS keys at two different cloud providers (AWS KMS Key #1 + GCP Cloud KMS Key #2). Both must sign every response.

**Why 2-of-2 instead of 3-of-3 (which is what reviewers initially preferred):**
- Cost was originally cited but is rounding error (~$5/mo for either configuration)
- Real reason: **operational simplicity at single-admin scale.** Managing 2 cloud accounts is meaningfully simpler than 3 for a one-person team
- Azure KYB verification adds 5-14 day calendar wait; v0.2.0 launch couldn't accept that
- v0.3.0 traction gate adds Azure as the 3rd provider returning to 2-of-3 (or 3-of-3 customer-selectable)

**What 2-of-2 means for forgery:**
- Single-key compromise → forgery still impossible (need both)
- Both keys compromised → forgery possible until next rotation (30-day attacker window per staggered cadence)
- The 7-day timelock + per-epoch revocation gives operators recovery time

**Indexer attestation key #3 lives at a separate AWS organization** (us-west-2) — events.json transparency mirror is signed by this key alone. AWS account A compromise gives only Key #1; AWS account B compromise gives only Key #3; GCP compromise gives only Key #2. To forge BOTH `/v1/simulate` responses AND events.json, an attacker needs ALL THREE accounts compromised.

---

## 4. Software-key custody (FIPS 140-2 L1)

All three v0.2.0 KMS keys use **software-key custody**: AWS KMS standard symmetric key + GCP Cloud KMS with `protectionLevel=SOFTWARE`. This is FIPS 140-2 Level 1.

**What this means:**
- Cloud-provider operators have privileged-access paths to the underlying key material in principle (multi-tenant; provider's BMC has access)
- A government subpoena (US CLOUD Act / FISA 702) reaching the cloud provider could compel key disclosure — applies to all three providers since all are US-headquartered

**v0.3.0 traction gate** upgrades to **HSM-backed** (FIPS 140-2 Level 3): AWS KMS Custom Key Stores + GCP Cloud HSM. Key material in dedicated HSMs that provider operators cannot access. Cost: ~$3k/mo additional. Justified at v0.3.0 traction gate; unjustified at v0.2.0 pre-revenue scale.

**Customer-side defense if you can't accept FIPS L1:**
- `keyTrustMode: 'pinned'` — manually approve every rotation; mass insider-compromise rotation requires you to npm-update before they take effect
- `simulationVerifier: 'tenderly'` — bypass our verification entirely

---

## 5. Provider region disclosure

Key material location matters for jurisdictional analysis (GDPR Schrems-II, US CLOUD Act, FISA 702):

| Key | Provider | Account | Region | Physical location |
|---|---|---|---|---|
| Key #1 (sim signing) | AWS KMS | Account A | us-east-2 | Ohio, USA |
| Key #2 (sim signing) | GCP Cloud KMS | Project (single) | us-east1 | Moncks Corner, South Carolina, USA |
| Key #3 (attestation) | AWS KMS | Account B (separate org from A) | us-west-2 | Oregon, USA |

**All three are US datacenters operated by US-incorporated providers.** Key material does NOT replicate cross-region without explicit operator action.

**For EU customers under GDPR / EU Data Protection** considering paladin_swap: the keys protecting your simulation results live in US datacenters. Customer plugins running in the EU make signed-response verification calls that cross the Atlantic (the verification itself is local — the customer's plugin verifies signatures against on-chain trust anchor — but the trust anchor itself is on Base which is also a US-incorporated chain). Customers with strict data-sovereignty requirements should use `keyTrustMode: 'pinned'` + `simulationVerifier: 'tenderly'` (where they pick the Tenderly region) or wait for v0.3.0 EU KMS region option.

---

## 6. Multisig owner is PaladinFi-controlled

The owner of `PaladinKeyRegistry` on Base is a **Gnosis Safe 2-of-3 multisig**. In v0.2.0, **all three signers are operated by PaladinFi** (the maintainer):

- Signer 1: primary hardware wallet (Ledger), daily-use device
- Signer 2: secondary hardware wallet (Ledger), geographically separated cold storage
- Signer 3: time-locked encrypted backup with split-key Shamir recovery, three separate physical locations (≥2 jurisdictions per recovery procedure in RUNBOOK)

**This is operationally a single-person trust root** — calling it a "2-of-3 multisig" is technically correct but materially misleading without disclosure. We disclose it.

**The customer's defense** is NOT the multisig threshold (which is single-person at v0.2.0). It's the **7-day rotation timelock + on-chain transparency** — see next section.

**v0.3.0 traction gate** adds an independent third-party signer (4-of-N where N≥4). When the gate fires, the multisig becomes genuinely multi-party. **If no qualified third party can be identified within 90 days of the gate firing, fallback options include Anchorage / Coinbase Custody multisig participation products**; v0.3.0 release is GATED on backstop activation.

---

## 7. The 7-day timelock IS the customer's defense

Every state change to `PaladinKeyRegistry` (rotation, token-registry-hash change, indexer-key change, ownership transfer) requires a **7-day delay** between propose and finalize. Plus a 24-hour overwrite lockout (last 24h of pending cannot be replaced) and a 24-hour finalize-owner-only window (only the owner can finalize for the first 24h after the timelock elapses, preventing permissionless front-run of a legitimate cancel).

**What this means in practice:**
- An attacker who compromises the PaladinFi multisig owner can propose a rotation to attacker-controlled keys
- That rotation transaction lands on Base and is publicly visible immediately
- For 7 days, anyone watching can see "PaladinFi proposed a key rotation" and react
- Customers in `keyTrustMode: 'pinned'` are unaffected (they don't follow on-chain rotations)
- Customers in `keyTrustMode: 'auto-rotate'` who have read THIS section know to monitor PaladinFi's announcement channels for confirmation that the rotation is legitimate
- The PaladinFi multisig (or a guardian-recovery procedure) calls `cancelRotation()` if the proposal is malicious

**For external observers**, the on-chain transparency means independent monitoring tooling (block explorers, Tenderly Alerts, Forta) can detect proposed rotations in <2 seconds and propagate alerts. We register the contract with these services at deploy time.

**This is the load-bearing defense.** Multisig-threshold provides marginal additional defense at v0.2.0 (since all signers are PaladinFi-operated), but the timelock is what gives external parties (you, the customer) the time to react.

---

## 8. Cloud-provider account suspension

Cloud providers occasionally suspend customer accounts for fraud detection, billing disputes, or policy reviews. This has happened to similar fintech setups; we acknowledge the risk explicitly.

**If AWS, GCP, or AWS-B is suspended:**
- That provider's KMS keys cannot sign for the duration of the suspension
- v0.2.0 has 2-of-2 threshold; **any single-provider suspension breaks /v1/simulate signing entirely**
- Auto-rotate customers see `RESPONSE_SIG_INVALID` errors → fail-closed
- Pinned-mode customers continue working as long as the suspended provider's key wasn't part of their pinned pair (it always is, since both are required for 2-of-2)

**Realistic recovery time:** 7-10 days for routine billing/policy issues; weeks for fraud-related holds. v0.2.0 has no hot-spare; we'd reprovision a new account at the suspended provider and propose a key rotation (7-day timelock) before service resumes.

**v0.3.0 traction gate** adds a 4th hot-spare KMS provider (Azure) running in standby. Single-provider suspension wouldn't affect signing; we'd switch to the 3 active providers + invoke standby. Recovery time compressed to <24h.

**Customer-side mitigations available now:**
- `simulationVerifier: 'tenderly'` — completely bypasses our signing path
- `keyTrustMode: 'pinned'` — at least know what you're committed to

---

## 9. No customer email list at v0.2.0

We do not maintain a customer email list at v0.2.0. Updates publish to:
- GitHub Discussions (#7242 for announcements)
- X (@paladin_fi) for time-sensitive ops
- The public events feed (signed JSON at `swap.paladinfi.com/v1/keys/events.json` — for machine-readable on-chain event mirror)
- npm release notes

**v0.3.0 status-page commitment:** when the v0.3.0 traction gate fires, we add a customer email list + status page (statuspage.io or similar) for incident broadcasts.

**Customer-side mitigation:** subscribe to GitHub Discussions watch + npm package updates; if you operate at scale, consider following the Cloudflare Worker public events feed directly.

---

## 10. Force-migration honesty

The plugin's `PALADIN_KEY_REGISTRY_BASE_DEFAULT` constant is hardcoded in npm-published code. When v0.3.0 ships with a NEW contract address (e.g., adding new state fields requires a fresh deploy), customers running v0.2.0 plugins continue reading the v0.2.0 contract **forever** unless they upgrade.

**We have no force-upgrade lever.** The contract is non-upgradable; `revoke(currentEpoch)` is forbidden by design (anti-brick); `pause()` was rejected (would centralize control).

**Our recovery paths:**
- Public advisory (GitHub Discussions, X, signed events feed)
- Revoke recent v0.2.0-era epochs as soft deterrent (only past epochs; can't revoke current)
- Halt rotations on the v0.2.0 contract entirely; customers freeze on last-known-good triple
- Direct outreach to known customers (no email list, but GitHub commit history identifies some)

**Customer-side risk:** if you run a v0.2.0 plugin past the v0.3.0 release date, you're trusting whatever vulnerabilities are discovered in v0.2.0 *post-release*. We strongly recommend tracking npm releases and updating within 90 days of v0.3.0 ship.

---

## 11. Hourly outage from drain-then-refresh

The Anvil simulator refreshes its mainnet fork every hour. During the refresh window (~12 seconds), `/v1/simulate` returns HTTP 503 with `Retry-After: 15`. Plugins handle this gracefully — they treat 503 as transient and the customer's agent retries automatically.

**Expected uptime ceiling:** ~99.7% (12s × 24 hr/day = 4.8 min/day = 99.667%).

**Customer-side mitigation:** if you have <500ms latency budget, configure aggressive timeout retries; or use `simulationVerifier: 'tenderly'` which has its own uptime profile.

**v0.3.0** addresses this with real-time fork refresh < 60s (multi-region paladin-simulator). At that scale, drain windows are sub-second and customer-imperceptible.

---

## 12. v0.3.0 traction gate commitments

The v0.3.0 traction gate is **AND-of-2**:
- ≥10 paying customers each ≥$50/mo for 2 consecutive months **AND**
- (≥$500/mo total recurring **OR** enterprise binding LOI ≥ $10K with documented signing authority — director-or-above title for $10K-$50K range, VP-or-above for >$50K)

When the gate fires, we batch the following hardenings:
- **Multi-chain expansion** (Optimism, Arbitrum first; later Polygon if demand)
- **Ethereum-mainnet-anchored trust registry variant** (gated by traction; opt-in via factory flag)
- **Independent third-party multisig signer** joining as 4th signer (3-of-4) — backstop via Anchorage / Coinbase Custody if no qualified independent signer in 90 days
- **HSM-backed KMS keys** (FIPS 140-2 L3) across all providers (~$3k/mo additional)
- **Multi-admin separation-of-duties** on KMS providers
- **Hot-spare 4th KMS provider** (eliminates 7-10 day account-suspension fail-closed window)
- **Real-time fork refresh < 60s** (multi-region paladin-simulator)
- **Customer email list + status page**
- **Fee-on-transfer support**
- **ERC-7683 cross-chain intents**

**These are commitments, not roadmap aspirations.** When the traction gate fires, the v0.3.0 release is GATED on backstop activation for the independent signer. We will NOT advance the version label without genuine separation-of-duties.

---

## What this document IS

A complete, no-marketing disclosure of every threat-model property of `paladin_swap` at v0.2.0. We've tried to be honest about every weakness, every customer-side mitigation, and every commitment for v0.3.0.

## What this document is NOT

A guarantee. Software has bugs. Cryptographic systems have unforeseen attack vectors. Cloud providers have outages. We've documented what we know about; we cannot document what we don't yet know.

If you find a security issue, please report responsibly to security@paladinfi.com. We commit to a fix-then-disclose timeline appropriate to severity (P0 same-day fix, P1 within 30 days, P2 within 90 days).

---

**License:** MIT, same as the plugin. **Last review:** 2026-05-05.
