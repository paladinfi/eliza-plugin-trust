# Changelog

All notable changes to `@paladinfi/eliza-plugin-trust` are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.3.0] - 2026-05-15

> **⚠ MUST READ before integrating:** v0.3.0 is the first public release of the on-chain-trust-anchor architecture. Read [THREAT_MODEL.md](./THREAT_MODEL.md) §§3-7 before enabling.

v0.3.0 is the first public release. An internal v0.2.0 candidate was held back for a security-hardening sprint, which is incorporated here.

### Wire-format breaking change

`paladin-simulate-v1` → `paladin-simulate-v2`. No v0.2.0 customers exist; the new wire format is the only shipped one.

### Security hardening (addresses every CRITICAL/HIGH from a 3-adversary Security audit)

- **Typed-domain digest** (closes C-1): digest is now `keccak256(keccak256("PaladinFi/simulate/v2") ‖ keccak256(JCS(body)))` — structurally separated 32-byte domain constant + 32-byte body hash. Pre-hardening the domain separator was the raw apiVersion string (audit-flagged as structurally weak).
- **Explicit `chainId` binding** (closes H-1): `chainId` is a top-level signed envelope field. Plugin verifier asserts `signed.chainId === expectedChainId` as defense-in-depth on top of the transitive binding via `requestHash`. The `VerifyOpts` interface now requires `expectedChainId`.
- **Cross-language JCS strict-mode symmetry** (closes H-3): TypeScript canonicalizer now rejects integers outside `Number.MAX_SAFE_INTEGER`, mirroring Python's strict-mode reject.
- **Production fail-closed on epoch unavailability** (closes M-3): server raises `EpochUnavailableError` → HTTP 503 EPOCH_UNAVAILABLE instead of silently signing wrong-epoch envelopes.
- **retryToken HMAC scope expansion** (closes M-1): HMAC binding includes `(request_hash, taker, ip_/24-or-/56_prefix, expires_at)`. Leaked tokens can no longer be replayed across different takers or networks. Now issued on 503 paths so the plugin can present them on retry to bypass x402 double-charge.
- **x402 facilitator URL host-allowlist** (closes M-4): facilitator URLs validated against allowlist at module load.
- **Server multi-RPC quorum for epoch reads** (closes L-1): K-of-N quorum matching plugin discipline.
- **XFF trusted-proxy guard**: `_extract_caller_ip()` honors `X-Forwarded-For` only when peer is in `PALADIN_TRUSTED_PROXY_CIDR`.
- **`SimulateRequest.api_version` tightened** to `Literal["paladin-simulate-v2"]` (closes audit N-3): direct API callers sending v1 get HTTP 422.

### Plugin source changes

- `src/shared/domain-separators.ts`: v2 typed-domain constant + parity fixture (`tests/fixtures/domain-separators-parity.json`)
- `src/utils/paladin-verify.ts`: v2 digest formula + `chainId` check + `DEFAULT_ACCEPT_VERSIONS = ["paladin-simulate-v2"]`
- `src/utils/paladin-canonical.ts`: int-safety reject (>2^53)
- `src/utils/paladin-simulate.ts`: wire-format bump to v2
- `src/actions/paladin-swap.ts`: `expectedChainId` wired to `verifyAndExtract` call sites

### Test pack (in `paladinfi-contracts` repo)

Six e2e tests at `tests/v0.2.0/e2e/` covering signing chain, edge cases (incl. Literal validator), Layer 5 cross-validation + tamper detection, production-readiness (incl. burst rate-limit), and v2 digest parity. Path is `v0.2.0` for historical reasons; tests run against the live v0.3.0 endpoint.

### Live production state at v0.3.0 ship

- `PaladinKeyRegistry` at `0x30Bad67154C0115c5873b291cf3Dda120e508775` on Base ([Basescan verified source](https://basescan.org/address/0x30Bad67154C0115c5873b291cf3Dda120e508775#code))
- Owner: [Gnosis Safe 2-of-3](https://app.safe.global/home?safe=base:0x824B874dE8E6FEFb99705F9f30097525c1722C2A)
- Live endpoint: `https://swap.paladinfi.com/v1/simulate` (v0.12.0 server)

## [0.2.0] - 2026-05-XX (held back; superseded by v0.3.0 — see v0.3.0 entry above)

> **⚠ MUST READ before setting `paladinSwapEnabled: true`:** v0.2.0 introduces a new trust model. Read [README §Cryptographic verification (Layer 3)](./README.md#cryptographic-verification-layer-3) and [THREAT_MODEL.md](./THREAT_MODEL.md) before enabling. The `paladin_swap` action verifies signatures against a 2-of-2 KMS pair using software-key custody at v0.2.0; v0.1.0 customers using `paladin_trust_check` only are unaffected.

Major release. Adds `paladin_swap` Action — combined trust-check + swap-quote + cryptographically-verified server-side simulation. Plan iterated through 8 plan-level adversarial-review rounds (R8-R15) before unanimous APPROVE-WITH-MINOR-FIXES. Audit trail: see plugin repo's `_archive/` for the 11-version plan progression (v3 → v11) + 8 review rounds (R8-R15) of 3-adversary + 5-persona reviews.

Effort: ~145-170 hr engineering, including 5 layers of defense, 27-code closed error contract, 16-step handler with retry-once on rotation race, multi-RPC quorum + HMAC'd cache + sticky-revoked, 2-of-2 ECDSA verification with low-s normalization, RFC 8785 JCS canonicalization with 50-fixture cross-language harness, settlement-state-aware paid call accounting, debug bundle with redaction, plus the on-chain `PaladinKeyRegistry` Solidity contract and Foundry test suite at `paladinfi/contracts`.

### Added

**Plugin-side foundation (Steps 1-9 of v11 §7):**
- 27-code closed-enum `ErrorCode` + `PaladinTrustError` class + `isPaladinTrustError` type guard
- `Clock` interface with `realClock` + `FakeClock` + production guardrail (throws if `clockOverride` set when `NODE_ENV=production`)
- `RateLimiter` (token-bucket via timestamp queue, Clock-injected)
- `TOKEN_REGISTRY` for 7 supported tokens (USDC, USDT, WETH, cbBTC, DAI, AERO, USDbC) with deterministic `TOKEN_REGISTRY_HASH` (sorted-key keccak256)
- `SpendingTracker` (file-backed hourly+daily caps with `proper-lockfile` advisory lock + atomic tmp/rename + refund + warn-log)
- 3 spending profiles (`paper-test` / `default` / `pro`) with BigInt-precision `scaleCaps`
- Layer 2 client-side router/selector validation (7-selector hard deny-list + Velora 11 + 0x exec selector + 0x Settler target whitelist + inner-target ABI offset decoder)
- RFC 8785 JCS canonicalization wrapper (`@truestamp/canonify`) with PaladinFi-specific guards (no NaN/Infinity/undefined/BigInt; path-tracking validation)
- Foundry/Anvil test fixture with atomic dual-clock `advanceTime` (FakeClock + `evm_increaseTime`)

**Cryptographic verification (Steps 10-13):**
- `paladin-keys.ts` — on-chain reader with HMAC-protected disk cache + max-epoch-wins multi-RPC quorum (≥2 distinct operators) + sticky-revoked keyed on `(epoch, pairHash)` + in-flight fetch dedup + epoch-decrease guard + 6h cache TTL + 2h stale-grace
- `paladin-verify.ts` — 2-of-2 ECDSA verification with EIP-2 low-s normalization + version-downgrade prevention (numeric `compareVersion`) + TOKEN_REGISTRY_HASH binding via `serverObservedTokenRegistryHash` (per-call, not per-cache-cycle) + freshness check ±600s with -120s clock-skew + 4 retryable errors (`RESPONSE_SIG_INVALID`, `RESPONSE_EPOCH_MISMATCH`, `RESPONSE_EPOCH_REVOKED`, `TOKEN_REGISTRY_DRIFT`)
- `paladin-simulate.ts` — Layer 4 HTTP client with `generateClientNonce` (32-byte CSPRNG) + `computeRequestHash` + retryToken support for x402 idempotency + AbortSignal threading
- `tenderly-simulate.ts` — fallback verifier with `verifyAccountChecksum` (typosquatting defense) + signed-advisory file (5 explicit checks: window ≤7d, future-skew ≤60s, not expired, epoch-bound, 2-of-2 sig); throws until SPKI cert-pin wiring at deploy

**Foundation closure (Steps 14-17):**
- `debug-bundle.ts` — `DebugBundle` class with `paladin-debug-v1` schema + categorical `NEVER_INCLUDE_FIELDS` (private keys, mnemonics, x402 auth, raw calldata, signed payloads, server_secret, integrity keys, tenderlyConfig.accessKey) + 32-byte-hex auto-redaction + 50MB size cap with truncate-oldest rotation
- `paladin-key-registry.ts` ABI module — centralized export of `PALADIN_KEY_REGISTRY_ABI` for plugin + future indexer service
- `paladin-swap.ts` LLM extraction template — 5 fields (sellTokenSymbol, buyTokenSymbol, sellAmount, chainId, takerAddress); explicit DO-NOT-EXTRACT list for `onTrustBlock`/`acknowledgeRisks`/slippage/deadline
- `client.ts` extensions — `walletAddress` getter (handler step 4 INVALID_TAKER check); `paidEx(req, opts?)` with `{ data, settlementState, txHash? }` return for refund accounting; `TrustCheckPaidError` class carrying `settlementState`; backwards-compat: existing `paid(req)` signature unchanged
- `SettlementState` type (`'not-attempted' | 'attempted-confirmed' | 'attempted-unknown' | 'confirmed-failed'`)

**The 16-step handler (Step 18):**
- `actions/paladin-swap.ts` — composes everything above into the load-bearing orchestration:
  - Step 1-3: validate options + LLM extract + validate fields
  - Step 4: enforce taker === wallet.address
  - Step 5-6: TOKEN_REGISTRY membership + cap check (BigInt math)
  - Step 7-8: rate limit + spending caps
  - Step 9: paid trust-check with settlement-state-aware refund accounting (`not-attempted`/`confirmed-failed` → refund TOTAL; `attempted-unknown` → debit + warn-log, rate-limited ≤1/hr per (taker, sellToken, buyToken) tuple to prevent network-flake cap-burning attack)
  - Step 10: trust branch on (recommendation × effectiveMode); refund sim fee on TRUST_BLOCKED
  - Step 11-12: fetch quote with timeout; refund sim on QUOTE_FAILED/UPSTREAM_LIQUIDITY_NONE; Layer 2 validate (deny-list + router + selector + 0x Settler target)
  - Step 13: clientNonce + requestHash binding (closes replay attack)
  - Step 14: server simulation with settlement-state branching (503 → refund; non-2xx → debit + warn-log)
  - Step 15: getTrustState (multi-RPC quorum + HMAC'd cache)
  - Step 16: `verifyAndExtract` with retry-once on the 4 retryable errors (force-refresh trust state, retry verify with same requestHash + clientNonce; same simulate response not re-fetched)
  - Step 17: branch on response.ok → SIMULATION_REJECTED or success
- Process-wide `moduleHighestVersionRef` for downgrade prevention across calls
- Process-wide `attemptedUnknownRateLimit` Map (keyed on `taker|sellToken|buyToken` lowercase)
- `timeoutSignal(parent, ms)` per-step AbortSignal chaining
- Catch-all bottom: refund residual fees on unexpected throws (safety net for bugs in this file)

**Factory + tests + drift CI (Steps 19-21):**
- `index.ts` — extended factory with v0.2.0 options:
  - `paladinSwapEnabled` requires `walletClientAccount` (else `WALLET_MISSING`)
  - `paladinSwapEnabled` requires `acknowledgeRisks: true` (else `RESIDUAL_NOT_ACKNOWLEDGED`)
  - `simulationVerifier: 'tenderly'|'both'` requires `tenderlyConfig` with valid `accountChecksum`
  - `keyTrustMode: 'pinned'` requires `pinnedPair`
  - `clockOverride` set + `NODE_ENV=production` → throws (R11 Sec MED-1 supply-chain replay defense)
  - `.catch()`-wrapped pre-warm of `getTrustState` (R9 Eng HIGH-3 — never crashes agent on boot)
  - Wires PaladinTrustClient + RateLimiter + SpendingTracker + makePaladinSwapAction with all profile + per-knob overrides
  - Backwards-compat: v0.1.0 callers unaffected; `paladinSwapEnabled` defaults `false`
- `tests/paladin-swap.test.ts` — ~30 representative handler tests (vitest 2.x with mocked deps + FakeClock + tmp file paths)
- `tests/drift.test.ts` — pre-publish gate: TOKEN_REGISTRY shape + reproducible hash; CLIENT_SIDE_DENY_LIST has 7 selectors; ALLOWED_SELECTORS has 12 (1 0x + 11 Velora); deny+allow no overlap; canonical-JSON byte-equality; profile/registry drift; **no `Date.now()` outside `clock.ts`** (recursive grep with comment+string stripping); operator-distinctness; ALL_ERROR_CODES has 27

**On-chain Solidity contract (Steps 33-34, in `paladinfi/contracts` repo):**
- `PaladinKeyRegistry.sol` (Solidity 0.8.24) — non-upgradable contract holding current 2-of-2 trust pair + indexer attestation key + TOKEN_REGISTRY hash + revoked-epochs mapping. All state changes go through 7-day TIMELOCK + 24h FINALIZE_OWNER_WINDOW + 24h OVERWRITE_LOCKOUT.
- `revoke(epoch)` restricted to past epochs (`epoch < currentEpoch`) — anti-brick guard
- `finalizeRotation` checks `!revoked[pending.epoch]` — defensive revoke during pending window blocks finalize
- 11 indexed events + custom errors (gas-efficient)
- `readTrustState()` consolidated read for plugin's eth_call efficiency
- `transferOwnership` (single-step; the Safe is itself multi-sig so adds no extra hop)
- `script/Deploy.s.sol` — env-driven Forge deploy script with pre-flight asserts
- `test/PaladinKeyRegistry.t.sol` — ~25 Foundry tests (constructor + rotation + revoke + tokenRegistryHash + indexerKey + ownership)
- `deployments.json` — canonical alignment source (3 KMS key blocks: simulator_aws, simulator_gcp, indexer_attestation_aws)
- `audit-trail/` — append-only Markdown log discipline for on-chain operational events
- README + CODEOWNERS + .gitignore + foundry.toml

**Customer-facing docs (Steps 40-41):**
- README extended per v11 §8.1 ordering (value-prop first, threat-model summary last with link to THREAT_MODEL.md)
- THREAT_MODEL.md — full disclosure with 12 sections (defense layers, narrow residual, 2-of-2 vs 3-of-3, software-key custody, provider regions, multisig PaladinFi-controlled, 7-day timelock as customer's defense, account suspension, no email list, force-migration honesty, hourly outage, v0.3.0 traction gate commitments)
- CHANGELOG entry with MUST-READ flag for `paladinSwapEnabled` opt-in

**Server-side Step 31b (pieces 1-3) — alerting + dead-man-switches:**
- New module `trust_services/indexer/alerting.py` — multi-channel operator alerting (Twilio SMS + PagerDuty Events API v2 + structured log backstop). `Alert` dataclass with severity (P1/P2/P3) → channel routing (P1/P2 → Twilio + PagerDuty; P3 → PagerDuty silent paging only); `fire_alert` orchestrator with Twilio SMS dedup (default 600s window via `_recent_fires` cache to prevent SMS spam during sustained outages — PagerDuty has its own server-side dedup_key collapsing); `fire_resolve` for auto-resolve transitions when heartbeats recover. Twilio body capped at 320 chars (2 SMS segments) to avoid runaway billing. **Bug catch during test**: `fire_resolve` was short-circuiting when PagerDuty unconfigured and never clearing local Twilio dedup — fixed to always clear local cache (independent of whether PagerDuty resolve event was sent).
- New module `trust_services/indexer/liveness_monitor.py` — three pure check functions (`check_indexer_dead_man` >24h no events, `check_iam_updater_heartbeat` >5min stale, `check_decommissioner_heartbeat` >32d stale per RUNBOOK §3 cadence) returning `Alert | None`. `_fire_or_resolve` transition logic tracks `_active_alerts` set so condition-cleared sends auto-resolve to PagerDuty (incident closes without operator action). `run_one_iteration` runs all 3 checks + transitions in one pass; `liveness_monitor_loop` is the long-running coroutine indexer's lifespan schedules.
- `paladin_simulator_indexer.py` wiring: lifespan now spawns 4 background tasks (was 3 — added `liveness_monitor_loop`). `_get_liveness_state` provider reads last `signed_at` from `event_signing_queue` SQLite + heartbeat timestamps. `DECOMMISSIONER_HEARTBEAT_FILE` env-configurable.
- 21 alerting unit tests (`tests/test_indexer_alerting.py`) — payload shape (camelCase + cap), severity routing, dedup window, P3-skips-Twilio, resolve-clears-local-dedup. 17 liveness-monitor unit tests (`tests/test_indexer_liveness_monitor.py`) — three condition checks (no-data / fresh / stale), fire/resolve transitions (not-firing→firing / firing→not-firing / still-firing / no-op), full `run_one_iteration` orchestration including 3-simultaneous-fire and recovery-resolves.
- Full test suite: **362 passing, 6 skipped.**
- **Deferred to pieces 4-6** of Step 31b (vendor / branch-setup dependencies): Cloudflare Worker mTLS upload, GitHub Pages mirror, customer dashboard.

**Server-side Step 34 — x402 wiring on /v1/simulate:**
- New module `simulator/paladin_simulator_x402.py` — implements the resource-server side of the x402 protocol per https://x402.org. PaymentRequirements dataclass with camelCase wire serialization (scheme/network/maxAmountRequired/resource/description/mimeType/payTo/maxTimeoutSeconds/asset/extra), `build_402_response` per spec, `verify_x402_payment` + `settle_x402_payment` that POST to the configurable facilitator (default Coinbase's hosted instance per memory `x402_facilitator_rejected_2026-04-28.md`).
- Middleware `x402_verify_middleware` applies on /v1/simulate; bypass paths (`/health`, `/admin`, `/docs`, `/openapi.json`); short-circuits when `PALADIN_X402_ENABLED=false` (default off for local dev — keeps test fixtures simple); respects `request.state.x402_retry_bypass` flag for retryToken-based free retries.
- `settle_after_success` called by the handler AFTER simulation succeeds — settlement broadcasts the on-chain USDC transfer ($0.001/call, 1000 USDC base units) and returns the proof which the response writes to the X-PAYMENT-RESPONSE header (base64-encoded JSON per spec). Customer-friendly: if simulation FAILS, settle is NOT called (no charge for failed simulations).
- `/v1/simulate` handler updated: (1) checks for `retry_token` in body first → if HMAC-valid + SQLite-fresh, sets `x402_retry_bypass=True` and skips x402 entirely (per v11 §4.3 + R14 Eng MED-3 — TOKEN_REGISTRY_DRIFT retries are free); (2) runs x402_verify_middleware (returns 402 if X-PAYMENT missing or invalid); (3) processes simulation; (4) calls settle_after_success if simulation succeeded; (5) writes settle proof to X-PAYMENT-RESPONSE header.
- `SimulateRequest` Pydantic model extended with optional `retry_token: str | None = Field(alias="retryToken")` for the retry path.
- 26 unit tests (`tests/test_x402.py`) — PaymentRequirements camelCase serialization (3), 402 response shape (2), verify success/invalid/HTTP-error/network-error (4), settle success/failure (2), bypass path detection (4), middleware (x402-disabled / bypass-path / retry-bypass / missing-header / invalid-payment / valid-payment, 6), settle_after_success (skipped / not-verified / verified-calls-settle / settle-failure-logs-not-raises / no-payment-header, 5).
- Production deploy needs: `X402_FACILITATOR_VERIFY_URL` + `X402_FACILITATOR_SETTLE_URL` (default Coinbase), `PALADIN_TREASURY_ADDRESS` (USDC payTo), `PALADIN_X402_ENABLED=true`. Facilitator selection deferred to deploy ceremony per v0.3.0 traction-gate.
- Full test suite: **324 passing, 6 skipped.**

**Server-side Step 31 — paladin_simulator_indexer.py (core 31a):**

The big one — event-stream watcher + SQLite signing queue + KMS-sign-per-event + signed events.json publisher + heartbeat receiver, all wired into a FastAPI app with lifespan-managed background tasks. Splits cleanly per R15 Eng MED-3 phasing into 31a (this changeset, the core trust path) + 31b (alerting + dashboard + Cloudflare Worker mTLS upload + GitHub Pages mirror, deferred).

- `trust_services/indexer/queue_db.py` — SQLite-backed signing queue per v11 §4.12 R14 Eng LOW-6: schema with `UNIQUE (block_number, log_index)` for re-scan idempotency, `idx_unsigned` partial index, atomic sequence-number assignment via `MAX(sequence_number)+1` inside `BEGIN IMMEDIATE` transaction, checkpoint table with id=1 invariant + refuse-backward-move guard, `mark_event_signed` is idempotent via `WHERE signed_at IS NULL`. WAL journal mode + synchronous=NORMAL for single-writer-multi-reader concurrency. Restart-replay path: `WHERE signed_at IS NULL ORDER BY id ASC` durable across simulator-service restart, lifespan refresh, and trust-services VM reboot.
- `trust_services/indexer/merkle.py` — chained-hash construction (NOT balanced tree — events are inserted serially): `leaf_i = keccak256(canonical_json(event_i))`, `root_n = keccak256(root_{n-1} || leaf_n)`, base case `EMPTY_ROOT = b"\x00" * 32`. `event_signing_payload` produces canonical JCS-stable bytes the indexer's KMS Key #3 signs over (schema/sequence_number/event_data-hex/merkle_root-hex; alphabetically sorted keys). Verifiers can re-scan via own RPC quorum and recompute to detect retroactive insertions.
- `trust_services/indexer/signer.py` — single-key Key #3 signer (cross-account-isolated AWS-B). Reuses `derive_v_and_compact` + `_enforce_low_s` from the simulator's signer module (the cryptographic primitives are identical: DER → r,s,v + EIP-2 low-s + recover-and-compare). Difference is 1-of-1 vs 2-of-2: indexer uses ONE KMS key in AWS account B with cross-account `STS:AssumeRole` from the trust-services VM's instance role into `paladin-indexer-signer-role`. SIGHUP grace window inherited via `last_sighup_at` parameter.
- `trust_services/indexer/event_watcher.py` — polls Base via `eth_blockNumber` + `eth_getLogs`, decodes 9 PaladinKeyRegistry topics (RotationProposed/Finalized/Cancelled, Revoked, IndexerKeyChange{Proposed,Finalized}, TokenRegistryHashChange{Proposed,Finalized}, OwnershipTransferred), default 12-block confirmation depth + 1000-block scan range cap, `set_checkpoint` updated AFTER successful insert (defends against checkpoint-ahead-of-rows on RPC mid-fetch failure). `decode_log` returns None on unknown topic-0 (defensive against contract upgrades). Topic-0 hashes built via `keccak256(text=signature)`.
- `trust_services/indexer/signing_worker.py` — background loop reading unsigned events in sequence-number order, computes leaf + chains merkle root from `_get_prior_root(seq-1)`, signs `event_signing_payload` digest via KMS Key #3, atomic `mark_event_signed`. KMS failure bails the batch (don't hammer KMS during outage; next loop iteration retries). Configurable `batch_size`, `loop_interval`, `per_sign_delay`. Idempotent: re-signing already-signed events is no-op via the WHERE clause.
- `trust_services/indexer/events_publisher.py` — builds `paladin-events-v1` schema envelope (chain_id 8453, contract_address, indexer_attestation_address from current Key #3, snapshot_at, events array with sequence_number/event_type/block_number/log_index/tx_hash/payload/merkle_root/signature). Atomic tmp+rename file write. `publish_local` reads all signed events from DB and writes `/var/lib/paladin/events.json` (the source of truth; Cloudflare Worker mTLS upload + GitHub Pages mirror are 31b).
- `trust_services/paladin_simulator_indexer.py` — FastAPI service with lifespan handler that initializes schema, loads signer state from env, installs SIGHUP handler (drain-then-swap discipline), spawns three background tasks (watcher_loop + signing_worker_loop + events_publisher_loop). Endpoints: `POST /heartbeat` (iam-updater liveness tracking; 5-minute staleness threshold), `GET /health` (queue counts, attestation_address, heartbeat status, events.json path), `POST /admin/drain` (rotation-finalize handshake), `GET /events.json` (serves the published file). Heartbeat tracking via module-level timestamp, exposed in /health as `iam_updater_heartbeat: {status: ok|stale|missing, last_received_age_seconds, staleness_threshold}`.
- 55 unit tests across 5 new test files (`tests/test_indexer_queue_db.py` 10, `tests/test_indexer_merkle.py` 13, `tests/test_indexer_event_watcher.py` 11, `tests/test_indexer_signing_worker.py` 7, `tests/test_indexer_events_publisher.py` 5, `tests/test_indexer_app.py` 9). KMS calls mocked via `_fake_kms_sign` that uses a deterministic eth_keys test private key (produces real DER signatures that pass low-s + recover-and-compare). Coverage: schema idempotence, sequence-number assignment + monotonicity, UNIQUE constraint enforcement (re-scan idempotent), checkpoint forward-only, signing idempotence (re-sign no-op via WHERE), merkle chaining correctness across multiple events, KMS-failure bails batch with remaining events still queued, event-decoder topic table (9 events), scan_once happy path + idempotent rescan + max_range cap, /health reflects queue state + heartbeat freshness, /events.json served when published vs 404.

**Deferred to 31b** (per R15 Eng MED-3 phased ship): Twilio + PagerDuty multi-channel alerting on critical events, Cloudflare Worker mTLS upload, GitHub Pages mirror, customer-facing dashboard, dead-man-switch alerting (>24h no events).

**Full test suite: 298 passing, 6 skipped.**

**Server-side Step 29 + 33 — VM bootstrap, systemd, nginx:**
- 8 systemd unit files in `paladin-server/systemd/`: `paladin-anvil.service`, `paladin-simulator.service`, `paladin-indexer.service`, `paladin-iam-updater.service`, `paladin-decommissioner.service` + `.timer`, `paladin-decommissioner-heartbeat.service` + `.timer`, `paladin-snapshot-top-tokens.service` + `.timer`. All apply per-service Linux user separation + Sec MED-1 hardening directives (`ProtectSystem=strict`, `ProtectHome=true`, `PrivateTmp=true`, `NoNewPrivileges=true`, `RestrictNamespaces=true`, `RestrictRealtime=true`, `SystemCallFilter=@system-service`, `MemoryDenyWriteExecute=true`, `LockPersonality=true`, `ProtectKernelTunables=true`, `ProtectKernelModules=true`, `ProtectControlGroups=true`, `RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6`, explicit `ReadWritePaths=` allow-list per service, `LimitNOFILE` + `TasksMax` resource caps). Maint HIGH-1 ordering enforced via `Requires=` chain `paladin-indexer ← paladin-iam-updater ← paladin-decommissioner` plus `ExecStartPre` indexer-heartbeat check on iam-updater + R13 Eng HIGH-3 allowlist-mtime check on decommissioner.
- `nginx/paladin-simulator.conf` — TLS terminator + reverse proxy with tier-aware rate limits (free 2 r/s burst 5, paid 10 r/s burst 20 — both status 429), per-IP connection cap (slowloris defense), client_max_body_size 64k, /admin/ scoped to internal CIDR only (10.0.0.0/8 + 127.0.0.1, deny all else), HSTS + `Strict-Transport-Security` + X-Content-Type-Options nosniff + X-Frame-Options DENY + Referrer-Policy no-referrer + Cache-Control no-store, default-deny on unknown paths.
- `systemd/install.sh` — idempotent root bootstrap script: creates per-service Linux users (paladin-simulator, paladin-indexer, paladin-iam-updater, paladin-decommissioner, paladin-monitoring), creates `/opt/paladin/`, `/etc/paladin/`, `/var/lib/paladin/`, `/var/log/paladin/`, `/var/run/paladin/` with correct ownership + mode, sets ACL on `/etc/paladin/iam-allowlist.json` (paladin-iam-updater write, paladin-decommissioner read via `setfacl` not group membership — keeps IAM principals isolated), installs all .service + .timer units to `/etc/systemd/system/`, daemon-reload, enables timers (operator starts services manually after env files + venvs are in place).
- 2 helper bash scripts: `check_indexer_heartbeat.sh` (ExecStartPre for iam-updater — verifies indexer /health responsive within 5s, fail-closed if not), `check_decommissioner_liveness.sh` (P3 PagerDuty alert if decommissioner heartbeat stale >32d, with dedup_key `paladin-decommissioner-heartbeat`).
- `systemd/README.md` — operator reference: dependency ordering, hardening directive list, filesystem ACL pattern, bootstrap procedure, cron cadence (03:30 snapshot / 06:00 decommissioner / 07:00 heartbeat), cross-references to RUNBOOK §4, §5, §11.

**Server-side Step 28 sibling — decommission_old_key.py:**
- New script `trust_services/scripts/decommission_old_key.py` — daily-cron `kms:ScheduleKeyDeletion` for /v1/simulate keys retired beyond the standoff window. Defense-in-depth properties: (1) **allowlist-mtime check** refuses to start if `/etc/paladin/iam-allowlist.json` is older than 24h (R13 Eng HIGH-3); (2) **on-chain re-verification** before each delete, re-fetches `RotationFinalized` events via own multi-RPC quorum, fail-closes if the address being deleted matches the latest epoch's pair (still active, refuse delete); (3) **address→ARN correlation** via `deployments.json` (CURRENT) + `historical_arns.json` (rotated-out keys) — fail-closed if no correlation found; (4) **rate-limited deletes** (`--max-deletes 1` default — only delete one key per run); (5) **heartbeat write** `/var/run/paladin/decommissioner.last_run` on every successful run.
- KMS pending window: 30 days (max). Total time from rotation finalize → key material erased = 30d standoff + 30d KMS pending = 60d.
- `find_arn_for_address` accepts `deployments_dir` parameter so tests don't need to mutate module-level state to control history file path.
- 20 unit tests (`tests/test_decommission_old_key.py`) — allowlist freshness gate (fresh passes / missing fails / stale fails), heartbeat write creates parent dir, ARN correlation (current match, lowercase compare, unknown returns None, history file lookup), find_deletion_candidates (recent excluded, old-with-arn included, old-without-arn excluded), reverify_address_decommissioned (not-in-latest=safe / in-latest=unsafe / no-events=unsafe), full run() orchestration (dry-run no kms call, active address skipped, stale allowlist raises, missing contract address raises), CLI exit codes.

**Server-side Step 32 — rotate_indexer_attestation_key.py (AWS-B Key #3):**
- New script `trust_services/scripts/rotate_indexer_attestation_key.py` — operator helper for the quarterly Key #3 (AWS account B, indexer attestation) rotation per RUNBOOK §5d. Two-phase orchestration mirroring `rotate_key.py` but for the cross-account-isolated attestation key. Phase A: create new ECC_SECG_P256K1 key in AWS-B (Origin=AWS_KMS so operator never holds material), derive Ethereum address via `derive_address_from_uncompressed_pubkey`, output proposal payload for `proposeIndexerKeyChange()`. Phase B: drain indexer signing queue → atomic env-file swap (PALADIN_INDEXER_KEY_ARN_PRIOR ← CURRENT, CURRENT ← new) → SIGHUP → poll /health for `attestation_address == new_addr`. Pure helper `update_indexer_env_with_rotation` is module-importable + unit-testable.
- 7 unit tests (`tests/test_rotate_indexer_attestation_key.py`) — env-promotion semantics, finalize happy path, drain-failure-doesnt-touch-env, missing-pid-file raises, CLI exit codes.

**Server-side Step 30 — paladin_iam_updater.py:**
- New service `trust_services/paladin_iam_updater.py` — webhook-receiver for Tenderly Alerts on `RotationFinalized` events; treats webhook as advisory hint per R14 Sec MED-3, then re-fetches events from Base via OWN multi-RPC quorum (≥2 distinct operators per `shared/known_rpc_operators.py`); validates webhook claim against on-chain quorum truth; updates allowlist file (`/etc/paladin/iam-allowlist.json`) atomically. Decommissioner reads the allowlist but cannot write it (filesystem ACL per Sec MED-1). HMAC-protected webhook secret rotated quarterly per RUNBOOK §5e. Heartbeat to indexer every 60s — stale heartbeat triggers P3 page. FastAPI lifespan handler manages secret loading + heartbeat task lifecycle.
- `fetch_rotation_finalized_via_quorum` — concurrently fetches `eth_getLogs` from each RPC, takes only events present in ALL responding RPCs (intersection by `(block_number, log_index)`); logs WARNING on per-RPC discrepancies (strong signal of compromise or chain disagreement); requires 12-block confirmations.
- Decoder `_decode_rotation_finalized` parses `RotationFinalized(uint256 epoch, address awsAddr, address gcpAddr)` topics; topic-0 derived via `eth_utils.keccak` (NOT `hashlib.sha3_256` which is the published SHA-3 with different padding from Ethereum's Keccak — comment-flagged in source).
- `merge_event_into_allowlist` — pure idempotent function; re-applying the same event is a no-op (matched by `(block_number, log_index)`).
- 20 unit tests (`tests/test_iam_updater.py`) — HMAC verification (valid / mismatched / sha256= prefix / missing / wrong secret), log decoding (basic + insufficient topics), multi-RPC quorum (two-RPCs-agree returns intersection, one-RPC-missing returns empty, distinct-operators required, single-RPC fail-closed), allowlist file (load missing/corrupt returns empty, write round-trip, merge idempotent), `/webhook` end-to-end (invalid HMAC 401, malformed JSON 400, quorum failure 503, no-onchain-match 409, happy path writes allowlist file).

**Server-side Step 28 — rotate_key.py (operator helper for /v1/simulate Key #1/#2):**
- New script `simulator/scripts/rotate_key.py` — two-phase orchestration helper for RUNBOOK §5a staggered 30-day rotation. Phase A (propose): STS:AssumeRole → AWS or GCP KMS create + GetPublicKey + derive Ethereum address (Origin=AWS_KMS or GCP SOFTWARE protection — operator never holds private key material), emit proposal payload for Safe UI. Phase B (finalize): POST /admin/drain on simulator → poll /health for `inFlight==0` → atomic env-file swap (`KEY_ARN_*_PRIOR ← KEY_ARN_*_CURRENT`, `KEY_ARN_*_CURRENT ← new`) → SIGHUP simulator → poll /health for `signer.{aws|gcp}Current == new_addr`. Drain-then-swap discipline preserves correctness in the SIGHUP grace window (R14 Eng MED-2). Pure helpers `update_env_with_rotation` (current → prior promotion) + `_read_env_file` / `_write_env_file_atomic` (shell-quote-aware) are module-importable + unit-testable.
- Address derivation: `derive_address_from_uncompressed_pubkey` accepts either 64-byte raw XY or 65-byte 0x04||X||Y SPKI-extracted form; `_extract_pubkey_from_spki` strips ASN.1 wrapper from KMS GetPublicKey output.
- 27 unit tests (`tests/test_rotate_key.py`) — address derivation matches `eth_keys` ground truth, SPKI extraction, KeySlot lookup, env promotion semantics (incl. bootstrap case), env file IO (read+quoted+comments+write+special-char-quoting+missing-parent-dir-create), finalize orchestration (happy path, drain-failure-doesnt-touch-env, health-verification-failure-propagates, env file IS updated even if /health verification fails so operator can restart manually), SIGHUP missing-pid raises, Windows fallback raises, CLI exit codes.

**Server-side Step 27 — snapshot_top_tokens.py:**
- New script `simulator/scripts/snapshot_top_tokens.py` — periodic refresh (cron-driven, daily) of the top-N TVL Base tokens for multi-token state-diff coverage extension beyond TOKEN_REGISTRY. Uses DefiLlama public API (no key); on API error or empty result falls back to TOKEN_REGISTRY-only snapshot so simulator state-diff coverage never shrinks below registry baseline. Atomic write via tmp+rename. Schema-versioned (currently v1) so future format changes don't silently break readers.
- `_extract_base_tokens_from_protocols` — filters DefiLlama's chainTvls map for Base, sorts by TVL desc, dedupes addresses, strips `base:` prefix, skips zero-address + malformed entries, lowercases.
- 23 unit tests (`tests/test_snapshot_top_tokens.py`) — Base-chain filter, TVL desc sort, chain-prefix stripping (accept `base:` reject `ethereum:`), zero-address skip, malformed-address skip, dedup (higher TVL wins), top-N cap, lowercasing; fallback uses registry, includes decimals, alphabetical-stable rank; build_snapshot live-source vs API-error vs empty-result; persistence round-trip + missing/bad/wrong-schema returns None; CLI exit codes (0 success / 1 filesystem error / 2 invalid args / `--print-only` doesn't write).

**Server-side Step 26 — verify_storage_slots.py + Upgraded() listener:**
- New script `simulator/scripts/verify_storage_slots.py` — pre-deploy + simulator-startup safety check that the ERC-20 storage layouts in TOKEN_REGISTRY match what's actually live on Base mainnet. For each token: (1) sweep `WELL_KNOWN_BASE_HOLDERS` (Coinbase HW1, Coinbase HW2, Binance HW, 1inch v5 router, Kyber metaaggr) to find a non-zero `balanceOf` reference; (2) `eth_getStorageAt(token, balance_storage_slot(holder, slot))` and assert it equals `balanceOf(holder)`; (3) read ERC-1967 implementation slot for proxy-upgrade tracking. Defends against the silent-misconfiguration failure mode where TOKEN_REGISTRY's `balance_slot` is wrong → `anvil_setStorageAt` writes to a dead slot → `balanceOf()` returns 0 → swap reverts → customer sees "transaction reverted" when truth is operator config bug.
- Implementation-drift detection: writes JSON snapshot at `/var/lib/paladin/proxy_implementations.json` (atomic tmp+rename); on subsequent runs compares current ERC-1967 implementation address to saved one and reports drift (returns exit 2). Catches FiatTokenV2_2 and similar upgradable tokens silently swapping implementations.
- Hardcoded constants verified by tests: `ERC1967_IMPLEMENTATION_SLOT = bytes32(uint256(keccak256("eip1967.proxy.implementation")) - 1)` and `UPGRADED_TOPIC = keccak256("Upgraded(address)")`.
- Exit codes: 0 = all pass, 1 = any slot mismatch (don't deploy), 2 = implementation drift (review before deploy), 3 = config / RPC error.
- CLI flags: `--rpc`, `--token` (single-symbol), `--json` (machine output), `--strict` (fail when no whale has non-zero balance), `--snapshot PATH`, `--no-snapshot`.
- 19 unit tests (`tests/test_verify_storage_slots.py`) — happy path verification, slot mismatch detection, no-whale skipped vs strict-fail, drift detection (no snapshot, no change, change, lowercase-tolerant compare, corrupt snapshot doesn't raise), atomic snapshot write (no `.tmp` leftover), `main()` exit codes (0/1/2/3), JSON output, ERC-1967 + Upgraded topic constants verified against `keccak256` of canonical strings.
- Full test suite: **146 passing, 4 skipped**.

**Server-side Step 22 — Anvil RPC sequence (full integration):**
- New module `simulator/paladin_simulator_anvil.py` — async JSON-RPC client + storage-slot helpers + ERC-20 calldata encoding. Helpers: `balance_storage_slot(holder, slot)` (computes `keccak256(abi.encode(holder, slot))` for Solidity `mapping(address => uint256)`), `allowance_storage_slot(holder, spender, slot)` (two-step keccak for nested mapping), `encode_uint256(value)` (32-byte big-endian hex with overflow guard), `encode_balance_of_calldata(holder)` (selector `0x70a08231` + abi-encoded address), `fetch_token_balance` (eth_call balanceOf), `fetch_bulk_balances` (concurrent gather across token set). Constants: `MAX_UINT256`, `DEFAULT_ETH_FOR_GAS_WEI = 1 ETH`, `DEFAULT_GAS_LIMIT = 3M`, `PERMIT2_BASE = 0x000000000022D473030F116dDEE9F6B43aC78BA3`. `AnvilClient` async wrapper exposes `eth_getBalance`, `eth_call`, `eth_sendTransaction`, `eth_getTransactionReceipt`, `evm_snapshot`, `evm_revert`, `anvil_setBalance`, `anvil_setStorageAt`, `anvil_impersonateAccount`, `anvil_stopImpersonatingAccount`, `anvil_reset` — pluggable via injected httpx.AsyncClient for unit tests.
- `_run_simulation` in `paladin_simulator_service.py` filled with full RPC sequence: `evm_snapshot` → `anvil_setBalance` (DEFAULT_ETH_FOR_GAS_WEI + value_wei) → `anvil_setStorageAt` (balance slot, sell_amount) → `anvil_setStorageAt` (allowance slot, MAX_UINT256) → capture pre-state (eth_getBalance + bulk balanceOf across multi-token set) → `anvil_impersonateAccount` → `eth_sendTransaction` → `eth_getTransactionReceipt` → capture post-state → return SimulationResult. Always-revert in `finally` block guarantees the next call sees a clean fork even on unexpected exceptions; `_anvil_reset` is now wired through AnvilClient.
- `_build_state_diff_token_set` — produces sorted, deduplicated address list = `{sell_token, buy_token} ∪ TOKEN_REGISTRY` covering top-N TVL multi-token state-diff per v8 §4.11.2.
- `_failure_result` — builds a SimulationResult representing tx-revert / no-receipt / send-failed, with `balances after = balances before` and `revert_reason` set; balance fields converted to JCS-safe strings (`str(int)`).
- 20 new unit tests (`tests/test_anvil.py` 20) covering storage-slot computation against Solidity convention (zero-address, known-holder, lowercased holder, slot-number sensitivity, allowance two-step computation, holder/spender swap), uint256 encoding with overflow/underflow rejection, balanceOf calldata format, balanceOf selector matches `keccak256("balanceOf(address)")[:4]`, AnvilClient JSON-RPC dispatch (get_balance hex decode, set_balance hex encode, snapshot/revert pair, AnvilError propagation). Plus 3 integration tests gated on `PALADIN_TEST_ANVIL_URL` env var (`anvil --fork-url BASE_RPC` running locally).
- 17 new unit tests (`tests/test_run_simulation.py`) with fully-mocked AnvilClient covering: state-diff token set (includes sell+buy+all registry, lowercases input, off-registry buy_token still added, sorted output), happy path (snapshot/revert called, taker funded with default+value, balance storage set with sell_amount, send_transaction uses calldata + DEFAULT_GAS_LIMIT, impersonate/stop_impersonate symmetry), failure paths (receipt status=0x0, AnvilError on send, no-receipt, unexpected exception, invalid sell_token, non-int sell_amount, non-int value_wei) — all verify always-revert holds.
- Full test suite: **127 passing, 4 skipped** (3 live-Anvil gated + 1 cross-language JCS fixtures).

**Server-side scaffolding (Step 22 — partial; Anvil RPC sequence stubbed):**
- `simulator/paladin_simulator_service.py` — FastAPI service with lifespan handler, sentinel pid file, single-worker enforcement (GUNICORN_WORKERS check + sentinel-pid-via-os.kill liveness probe per R11 Eng MED-5), drain-then-refresh fork loop (random ±15min jitter, 30s drain deadline), refresh-generation token + stale-fail-fast in /v1/simulate handler (per R11 Eng MED-3), consecutive-skip cap with P1-equivalent error log (per v9), always-revert simulation discipline, `/v1/simulate` endpoint with full canonical-JSON + 2-of-2 sign pipeline, `/health` endpoint exposing in-flight + refresh-pending + signer addresses, `/admin/drain` + `/admin/gc` operator-control endpoints, SIGHUP signal handler that re-reads KEY_ARN_*_CURRENT + KEY_ARN_*_PRIOR (drain-before-swap discipline per RUNBOOK §5a), retryToken HMAC + SQLite store (R14 Eng MED-3 — server_secret in AWS Secrets Manager in prod, dev fallback for local tests, 60s TTL, 32-hex-char HMAC = 128 bits)
- The actual Anvil RPC sequence (anvil_setBalance + anvil_setStorageAt + evm_snapshot + transaction execution + state-diff capture + evm_revert) is stubbed with a synthetic SimulationResult so the signer + canonical-JSON pipeline is exercisable end-to-end in tests; full Anvil integration deferred to next session
- 13 unit tests (`tests/test_service.py`) covering retryToken roundtrip + tampering + expiration + GC + HMAC determinism + secret/hash/expires-at sensitivity, /v1/simulate response envelope shape, /v1/simulate unsupported-token 400, /health endpoint shape — all pass

**Server-side foundation (Steps 23-25 — partial of 22-32):**
- New sibling repo `paladin-server/` (Python 3.11+; pyproject.toml; mirrors production install paths `/opt/paladin/{simulator,trust-services}/`)
- Step 23: `simulator/paladin_simulator_canonical.py` — RFC 8785 JCS canonicalizer (uses PyPI `jcs` package; v11 plan referred to it as `pyjcs` but the actual distribution is named `jcs` — pin updated to `jcs>=0.2,<1.0`); PaladinFi-specific JCS-safety guards (no NaN/Infinity/undefined; reject non-string dict keys; reject ints outside JS safe range to prevent silent precision loss when consumed by TS); `assert_canonicalizable` with path-tracked error messages; cross-language fixture harness pre-wired (skipped until 50 fixtures committed pre-Step 22 sign-off)
- Step 24: `simulator/paladin_simulator_signer.py` — 2-of-2 KMS signer (boto3 + google-cloud-kms); DER → (r,s,v) compact via `cryptography.hazmat.primitives.asymmetric.utils.decode_dss_signature`; EIP-2 low-s normalization (SECP256K1_N + SECP256K1_HALF_N); v=27/28 derivation by recover-and-compare against expected addresses; PRIOR_EPOCH grace window (30s post-SIGHUP) with info-log inside grace + warning-log outside; `KeyRecoveryMismatchError` fail-closed when neither current nor prior matches; `init_signer_state(...)` for lifespan-startup + SIGHUP reload (drain-then-swap discipline per RUNBOOK §5a); `sign_payload(canonical_payload)` runs both KMS calls concurrently via asyncio.gather
- Step 25: `simulator/paladin_simulator_token_registry.py` — server-side mirror of plugin's `src/utils/sell-caps.ts`; `_compute_registry_hash` produces byte-identical output to TS counterpart (sorted-key pipe-delimited keccak256 over UTF-8 bytes); `TokenRegistryEntry` frozen dataclass; `assert_storage_slots_verified` placeholder until Step 26 fork-test script is wired
- `shared/known_rpc_operators.py` — single source of truth for Base RPC operator host→slug mapping per R14 Sec MED-3; `get_operator_strict` fail-closed (server-side stricter than plugin's TS warn-only); `assert_quorum_distinct` defends against silent same-operator collisions across multiple URLs
- 77 unit tests (`tests/test_token_registry.py` 18, `tests/test_canonical.py` 25 + 1 skipped, `tests/test_known_rpc_operators.py` 14, `tests/test_signer.py` 19) — all pass on Python 3.14.3 + pinned deps (`jcs`, `eth-utils`, `eth-keys`, `cryptography`, `eth-hash[pycryptodome]`)
- **Bug catch during Step 25 cross-validation:** USDbC's checksummed address in `src/utils/sell-caps.ts` was `0xd9AAEc86B65D86f6A7B5B1b0c42FFA531710b6CA` — invalid EIP-55 (third nibble should be lowercase `a`, not uppercase `A`). Fixed both TS and Python to `0xd9aAEc86B65D86f6A7B5B1b0c42FFA531710b6CA`. `TOKEN_REGISTRY_HASH` unchanged because hash uses lowercased addresses. Defense: `tests/test_token_registry.py::test_entry_addresses_checksummed` uses `eth_utils.is_checksum_address` against every entry; this kind of typo is now caught pre-publish on both sides.

**Operational docs (Step 39):**
- RUNBOOK.md — operator-facing playbook (NOT customer-facing): hosts/KMS/IAM/secrets quick reference, pre-deploy checklist, daily/weekly/monthly/quarterly cadence, alert→action map, rotation ceremonies (§5a /v1/simulate staggered 30d, §5b dual-pending cancel, §5c Cloudflare PAT, §5d indexer attestation Key #3 quarterly with SIGHUP-then-verify, §5e webhook HMAC quarterly with <60s overlap, §5f vendor credential inventory + month-end >2× MoM fraud-trigger reconciliation, §5g bus-factor=1 + sealed-envelope recovery), §6 multisig + Shamir 3-of-5 signer rotation, §7 indexer dead-man-switch + decommissioner heartbeat + iam-updater heartbeat, §8 multi-cloud triage (per-account suspension scenarios), §9 RPO/RTO + VM-loss recovery + STS backoff schedule, §10 emergency procedures (key compromise, signed-message-leak, panic stop), §11 customer-comms with 3-adversary review checklist, §12 doc-update discipline, §13 reference (file paths, systemd units, hardening directives, audit-trail naming)
- RUNBOOK_templates/ directory — 8 customer-comms templates (routine-rotation-complete, cloud-account-suspension, emergency-revoke, emergency-fail-close, indexer-outage, transparency-paused-compromise, multisig-signer-rotation-emergency, t-plus-7d-handoff) with severity, channel, role-mix, and placeholder substitution discipline per Sec MED-2 channel honesty + R12 Maint M-4 monitor-responses follow-up

### Breaking changes from v0.1.0

**None.** v0.2.0 is a semver MINOR bump. The `paladin_trust_check` action is unchanged. The `paladin_swap` action is opt-in via `paladinSwapEnabled: true`.

### Verified

- `~30 paladin-swap.test.ts unit tests` covering each step's primary success + failure path, all 4 retryable verification errors, settlement-state branches (Step 9 + 14), refund accounting at every step that consumes fees, TOKEN_REGISTRY_HASH drift detection
- `~10 drift.test.ts pre-publish gates` (offline portions; live portions gated on `LIVE_DRIFT_CHECK=1` + Base RPC + deployed contract)
- `~25 PaladinKeyRegistry.t.sol Foundry tests` (timelock enforcement + 24h owner-only window + 24h overwrite lockout + revoked-pending check + revoke-past-only + zero-address rejections)
- `tsc --noEmit` — clean (with `proper-lockfile`, `@truestamp/canonify`, `viem` installed)
- `forge test` — clean (with `forge install foundry-rs/forge-std --no-commit`)

### Known limitations

- **Cold-start latency** ~1.5–2.5s on first call before pre-warm completes; subsequent calls ~750-900ms warm
- **Base RPC dependency** for trust-state reads (≥2 distinct operators required; default pool satisfies)
- **2-hour stale-grace window** for trust state during Base RPC outage; sticky-revoked overrides
- **7-day rotation timelock** is the customer's primary defense against PaladinFi insider compromise (NOT the multisig threshold, which is single-person at v0.2.0 — see THREAT_MODEL.md §6-7)
- **Multisig owner all-PaladinFi-controlled in v0.2.0**; independent third-party signer at v0.3.0 traction gate
- **2-of-2 KMS pair at v0.2.0** (AWS Key #1 + GCP Key #2 for /v1/simulate signing); 3-of-3 + Azure at v0.3.0 traction gate
- **Software-key custody** (FIPS 140-2 L1; provider-managed); HSM-backed (L3) at v0.3.0 traction gate
- **3-cloud KMS administered by 1 person** at v0.2.0; multi-admin separation-of-duties at v0.3.0+
- **Single EC2 simulator** (4-hour RTO target); multi-region in v0.3.0+
- **Cloud-provider account suspension at any of 3 KMS providers** triggers 7-10 day fail-closed window for auto-rotate customers; pinned mode + Tenderly fallback continue working
- **No customer email list at v0.2.0**; updates publish to GitHub Discussions, signed public events feed, @paladin_fi on X
- **Tenderly SPKI rotation (~2-3 years)** triggers temporary fail-closed window for `simulationVerifier: 'tenderly'` users until npm patch ships (~1h target)
- **Hourly 12s outage window from Anvil drain-then-refresh** — expected 99.7% upper-bound uptime
- **No force-migration lever for stale v0.2.0 plugins post-v0.3.0 release** — customers running stale v0.2.0 plugins are exposed to whatever vulnerabilities are discovered post-v0.3.0; we strongly recommend tracking npm releases and updating within 90 days of v0.3.0 ship (see THREAT_MODEL.md §10)

### Pre-publish review

Pre-publish 3-adversary review on the implementation (Engineering + Security + Maintainer) — pending before npm publish per `feedback_no_deploy_without_adversarial_review.md`.

Plan-level review converged at R15 with all 3 reviewers returning APPROVE-WITH-MINOR-FIXES (0 HIGH from each). Implementation review (R22 in v11 sequencing) runs on actual code post-deploy.

---

## [0.1.0] - 2026-05-04

First functional release. Closes the v0.0.x scope gap (LLM extraction + paid x402 settlement). Tracking issue [#1](https://github.com/paladinfi/eliza-plugin-trust/issues/1).

Audit trail: plan v1 REJECTED at adversarial review (wallet-drain CRITICAL) → plan v2 REJECTED (deprecated x402 lib version) → plan v3 informed by 30-min `@x402/fetch@2.11.0` empirical spike → plan v3 APPROVED-WITH-MINOR-FIXES (3-of-3 reviewers convergent) → plan v3.1 incorporates polish → implementation. Memory: `eliza_outbound_2026-05-02.md` Lesson 6, `feedback_no_deploy_without_adversarial_review.md`, `feedback_self_audit_before_review_2026-04-30.md`.

### Added

- **Paid x402 settlement** in `PaladinTrustClient.paid()` via `@x402/fetch@2.11.0` + `@x402/evm@2.11.0` + `@x402/core@2.11.0` (all pinned exact, not caret).
- **`onBeforePaymentCreation` pre-sign hook** in the x402 client that runs `validatePaladinContext()` against the actual fields the library is about to sign over. Aborts client-side via `{ abort: true, reason }` BEFORE any viem signing if any field deviates from hard-coded constants.
- **`validatePaladinContext`** in `src/x402/validate.ts` — 6 deterministic checks closing wallet-drain, Permit2 downgrade, x402 v1 downgrade, long-lived-signature (1-yr), EIP-712 domain spoof, scheme/network/asset/payTo/amount equality. Pure function, exported, unit-tested.
- **`createPaladinTrustPlugin({ walletClientAccount, apiBase?, defaultChainId?, mode? })` factory** with TRUE boot-time validation: throws synchronously if (a) paid mode requested without walletClientAccount, (b) walletClientAccount lacks `signTypedData` (rejects JsonRpcAccount/SmartAccount), (c) paid mode + non-HTTPS apiBase. Fails at agent startup, not at first message.
- **LLM prompt-template extraction** for `paladin_trust_check` via `composePromptFromState` + `runtime.useModel(ModelType.TEXT_SMALL)` + `parseKeyValueXml` — same pattern as `@elizaos/plugin-evm/transfer.ts`. Programmatic `options.address` bypass preserved.
- **Validator wallet-readiness gate** — `validate()` returns `false` in paid mode if no walletClientAccount, so the agent doesn't surface the action when it can't deliver.
- **`scrubViemError(e: unknown): string`** in `src/errors.ts` — bounded error summary that never propagates `error.cause`/`error.details` (would leak request init / signed payload via viem's debug chain). Used at every paid-path error site.
- **`tests/x402-validate.test.ts`** (17 assertions: happy path + protocol downgrades + Permit2 + scheme/network/asset/payTo/amount + validity bounds + EIP-712 domain spoofs + boundary cases).
- **`tests/boot-validation.test.ts`** (7 assertions: preview default, paid+wallet, paid-without-wallet throw, signTypedData missing throw, mode inference, non-HTTPS-paid throw, non-HTTPS-preview allowed).
- **vitest** added as devDep + `test` / `test:watch` scripts in package.json. Tests live at project root `tests/` (excluded from tsconfig + tarball).
- **`x402` constants module** (`src/x402/constants.ts`): `PALADIN_TREASURY`, `BASE_USDC`, `BASE_NETWORK`, `MAX_TRUST_CHECK_AMOUNT` (10_000n / $0.01 cap), `X402_VERSION` (2), `USDC_DOMAIN_NAME`/`VERSION`, `MAX_VALIDITY_SECONDS` (600), `PALADIN_API_DEFAULT`. Re-exported from package root.
- **README expanded** to 4 named subsections (Why this vs. other agent-trust plugins / Quick start preview mode / Paid mode wiring / Migration from v0.0.x). Plus pre-sign safety section, library trust + Eliza alpha drift in disclosures.

### Changed

- **`@elizaos/core` peerDep pinned exact `2.0.0-alpha.77`** (was `^2.0.0-alpha.77`). The alpha line drifts between releases; explicit pin protects integration.
- **Paid mode env-only path now degrades to preview with one-time warn** (instead of throwing) when `PALADIN_TRUST_MODE=paid` is set but no walletClientAccount was passed via the factory. Backwards-compatible with v0.0.x users who set the env var without the factory wiring.
- **`PALADIN_TRUST_ALLOW_INSECURE` documented as preview-mode-only.** Paid mode is HTTPS-only regardless of the override.

### Verified

- `tsc --noEmit -p tsconfig.json` — clean
- `npm run build` — clean dist
- `npm run test` — `tests/x402-validate.test.ts` (17/17) + `tests/boot-validation.test.ts` (7/7) pass
- 30-min `@x402/fetch@2.11.0` spike against live `https://swap.paladinfi.com/v1/trust-check` (2026-05-03) verified the API surface, hook context shape, and 402 challenge fields byte-for-byte
- **Manual paid smoke test against live `/v1/trust-check` from permanent test wallet `0x18779E54787320aE9Ab997F2ba3fC6E31D2A0aC1`**: pre-sign hook fired exactly once with PaladinFi's challenge, all 6 `validatePaladinContext` checks passed, EIP-3009 signed via viem, $0.001 USDC settled to PaladinFi treasury `0xeA8C33d018760D034384e92D1B2a7cf0338834b4`. Settled tx: [`0x6c083d0b35e67a9884d4defec92322913276062940bb2559bf57e9193584fc45`](https://basescan.org/tx/0x6c083d0b35e67a9884d4defec92322913276062940bb2559bf57e9193584fc45). Response: `recommendation: allow`, 5 real factors (ofac/paladin.anomaly/goplus/etherscan_source x2). Both `smoke-paid.mjs` (direct x402 stack) and `smoke-paid-via-client.mjs` (PaladinTrustClient.paid() public API) pass.
- Pre-publish 3-adversary review on the implementation (Engineering + Security + Maintainer) — pending before npm publish per `feedback_no_deploy_without_adversarial_review.md`
- **Launch tweet posted 2026-05-04**: https://x.com/paladin_fi/status/2050842251664744764 (manual paste — X API write endpoint had a propagation delay on initial dev-account setup; OAuth 1.0a User Context confirmed working same evening; future posts go via `social-tools/post-tweet-api.mjs`)
- **Customer traction note (corrected 2026-05-04 evening)**: 90 unique external IPs on `/mcp` over 14 days (top customer `5.78.149.157` Hetzner DE, 551 reqs/7d). **Zero confirmed external paid customers on `/v1/trust-check` or `/v1/quote-paid`** — earlier claim of "first external paid customer 2026-04-26" was retracted after IP de-anonymization showed it was our own EC2 internal service-hardening smoke (172.31.1.212), not an external request. Methodology fix: usage aggregator updated to flag internal RFC1918 IPs distinctly.

### Schema fixes empirically caught during smoke (2026-05-04)

- **`request_id` is now optional** on `trustCheckResponseSchema` (was required). Live paid `/v1/trust-check` responses do NOT include `request_id` (preview responses do); previous required schema rejected all paid responses with "schema validation failed."
- **`real` on `trustFactorSchema` defaults to `true`** (was required). Paid responses don't include `real` per factor (it's implicit `true`); preview responses include `real: false` explicitly. Default keeps the action-handler's `f.real ? "" : " (sample)"` rendering correct in both modes.
- Both bugs would have caused 100% paid-mode failure in production. Caught by manual smoke against live API; included in v0.1.0 release.

### Pre-publish 3-adversary review fixes (2026-05-04)

Engineering + Security + Maintainer reviewers all returned APPROVE-WITH-MINOR-FIXES. No HIGH/CRITICAL findings; no REJECT verdicts. All MED-sev findings applied:

**Architectural refactor (Engineering H1):**

- Replaced runtime symbol-slot decoration (`FACTORY_DEFAULTS_KEY`) with action-factory closure (`makeTrustCheckAction(factoryDefaults?)`). Previous approach had a load-order race when both the default `paladinTrustPlugin` and `createPaladinTrustPlugin({ walletClientAccount })` were registered on the same runtime — first action to fire would freeze the slot, silently downgrading the second plugin's mode. New approach: each plugin instance carries its own factoryDefaults via closure; no runtime mutation. `FACTORY_DEFAULTS_KEY` removed from public API; `decorateRuntime` deleted.
- New public export: `makeTrustCheckAction(factoryDefaults?)` — exposes the same closure pattern for callers who want a custom Plugin shell around the bound action.

**Defense-in-depth (Security M1, M2):**

- `PaladinTrustClient` constructor now also enforces HTTPS in paid mode (mirrors the factory's boot-time check). Direct `new PaladinTrustClient({ mode: "paid", apiBase: "http://..." })` now throws.
- `registerExactEvmScheme` is called with an explicit `policies: [(_v, reqs) => reqs.filter(r => r.network === BASE_NETWORK)]` filter. The `networks: [BASE_NETWORK]` argument scopes v2 only — v1 EIP-3009 schemes are auto-registered for all 21 EVM networks regardless. The policy filter ensures no v1 path can sign for a non-Base network, even if the pre-sign hook is regressed in a future change.

**Operational quality (Engineering H2):**

- Hook-abort errors are now surfaced verbatim with a distinct `paladin-trust BLOCKED pre-sign:` prefix so operators can grep / alert on them. Previously the `reason` string from `{ abort: true, reason: ... }` was lost in `scrubViemError`.

**LLM extraction hardening (Engineering M3, M5):**

- `parseKeyValueXml` output is now validated against a Zod schema (`z.object({ address: z.string().optional(), chainId: z.union([z.string(), z.number()]).optional(), taker: z.string().optional() })`) before use. A misbehaving LLM emitting nested tags or non-string values returns `{}` instead of crashing the handler.
- `pickRequest` now THROWS on a malformed `taker` (was silently dropped). The user might be relying on the taker passing through; failing loud is safer than silent semantic drift.

**Other Engineering fixes:**

- `isAddress(v, { strict: false })` for both action `pickRequest` and request schema — accepts lowercase-or-checksummed addresses uniformly (LLM extraction commonly returns lowercase).
- `_paidWarnEmitted` is now a `WeakSet<runtime>` instead of module-global state. Different runtimes get their own warns; doesn't pin runtimes against GC.
- `client.preview()` now uses `safeParse` (was `parse`), matching the paid path. Generic error message; no ZodError leakage.
- Action handler now returns `{ success: false, text: scrubViemError(e) }` on errors instead of throwing — matches Eliza convention.

**Maintainer fixes:**

- README Quick start now notes both `Plugin[]` (object form) and `string[]` (npm-name form) registration patterns, with a clarifying line.
- README Migration includes the alpha-recovery path: `--legacy-peer-deps` + issue link if alpha.78+ peer warnings appear.
- README adds a top-line cost callout in Paid mode wiring (`$0.001/call. Fund $0.10 USDC + $0.50 ETH for ~100 checks.`).
- README Pre-sign safety section calls out the `paladin-trust BLOCKED pre-sign:` log prefix so operators know what to grep.
- README clarifies that paid responses **omit** the `real` field on factors (schema defaults to `true`).
- Action description string trimmed of "$0.001 USDC/call when in paid mode" — the LLM tool catalog no longer surfaces paid-mode pricing in preview-mode contexts.
- Examples array adds a negative case (action shouldn't fire on unrelated messages).
- `peerDependenciesMeta.optional: false` block dropped (redundant — peerDep alone says required).
- New manifest entry `PALADIN_TRUST_ALLOW_INSECURE` declared in `agentConfig.pluginParameters` with explicit "preview-mode-only, no effect on paid" wording.
- `package.json` adds `"engines": { "node": ">=20" }`.
- `viem` pinned exact (was `^2.21.0`); security-critical signing path shouldn't drift on minor.

**Test coverage additions:** `tests/boot-validation.test.ts` adds 2 cases for `PaladinTrustClient` direct-construction HTTPS gate (paid throws / preview allows). 26/26 tests pass.

**Audit trail:** Three reviewer reports captured for the audit record; v0.1.0 ships with all MED-sev fixes applied. Confidence: HIGH on funds-loss (Security audit found no path to drain beyond documented $0.001/call cap or to leak the test wallet key); MEDIUM on Eliza alpha API drift (mitigated by exact peer pin + Migration recovery path).

## [0.0.2] - 2026-05-03

Retrospective adversarial-review patch. Caught by 3-adversary review (Engineering+Security + Maintainer) on the v0.0.1 ship after the deploy-without-review gap was codified (memory: `feedback_no_deploy_without_adversarial_review.md`).

### Fixed

- **`@elizaos/core` moved from `dependencies` to `peerDependencies`.** Plugin frameworks must let the host runtime provide the framework — bundling our own copy of `@elizaos/core` would cause duplicate-install issues where the host's `Plugin` symbol doesn't `===` ours and runtime registration silently fails. Standard third-party plugin convention.
- **`paid` mode now gracefully degrades to `preview` with a one-time `console.warn`.** v0.0.1 threw at handler-time if `PALADIN_TRUST_MODE=paid` was set — but the public docs advertise paid mode as a configuration option. Users following the docs hit the throw on first NL invocation. v0.0.2 silently downgrades + warns once. v0.1.0 wires real paid x402 settlement.
- **HTTPS enforcement on `PALADIN_TRUST_API_BASE`.** v0.0.1 accepted any URL scheme. v0.0.2 rejects non-HTTPS bases unless `PALADIN_TRUST_ALLOW_INSECURE=1` is set (testnet/dev) or the host is `localhost`/`127.0.0.1`. Closes the silent-malicious-base attack vector.
- **`recommendation` Zod schema tightened from `z.string()` to `z.enum(TRUST_RECOMMENDATIONS)`.** v0.0.1 accepted arbitrary strings — a server-side typo (`"alllow"`) would silently pass validation and the agent would branch on it as `verdict === "allow"`. v0.0.2 fails parse on unrecognized values.
- **`CHANGELOG.md` now included in published tarball.** v0.0.1's `files` array omitted it.

### No breaking changes for v0.0.1 consumers

- The peerDep shift requires `@elizaos/core` already installed in the host project — which is the assumption for any Eliza plugin. No code change required for v0.0.1 consumers.
- The `paid` mode degrade is silent (was a throw before); existing callers with `PALADIN_TRUST_MODE=paid` env now succeed instead of fail. Strict regression-safe.
- HTTPS enforcement only fires on misconfigured `PALADIN_TRUST_API_BASE`. Default config is HTTPS already.
- Zod tightening only fails on responses the server should never return. If you observe parse failures in v0.0.2 you found a real server bug.

### Verified

- Adversarial review on v0.0.1 (4 reviewers in parallel: Engineering+Security and Maintainer for each of `eliza-plugin-trust` and the sister `agentkit-actions`).
- All HIGH-sev findings from review applied; no MED-sev findings deferred.
- `tsc --noEmit` clean.
- `npm run build` emits clean dist.
- `node smoke-test.mjs` all checks pass against live API.

## [0.0.1-roadmap] - 2026-05-02 (forward plan section from v0.0.1; realized in v0.1.0)

### Planned for v0.1.0 (target ≤ 2026-05-16)

- **LLM prompt-template extraction** — wire the v2-alpha pattern (`composePromptFromState` + `runtime.useModel(ModelType.TEXT_SMALL)` + `parseKeyValueXml`). Action accepts buy-token address from natural-language messages instead of explicit `options.address`.
- **Paid x402 settlement** in `PaladinTrustClient.paid()`. Wire EIP-3009 signing via the agent's wallet runtime. Resolve the 402 challenge issued by `/v1/trust-check`. Settle in USDC on Base (chainId 8453) at $0.001/call.
- **Validator factory** — replace v0.0.1 keyword regex validator with a structured `createTrustCheckActionValidator()` factory matching the `createEvmActionValidator()` pattern in `plugin-evm/typescript/actions/helpers.ts`.
- **Confirmation flow** — adopt the `confirmationRequired` / `isConfirmed` pattern from `transfer.ts` so paid trust-checks surface a preview before settling.
- **Vitest unit + integration tests**, gated live test, smoke-test reproducibility line.
- **Default mode flip** to `paid` once paid path is wired (`preview` remains override-able).

## [0.0.1] - 2026-05-02

Initial **skeleton release**. Anchors the public commitment in [Eliza Discussion #7242](https://github.com/orgs/elizaOS/discussions/7242) with a real public artifact.

### Added

- TypeScript ESM package targeting `@elizaos/core@^2.0.0-alpha.77`.
- `paladinTrustPlugin` exported from `index.ts` — a v2-alpha-shaped `Plugin` object with `actions: [trustCheckAction]`, empty `evaluators`/`providers`.
- `paladin_trust_check` action with:
  - Keyword-based validator (matches `trust-check`, `risk-gate`, `honeypot`, `ofac`, `sanctioned`, `verify-token`, `pre-trade` in message text).
  - Handler that parses `options.address` (explicit, no LLM extraction) and calls `/v1/trust-check/preview` via `PaladinTrustClient`.
  - `examples` array with one happy-path interaction.
  - `similes` for alternate invocation.
- `PaladinTrustClient` class with:
  - `preview()` — POSTs to `/v1/trust-check/preview` and Zod-validates the response shape.
  - `paid()` — currently throws (lands in v0.1.0).
- Zod schemas for `TrustCheckRequest`, `TrustCheckResponse`, `TrustBlock`, `TrustFactor`.
- Runtime config resolver pulling from `runtime.getSetting()` → `process.env` (`PALADIN_TRUST_API_BASE`, `PALADIN_TRUST_MODE`, `PALADIN_TRUST_DEFAULT_CHAIN_ID`).
- `agentConfig.pluginType: "elizaos:plugin:1.0.0"` manifest in `package.json` with `pluginParameters` declarations.
- `smoke-test.mjs` that hits the live preview endpoint and verifies the response shape.
- README, MIT LICENSE, CHANGELOG.

### Intentional v0.0.1 simplifications (vs full v2-alpha pattern in `elizaos-plugins/plugin-evm/transfer.ts`)

- **No LLM prompt-template extraction.** `paladin_trust_check` accepts the buy-token address explicitly via `options.address`. The v2-alpha pattern (`composePromptFromState` + `parseKeyValueXml`) lands in v0.1.0.
- **Preview endpoint only.** v0.0.1 calls `/v1/trust-check/preview` (free, sample fixture). Paid x402 settlement against `/v1/trust-check` requires wallet-runtime EIP-3009 signing, which lands in v0.1.0.

### Verified

- `tsc --noEmit -p tsconfig.json` — zero errors.
- `npm run build` — emits clean `dist/` (`.js` + `.d.ts` + sourcemaps for every src file).
- `npm pack --dry-run` — 17.0 kB tarball, 28 files, no junk.
- `node smoke-test.mjs` — hits live `swap.paladinfi.com/v1/trust-check/preview`, returns `recommendation: "sample-allow"` with 4 factors and `_preview: true`. Round-trip Zod parse passes.

[Unreleased]: https://github.com/paladinfi/eliza-plugin-trust/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/paladinfi/eliza-plugin-trust/releases/tag/v0.2.0
[0.1.0]: https://github.com/paladinfi/eliza-plugin-trust/releases/tag/v0.1.0
[0.0.2]: https://github.com/paladinfi/eliza-plugin-trust/releases/tag/v0.0.2
[0.0.1]: https://github.com/paladinfi/eliza-plugin-trust/releases/tag/v0.0.1
