# RUNBOOK — PaladinFi trust-services operations

**Audience.** PaladinFi engineers + on-call operators. **NOT customer-facing.** Customer documentation is in [README.md](./README.md) + [THREAT_MODEL.md](./THREAT_MODEL.md).

**Scope.** Operational procedures for the v0.2.0 trust infrastructure: simulator EC2 + trust-services VM (decommissioner + iam-updater + indexer) + 3 KMS keys (AWS-A + GCP + AWS-B) + on-chain `PaladinKeyRegistry` on Base + Cloudflare Worker + GitHub Pages mirror.

**Discipline.** Every operational event involving on-chain state, KMS keys, multisig, or customer-visible state changes MUST be logged in `paladinfi-contracts/audit-trail/NNNN-*.md`. Files are append-only.

**Bus-factor.** v0.2.0 is bus-factor=1 (Mallesh as sole operator). §5g defines the recovery procedure for the designated external party. v0.3.0 traction gate adds independent third-party multisig signer.

---

## Table of contents

1. [Quick reference](#1-quick-reference)
2. [Pre-deploy checklist](#2-pre-deploy-checklist)
3. [Daily / weekly / monthly cadence](#3-daily--weekly--monthly-cadence)
4. [Incident response — alert → action map](#4-incident-response--alert--action-map)
5. [Rotation ceremonies](#5-rotation-ceremonies)
   - 5a. /v1/simulate keys (Key #1 / Key #2) — staggered 30-day cycle
   - 5b. Dual-pending playbook (mid-rotation cancellation)
   - 5c. Cloudflare PAT rotation
   - 5d. Indexer attestation key (Key #3 at AWS-B) — quarterly
   - 5e. Webhook secret rotation (HMAC) — quarterly
   - 5f. Vendor credential inventory + month-end reconciliation
   - 5g. Bus-factor + recovery
6. [Multisig + Shamir signer rotation](#6-multisig--shamir-signer-rotation)
7. [Indexer dead-man-switch + decommissioner heartbeat](#7-indexer-dead-man-switch--decommissioner-heartbeat)
8. [Multi-cloud triage (per-account suspension)](#8-multi-cloud-triage-per-account-suspension)
9. [Continuity story (RPO / RTO + restore from snapshot)](#9-continuity-story-rpo--rto--restore-from-snapshot)
10. [Emergency procedures (compromise / signed-message-leak / panic)](#10-emergency-procedures)
11. [Customer-comms templates](#11-customer-comms-templates)
12. [Doc-update discipline](#12-doc-update-discipline)
13. [Reference — file paths, services, IAM principals](#13-reference)

---

## 1. Quick reference

### Hosts
| Host | Purpose | OS / Region |
|---|---|---|
| simulator EC2 | `paladin-simulator.service` (FastAPI + Anvil + signer) | Ubuntu 24.04 LTS, `us-east-2` |
| trust-services VM | `paladin-indexer` + `paladin-iam-updater` + `paladin-decommissioner` | Ubuntu 24.04 LTS, AWS-A `us-east-2` |
| Cloudflare Worker | `events.json` mirror + mTLS | Edge |
| GitHub Pages | `events.json` mirror (read-only fallback) | `paladinfi.github.io/transparency` |

### KMS keys
| Key | Purpose | Account / Region | Alias |
|---|---|---|---|
| #1 | /v1/simulate signing (1-of-2) | AWS-A `us-east-2` | `alias/paladin-sim-aws-v0` |
| #2 | /v1/simulate signing (1-of-2) | GCP `us-east1` | `projects/.../keyRings/paladin-keyring/cryptoKeys/sim-v0` |
| #3 | Indexer attestation | AWS-B `us-west-2` | `alias/paladin-indexer-attestation-v0` |

### On-chain
- `PaladinKeyRegistry` on Base — address recorded in `paladinfi-contracts/deployments.json` after Step 47 deploy
- Owner: Gnosis Safe 2-of-3 multisig
- Network: Base mainnet (chainId `8453`)

### IAM principals (per-service Linux users on trust-services VM)
| Linux user | UID file | IAM scope |
|---|---|---|
| `paladin-indexer` | `/etc/paladin/aws-account-b-credentials` (mode 0400) | STS:AssumeRole → AWS-B `kms:Sign` on Key #3 only |
| `paladin-iam-updater` | (no AWS creds) | Local filesystem only — writes `/etc/paladin/iam-allowlist.json` |
| `paladin-decommissioner` | `/etc/paladin/decommissioner-creds` (mode 0400) | STS:AssumeRole → AWS-A `kms:ScheduleKeyDeletion` on key-arn allowlist only |
| `paladin-monitoring` | `/etc/paladin/monitoring-creds` (mode 0400) | CloudWatch namespace-scoped only; AWS Budgets cap $5/mo |

Simulator EC2 has its own IAM principal `paladin-simulator-signer` (AWS-A `kms:Sign` on Key #1).

### Secrets locations
| Secret | Storage | Rotation |
|---|---|---|
| HMAC webhook secret (iam-updater ↔ Tenderly Alerts) | AWS Secrets Manager (account A) | quarterly |
| `server_secret` (retryToken HMAC) | AWS Secrets Manager (account A) | quarterly |
| Tenderly API key | `/etc/paladin/tenderly-api-key` (simulator EC2) | yearly |
| Twilio auth token | `/etc/paladin/twilio-auth-token` (trust-services VM) | yearly |
| Cloudflare PAT (Worker deploy) | 1Password vault | quarterly (§5c) |
| Multisig signer keys | YubiKey-backed; 1Password emergency-kit at trusted party | per §6 |

### npm publish
Account: `mgopal20` / paladinfi org. Package: `@paladinfi/eliza-plugin-trust`. Always `npm publish --access=public --otp=<2FA>`.

---

## 2. Pre-deploy checklist

Before each customer-visible release (npm publish):

- [ ] CHANGELOG entry written; semver bump justified
- [ ] `pnpm test` clean
- [ ] `pnpm typecheck` clean
- [ ] `pnpm audit --prod --audit-level=high` clean
- [ ] `tests/drift.test.ts` clean with `LIVE_DRIFT_CHECK=1`
- [ ] `forge test` clean in `paladinfi-contracts/` (if contract changed)
- [ ] 3-adversary review per CLAUDE.md "Adversarial Review Gate" — verdict captured
- [ ] All MINOR-FIXES applied
- [ ] No `Date.now()` outside `src/utils/clock.ts`
- [ ] `tsc --noEmit` clean
- [ ] `npm pack` tarball reviewed: includes `THREAT_MODEL.md` per Sec LOW-7
- [ ] Manual paid smoke on Account 4 wallet (`0x18779E5478...0aC1`) — see [internal_docs_backup memory + .env.local](#13-reference)

Before each on-chain operation (deploy / rotation finalize / revoke):

- [ ] Audit-trail entry drafted in `paladinfi-contracts/audit-trail/NNNN-*.md`
- [ ] Multisig signers notified ≥24h ahead of finalize
- [ ] Pre-flight verification: `cast call PaladinKeyRegistry.readTrustState()` returns expected pre-state
- [ ] Etherscan-equivalent (Basescan) ABI verification pre-confirmed
- [ ] Estimated gas ≤2× recent average (else investigate before submit)
- [ ] STS:AssumeRole session opened with 1h TTL only

---

## 3. Daily / weekly / monthly cadence

### Daily (automated alerts; review on-call queue)
- CloudWatch: disk >80% / memory >90% / instance unreachable >5min / CPU >90% sustained 5min
- Indexer dead-man-switch: alert if no event published in 24h
- Decommissioner heartbeat: alert if last successful run >32 days (cron is 30d, 2-day grace)
- nginx 5xx rate >0.5% over 5min
- /v1/simulate signature recovery to PRIOR_EPOCH address >30s after SIGHUP (P2 page)

### Weekly (Monday on-call)
- Review `usage_summary.py --days 7` for anomalies (sustained >2 req/sec, revenue projecting past tier breakpoint per CLAUDE.md REMINDERS infrastructure-capacity watch)
- Triage GitHub Discussions / Issues; respond within 48h SLA per §11
- Verify GitHub Pages mirror still serving signed events.json (`curl -I https://paladinfi.github.io/transparency/events.json`)
- Verify Cloudflare Worker mTLS still serving (`curl --cert ... https://transparency.paladinfi.com/events.json`)
- Confirm Base RPC pool ≥2 distinct operators reachable (operator-distinctness drift CI signal)

### Monthly (first-Monday review per Eng MED-5)
- Review wheel-SHA256 lock + Dependabot hash-bump PRs (server-side `pip-tools` lockfile)
- Review `pnpm audit` for HIGH/CRITICAL CVEs against pinned plugin deps
- Snapshot `deployments.json` to git (no diff = no drift; diff requires audit-trail entry)
- Vendor-invoice reconciliation per §5f (cross-check >2× MoM cost deviation as fraud-trigger)

### Quarterly
- /v1/simulate Key #1 + Key #2 staggered rotation (§5a)
- Indexer attestation Key #3 rotation (§5d)
- Webhook HMAC secret rotation (§5e)
- Vendor credential rotation (§5f) — AWS-A + AWS-B + GCP + Cloudflare + GitHub org root passwords + FIDO2 re-attestation
- Doc audit per `scripts/doc_audit.sh` cron — verify README §17 callout, THREAT_MODEL.md freshness, `_archive/` integrity

### Yearly
- Tenderly + Twilio + PagerDuty TOTP rotation
- Re-attest sealed-envelope at trusted party (§5g)
- Bus-factor review: if v0.3.0 traction gate has fired, the third-party signer should be onboarded — see §6

---

## 4. Incident response — alert → action map

| Alert | Severity | First response | Escalation |
|---|---|---|---|
| `/v1/simulate` 5xx >5% over 5min | P1 | SSH simulator EC2; `journalctl -u paladin-simulator -n 200`; `systemctl status` | If signer or Anvil hung, restart service; if KMS API failing, check IAM session + backoff schedule |
| Signature recovery to PRIOR_EPOCH address >30s after SIGHUP | P2 | Verify `KEY_ARN_*_CURRENT` constant in `/etc/paladin/simulator.env` matches just-finalized address; if mismatch, hot-reload via `kill -HUP $(pidof gunicorn)` then re-verify | If hot-reload fails twice, restart simulator with on-call presence |
| Decommissioner heartbeat stale >32d | P3 | SSH trust-services VM; `cat /var/run/paladin/decommissioner.last_run`; `journalctl -u paladin-decommissioner -n 50` | If cron disabled or fail-closed on stale allowlist, see §7 + §5d |
| Indexer dead-man-switch (no event 24h) | P2 | SSH trust-services VM; check `paladin-indexer` status + SQLite `event_signing_queue` for stuck rows | If signing queue stuck, KMS issue → check Account B IAM; if event ingest stuck, check Base RPC pool |
| iam-updater webhook with invalid HMAC | P3 (info; auto-rejected) | Verify Tenderly Alerts config not corrupted | If sustained, rotate HMAC secret per §5e |
| iam-updater on-chain re-verification mismatch | P1 | **STOP all rotation activity.** Webhook claims rotation but on-chain quorum disagrees. Investigate before any further state change. | Possible RPC operator compromise OR webhook source compromise — triage which |
| CloudWatch instance-unreachable | P1 | Try SSH; if down, AWS console → check instance status + system logs; if hardware fault, re-launch from AMI per §9 | RTO 4h |
| Disk >80% on any host | P3 | `df -h`; rotate logs; clean `/tmp`; expand EBS if structural growth | Auto-page if >90% |
| pnpm audit HIGH/CRITICAL CVE on production dep | P2 | Per Eng MED-5 emergency unlock: review → unlock wheel SHA → patch → re-lock → re-test → ship within 72h | Owner = indexer-component reviewer |
| Customer reports unverifiable `/v1/simulate` signature | P1 | Pull customer's debug bundle if available; reproduce against same on-chain trust state | If reproducible, 3-adversary review of root cause before any production change |
| Multisig signer key compromise (suspected) | P0 | See §10. Immediate revoke of pending rotation; emergency multisig action; all-customer comms via GitHub Discussion + @paladin_fi | Engage trusted-party recovery (§5g) if Mallesh unreachable |
| Cloud-provider account suspension (any of A/GCP/B) | P0 | See §8. Multi-cloud triage. | RTO 7-10d; customer comms required |

---

## 5. Rotation ceremonies

### 5a. /v1/simulate keys — staggered 30-day cycle

**Cadence.** Key #1 (AWS-A) rotated month 1 / month 3 / month 5 / ...; Key #2 (GCP) rotated month 2 / month 4 / month 6 / ... — staggered so no two-key rotation overlap.

**STS discipline.** All steps run with STS:AssumeRole session TTL = 1 hour, never longer. If steps exceed 1h, re-AssumeRole.

**Steps:**

1. Open audit-trail entry `NNNN-rotation-key-{1|2}-epoch-{N+1}.md` with status `PROPOSED`.
2. Generate new key inside KMS (AWS: `aws kms create-key --key-spec ECC_SECG_P256K1 --key-usage SIGN_VERIFY --origin AWS_KMS`; GCP: `gcloud kms keys create ... --algorithm=EC_SIGN_SECP256K1_SHA256`). **Never extract material.**
3. Derive Ethereum address by `kms:GetPublicKey` → DER decode → uncompressed pubkey → `keccak256(pubkey[1:])[12:]`. Verify checksum address.
4. Multisig: `proposeRotation(newAwsAddr, newGcpAddr, newEpoch)` via Gnosis Safe. **Wait 7 days** (TIMELOCK).
5. During the 7-day window, monitor for any reason to cancel (key suspected compromise, RPC operator reports anomaly, customer reports issue). To cancel: see §5b.
6. After 7 days have elapsed AND >24h has passed since `pendingRotationProposedAt` (the 24h FINALIZE_OWNER_WINDOW means only owner can finalize for first 24h after timelock expires; any address can finalize after that window — but in practice owner always finalizes):
   - Multisig: `finalizeRotation()`. Capture tx hash.
   - **Drain in-flight requests BEFORE swapping `KEY_ARN_*_CURRENT`** — close listener for 30s, drain pending /v1/simulate requests, then update `/etc/paladin/simulator.env`.
   - SIGHUP simulator: `kill -HUP $(pidof gunicorn)` (lifespan handler reloads signer with new KMS key ARN).
   - Verify `/health` reports new signer address; wait for first signed response with new address; verify against on-chain `readTrustState()`.
   - Update `paladinfi-contracts/deployments.json` with new key block + epoch + tx hash.
7. Decommissioner picks up the old key from on-chain `RotationFinalized` event → its 30-day clock starts → schedules `kms:ScheduleKeyDeletion` on PendingWindowInDays=30 = 30+30 = 60d total before old key material erased. Verify decommissioner allowlist updated by iam-updater within 5 min.
8. Audit-trail entry updated: status `FINALIZED`, tx hash, state-before / state-after, multisig signers list.
9. Customer-comms: post in GitHub Discussion + @paladin_fi per §11 template "Routine rotation complete".

**Total wall time:** 7 days TIMELOCK + ~30 min ceremony = ~7 days.

### 5b. Dual-pending playbook (mid-rotation cancellation)

If during the 7-day pending window we discover a reason to cancel the rotation (compromise suspected, wrong key derived, customer issue):

1. Open audit-trail entry `NNNN-cancellation-rotation-key-{1|2}-epoch-{N+1}.md` with status `CANCELLED`.
2. Multisig: `proposeRotation(awsCurrent, gcpCurrent, currentEpoch)` — proposing the SAME state as current is the cancel signal. The contract emits `RotationCancelled` and clears `pendingRotation`.
3. Wait minimum 24h OVERWRITE_LOCKOUT before any new `proposeRotation`. Within 24h is locked-out per contract.
4. Audit-trail entry updated: status `CANCELLED`, reason captured.
5. Customer-comms: ONLY if customers might have observed `RotationProposed` — usually we don't comm cancellations unless they were customer-facing.

**Special case: revoke during pending window.** If we need to revoke an epoch that has been `proposeRotation`'d but not yet `finalizeRotation`'d:
- The contract's `finalizeRotation` checks `!revoked[pending.epoch]` → finalize will fail.
- Operator must `proposeRotation(awsCurrent, gcpCurrent, currentEpoch)` (cancel) first, THEN `revoke(badEpoch)` separately. Don't try to revoke active or future epochs — contract reverts.

### 5c. Cloudflare PAT rotation

Quarterly. PAT is the credential the deploy CI uses to push the Worker.

1. Generate new PAT in Cloudflare dashboard with scope `Workers:Edit` only (least privilege).
2. Update GitHub Actions secret `CLOUDFLARE_API_TOKEN` for the contracts repo's Worker-deploy workflow.
3. Test: trigger workflow with no-op change; verify deploy succeeds.
4. Revoke old PAT.
5. Update `paladinfi-contracts/audit-trail/NNNN-cloudflare-pat-rotation.md`.

### 5d. Indexer attestation key (Key #3 at AWS-B) — quarterly

**Cadence.** First Monday of Jan / Apr / Jul / Oct.

**STS discipline.** Same 1h ceremony as §5a. Cross-account: from trust-services VM's instance role, AssumeRole into AWS-B's `paladin-indexer-rotation-role` (separate from runtime `paladin-indexer-signer-role`).

**On-chain primitive.** `PaladinKeyRegistry.proposeIndexerKeyChange(newAddr)` → 7-day timelock → `finalizeIndexerKeyChange()`. 24h FINALIZE_OWNER_WINDOW + 24h OVERWRITE_LOCKOUT same as /v1/simulate keys.

**Steps:**

1. Open audit-trail entry `NNNN-rotation-key-3-epoch-{N+1}.md` with status `PROPOSED`.
2. AssumeRole into AWS-B with 1h TTL.
3. `aws kms create-key --key-spec ECC_SECG_P256K1 --key-usage SIGN_VERIFY --origin AWS_KMS --region us-west-2` — operator never holds private key material.
4. Derive Ethereum address (same procedure as §5a step 3).
5. Multisig: `proposeIndexerKeyChange(newAddr)`. Wait 7 days.
6. During the 7-day window, monitor as in §5a. Cancel via `proposeIndexerKeyChange(currentAddr)` if needed.
7. After 7-day timelock + within owner-finalize window:
   - Multisig: `finalizeIndexerKeyChange()`. Capture tx hash.
   - **Drain in-flight indexer signing requests** — pause `event_signing_queue` consumer for 30s; let in-flight signs complete.
   - Update `KEY_ARN_INDEXER_CURRENT` in `/etc/paladin/indexer.env`.
   - SIGHUP indexer: `kill -HUP $(pidof paladin-indexer)`.
   - Verify `/health` endpoint reports new attestation public-key fingerprint.
   - **If hot-reload fails:** indexer-restart with on-call presence (`systemctl restart paladin-indexer`); do not declare rotation complete until /health verified.
   - Update `paladinfi-contracts/deployments.json` `kms_keys.indexer_attestation_aws` block with new address + key_arn + epoch + tx hash.
8. Verify next signed event published to events.json verifies against new address.
9. Audit-trail entry updated: status `FINALIZED`.
10. Customer-comms: same as §5a — routine rotation post.

### 5e. Webhook secret rotation (HMAC) — quarterly

**Why.** The HMAC shared secret between Tenderly Alerts (advisory webhook source) and `paladin-iam-updater` defends against forged rotation webhooks. Compromise of the secret allows attacker to fire false rotation events; on-chain re-verification still blocks accept, but P1 alerts would fire. Quarterly rotation reduces window.

**Cadence.** Quarterly, same first-Monday cadence as §5d.

**Atomic procedure (overlap window <60s):**

1. Open audit-trail entry `NNNN-webhook-secret-rotation.md`.
2. Generate new HMAC secret (32 bytes random) and store in AWS Secrets Manager (account A) under new version label.
3. Update Tenderly Alerts config to use new secret. Tenderly takes ~30s for cache propagation.
4. Wait 30s.
5. Update iam-updater config to fetch new version label; SIGHUP iam-updater so it re-reads from Secrets Manager.
6. Verify next webhook arrives and is HMAC-validated successfully (use a no-op webhook trigger if Tenderly supports one; else wait for the next real rotation alert and verify).
7. Revoke old secret in Secrets Manager (`aws secretsmanager update-secret-version-stage --remove-from-version-id ...`).
8. Total overlap window <60s.

### 5f. Vendor credential inventory + month-end reconciliation

**Inventory** (rotate per cadence; record `Last rotated` date in this file):

| Vendor | Account email | MFA method | Rotation cadence | Last rotated | Recovery contact |
|---|---|---|---|---|---|
| AWS-A | aws-a@paladinfi.com | hardware FIDO2 (YubiKey 5C NFC, primary + backup) | quarterly | TBD post-Step 49 | (designated party — see §5g) |
| AWS-B | aws-b@paladinfi.com | hardware FIDO2 | quarterly | TBD post-Step 49 | (designated party) |
| GCP | gcp@paladinfi.com | hardware FIDO2 | quarterly | TBD post-Step 49 | (designated party) |
| Cloudflare | cloudflare@paladinfi.com | hardware FIDO2 | quarterly | TBD | (designated party) |
| GitHub org (paladinfi) | (admin email per ACCOUNTS.md) | hardware FIDO2 | quarterly | TBD | (designated party) |
| Tenderly | tenderly@paladinfi.com | TOTP | yearly | TBD | (designated party) |
| Twilio | twilio@paladinfi.com | TOTP | yearly | TBD | (designated party) |
| PagerDuty | pagerduty@paladinfi.com | TOTP | yearly | TBD | (designated party) |
| 1Password | (master account per ACCOUNTS.md) | hardware FIDO2 + master password | yearly | TBD | (designated party) |

**Quarterly rotation procedure (per vendor):**

1. Sign in with current credentials + MFA.
2. Generate new password (1Password 32-char random with all classes).
3. If FIDO2: re-attest both YubiKeys (verify keys still present + responding).
4. Update 1Password vault.
5. Sign out; sign back in with new credential + MFA to verify.
6. Update this table's `Last rotated` column.

**Month-end vendor-invoice reconciliation (Maint MED-2):**

Per first-Monday review:

1. Pull invoices for the last calendar month from each vendor:
   - AWS-A console → Billing → Bills
   - AWS-B console → Billing → Bills
   - GCP console → Billing → Reports
   - Cloudflare dashboard → Billing
   - Tenderly / Twilio / PagerDuty / 1Password — email invoices
2. Compute MoM delta per vendor.
3. **Fraud-trigger threshold: any vendor with >2× MoM cost deviation triggers investigation BEFORE paying.** Review CloudTrail / Cloud Audit Logs for unexpected resource creation; review IAM principals; verify MFA history.
4. If verified-clean, mark month reconciled in `_archive/vendor-invoices-YYYY-MM.md`.
5. **Operational time budget: 6-10 hr/quarter** for this discipline (Maint MED-2). If sustained >10 hr/quarter, automate or escalate to v0.3.0 traction-gate ops staffing decision.

### 5g. Bus-factor + recovery

**Current state (v0.2.0).** Bus-factor=1. Mallesh is sole operator. Designated external trusted party identity is recorded in 1Password emergency-kit (NOT this file).

**Recovery procedure (if Mallesh unreachable >7 days):**

1. Trusted party retrieves sealed envelope from agreed physical location.
2. Envelope contains:
   - 1Password emergency-kit (master password + secret key)
   - One YubiKey backup (separate physical location from Mallesh's primary)
   - Escrowed multisig signer secret share (per §6)
   - This RUNBOOK as printed reference
3. Trusted party uses 1Password to retrieve all vendor credentials.
4. Trusted party performs minimum-necessary actions: pause customer-facing services if active incident; freeze on-chain state by invoking `revoke(epoch)` if compromise suspected; do NOT propose new rotations or change multisig threshold.
5. Trusted party engages legal + technical counsel for v0.3.0 transition or business wind-down per will / power-of-attorney.

**v0.3.0 traction-gate fix:** Independent third-party multisig signer (genuine bus-factor improvement). Threshold remains 2-of-3; signer set goes from {Mallesh primary, Mallesh backup, escrow} → {Mallesh, third-party-A, third-party-B}.

**Pre-launch step 49.5 (Maint LOW-1):** v0.2.0 deploy is BLOCKED until:
- [ ] Designated party identified
- [ ] Designated party briefed on procedure
- [ ] Sealed envelope handed off + party written confirmation captured

---

## 6. Multisig + Shamir signer rotation

**Multisig.** Gnosis Safe 2-of-3 on Base owns `PaladinKeyRegistry`. v0.2.0 signer set is PaladinFi-controlled (effective single-person trust root with bus-factor=1). v0.3.0 traction gate adds independent third-party signer.

**Signer rotation procedure (when adding/removing/replacing a signer):**

1. Open audit-trail entry `NNNN-multisig-signer-rotation.md`.
2. Propose signer change in Gnosis Safe (Safe → Settings → Owners). Threshold can change in same tx.
3. Other signers approve until threshold met.
4. Execute. Capture tx hash.
5. Verify new owner set on-chain via Safe explorer.
6. Update `paladinfi-contracts/deployments.json` `owner_safe_address` block (if Safe address itself changed; else just owner list noted in audit-trail).
7. Update `ACCOUNTS.md` (top-level project doc) with new signer email mapping.
8. Customer-comms only if signer set change is material (e.g., third-party signer onboarded — that's a v0.3.0 trust-model improvement worth announcing).

**Shamir secret-share scheme** (for the escrowed signer): 3-of-5 threshold. Shares stored at:
1. Mallesh primary (1Password emergency-kit)
2. Mallesh backup (separate physical location)
3. Trusted party (sealed envelope per §5g)
4. Bank safety deposit box (jurisdiction TBD)
5. Legal counsel (subject to engagement)

Reconstruction requires any 3 of 5. Procedure: `ssss-combine -t 3 < shares.txt` per Adi Shamir's classical scheme.

**v0.3.0 retirement:** Shamir scheme retired when independent third-party signer is onboarded; Shamir was a hack to give bus-factor to a single-person org.

---

## 7. Indexer dead-man-switch + decommissioner heartbeat

### Indexer dead-man-switch

**What.** If indexer fails to publish a signed event for 24h, alerts fire because customers (and we) lose transparency on rotation events. Note: the plugin does NOT depend on events.json for trust path — it verifies signatures against on-chain `PaladinKeyRegistry` directly. Events.json is transparency mirror only.

**How:**
- Indexer increments `last_event_published_at` in SQLite on every signed-and-published event.
- Cron job (`*/5 * * * *`) checks `now - last_event_published_at > 24h` → Twilio + PagerDuty page.
- If real outage (customer-visible), post status update in GitHub Discussion per §11 template "Indexer outage".

**Triage:**
- `journalctl -u paladin-indexer -n 500` — look for KMS errors, RPC errors, SQLite locked
- `sqlite3 /var/lib/paladin/indexer.sqlite 'SELECT * FROM event_signing_queue WHERE signed_at IS NULL ORDER BY id ASC LIMIT 10;'` — stuck events
- If KMS issue: check AWS-B IAM session; verify Key #3 still active (`aws kms describe-key --region us-west-2 --key-id alias/paladin-indexer-attestation-v0`)
- If RPC issue: check `KNOWN_BASE_RPC_OPERATORS` distinctness ≥2; rotate to backup pool if needed

### Decommissioner heartbeat

**What.** Decommissioner runs daily-cron-driven; deletes old KMS keys 30+ days post-rotation per allowlist. If heartbeat is stale >32 days, something has gone wrong.

**How:**
- Decommissioner cron writes `/var/run/paladin/decommissioner.last_run` on each successful run (success = no errors, allowlist read OK, no deletions needed OR deletion completed).
- Daily cron at 06:00 UTC checks `mtime < now - 32d` → P3 page.
- Service systemd unit also has `ExecStartPre` allowlist mtime check: if `/etc/paladin/iam-allowlist.json` is older than 24h, decommissioner refuses to start (fail-closed per R13 Eng HIGH-3).

**Triage:**
- `cat /var/run/paladin/decommissioner.last_run` — when did it last succeed?
- `journalctl -u paladin-decommissioner -n 200`
- `stat /etc/paladin/iam-allowlist.json` — is iam-updater stale?
- If iam-updater is stale: webhook is dead (Tenderly Alerts down) OR HMAC secret is wrong → see §5e
- If decommissioner can't AssumeRole into AWS-A: IAM session issue or key-arn allowlist drift; check `aws sts get-caller-identity` in the trust-services VM context

### iam-updater heartbeat

**What.** iam-updater publishes `last_run_ok` to indexer's heartbeat-receiver every 60s. Indexer cron checks `now - last_iam_updater_heartbeat > 5min` → P3 page.

**Triage:**
- `journalctl -u paladin-iam-updater -n 200`
- Verify webhook reachability: `nc -zv tenderly-alerts.example.com 443`
- Verify Secrets Manager: `aws secretsmanager get-secret-value --secret-id paladin-iam-updater-hmac --version-stage AWSCURRENT`

---

## 8. Multi-cloud triage (per-account suspension)

**Threat.** Cloud provider may suspend any of AWS-A / GCP / AWS-B for any reason (false fraud detection, billing dispute, compliance review). Documented customer-facing window: 7-10 days fail-closed for auto-rotate customers; pinned mode + Tenderly fallback continue working.

### AWS-A suspension (Key #1 + simulator-signer + decommissioner cross-account target + Secrets Manager)

**Impact.** /v1/simulate signing breaks (Key #1 unavailable → 2-of-2 cannot complete). `server_secret` HMAC store unavailable. Decommissioner cannot complete `kms:ScheduleKeyDeletion` (cross-account target down).

**Triage:**
1. Page P0. Customer-comms within 1h per §11 template "Cloud account suspension".
2. Confirm via AWS support case (if reachable) OR alternate channel (Twitter @awssupport).
3. **Do NOT propose multisig rotation while suspended.** Wait until restored OR until traction-gate v0.3.0 4th-provider Azure can take over Key #1's role.
4. If suspension >7d: announce extended fail-closed window. Customers should switch to `keyTrustMode: 'pinned'` or `simulationVerifier: 'tenderly'` per README §14.

### GCP suspension (Key #2)

**Impact.** Same as AWS-A — /v1/simulate 2-of-2 signing breaks.

**Triage:** Same procedure. GCP suspensions may be slower to resolve; have alternate contact channels ready.

### AWS-B suspension (Key #3 indexer attestation)

**Impact.** Indexer cannot sign new events.json updates. **Customer trust path is NOT affected** — plugin reads `PaladinKeyRegistry` on-chain directly. But transparency is paused.

**Triage:**
1. Page P1 (lower than AWS-A/GCP since trust path unaffected).
2. Notify customers per §11 template "Transparency paused".
3. iam-updater + decommissioner continue functioning since they don't use AWS-B.

### Two simultaneous suspensions

**If AWS-A AND GCP both suspended:** 100% /v1/simulate outage. All customers fail-closed. P0+++.
**If AWS-A AND AWS-B both suspended:** /v1/simulate broken + transparency paused. P0.
**If GCP AND AWS-B both suspended:** /v1/simulate broken + transparency paused. P0.
**If all three suspended:** Plugin cannot serve any /v1/simulate verification. v0.3.0 4th-provider Azure mitigates this risk; v0.2.0 customers should be aware (disclosed in THREAT_MODEL.md §8).

### Mitigation during suspension

- Read pinned-mode customers continue to function (they don't read on-chain trust state, but verifier still needs /v1/simulate signing — so they're affected too).
- `simulationVerifier: 'tenderly'` customers continue to function (they bypass our /v1/simulate entirely).
- During extended outage, document "if you're affected" in customer-comms and recommend Tenderly mode.

---

## 9. Continuity story (RPO / RTO + restore from snapshot)

### Targets

| Component | RPO | RTO |
|---|---|---|
| Simulator EC2 | 1h | 4h |
| Trust-services VM (UNIT — Maint HIGH-1) | 1h | 4h |
| Decommissioner | N/A (idempotent) | 7d (low-criticality) |

### Backup discipline

- Simulator EC2: hourly EBS snapshot (1h RPO); monthly Packer-built golden AMI per Maint LOW-2.
- Trust-services VM: hourly SQLite snapshot to S3 (`/var/lib/paladin/{indexer,retry-tokens,signing-queue,allowlist}`).
  - S3 bucket has Object Lock enabled with 90-day governance retention per Maint LOW-2.
  - IAM scope: `s3:PutObject` only; restore requires out-of-band MFA-only role.
- `paladinfi-contracts/deployments.json`: every change committed to git (git is the backup).
- 1Password vault: real-time replicated by 1Password.

### VM-loss recovery

1. Identify which host is lost. Check AWS console → Instances.
2. If hardware fault: re-launch from latest AMI in same AZ (or different AZ if AZ-wide outage).
3. Wait for instance to boot. Verify `cloud-init` ran clean.
4. Restore SQLite snapshots from S3 to `/var/lib/paladin/`.
5. SSH in, verify systemd units start in order (indexer → iam-updater → decommissioner per ordering directive).
6. Verify `/health` endpoints respond on each service.
7. Verify next event ingest cycle completes successfully.
8. Run `cast call PaladinKeyRegistry.readTrustState()` from new host to verify on-chain reach.
9. Audit-trail entry `NNNN-vm-recovery-{simulator|trust-services}.md` with reason + procedure followed.

### IAM session refresh + exponential backoff (Eng MED-2)

All STS:AssumeRole flows have:
- Backoff schedule: 1/2/4/8/60s, 5 retries, then raise + P2 page if STS unavailable >5min
- Systemd `Restart=on-failure RestartSec=30s` on services that consume STS
- Never fails open. STS unavailability = service unavailable, not service-with-degraded-trust.

### Single-region acknowledgement

v0.2.0 simulator + trust-services VM are both `us-east-2`. Regional outage = 4h+ RTO. v0.3.0 traction-gate adds multi-region + active-passive failover.

---

## 10. Emergency procedures

### Suspected compromise of /v1/simulate signing key (#1 or #2)

**P0. STOP all rotation activity. Treat as funds-loss vector.**

1. Open audit-trail entry `NNNN-emergency-suspected-compromise-key-{1|2}.md` with status `EMERGENCY`.
2. Multisig: `revoke(currentEpoch)` to immediately fail-close trust path for that epoch. Customers will see `RESPONSE_EPOCH_REVOKED` and refuse to use signed responses.
3. If a `pendingRotation` exists for the same epoch, contract's `finalizeRotation` will block (`!revoked[pending.epoch]`). Cancel pending separately if needed (§5b cancel pattern, then re-revoke if state requires).
4. Customer-comms within 1h per §11 template "Emergency revoke".
5. Forensic: `journalctl` + CloudTrail / Cloud Audit Logs from last 30d. Identify access path.
6. Generate replacement key per §5a procedure but with audit-trail link to compromise event.
7. After rotation completes, post all-clear via §11 template.

**Important: don't revoke epochs that are active or future.** Contract reverts on `revoke(epoch >= currentEpoch)` per the anti-brick guard. Revoke only past epochs.

### Suspected compromise of indexer attestation key (#3)

**P1. Customer trust path is NOT affected.** Trust path is on-chain reads, not events.json signatures.

1. Open audit-trail entry `NNNN-emergency-suspected-compromise-key-3.md`.
2. Optional: revoke isn't necessary because Key #3 doesn't sign anything customers verify against. The risk is forged events.json entries that don't match on-chain truth — customers cross-check on-chain anyway.
3. Rotate per §5d but on emergency cadence (still 7-day timelock; can't bypass).
4. Customer-comms via §11 template "Transparency paused (compromise rotation in progress)".

### Suspected multisig signer key compromise

**P0. Immediate emergency multisig action.**

1. Other signers immediately propose `swapOwner(compromised, replacement)` via Gnosis Safe.
2. **Do NOT use the compromised signer to sign anything new.** Treat as adversarial.
3. Customer-comms per §11 template "Multisig signer rotation (emergency)".
4. If compromise is the v0.2.0 single-person signer (Mallesh) and Mallesh is unreachable: trusted party engages per §5g recovery procedure with sealed-envelope multisig signer secret share.

### Signed-message-leak (canonical-JSON envelope leaked)

**P1. Plugin's freshness check ±600s with -120s clock-skew window prevents replay older than ~10min.** If a signed response is leaked within that window, attacker could replay against an unaware client.

1. Force-rotate Key #1 + Key #2 via §5a accelerated cadence (still 7-day timelock).
2. Customer-comms recommending pinned-mode customers re-verify their pin.
3. If specific customer affected: direct outreach via GitHub Discussions or email (when v0.3.0 email list exists).

### Panic stop — fail-close all customers

**Use only when imminent funds-loss for customers is certain.**

1. Multisig: `revoke(currentEpoch)`. All `paladinSwapEnabled: true` customers fail-closed within ~12 blocks (Base ~24s).
2. /v1/simulate continues serving but signed responses now have `epoch=currentEpoch` and customers verify `revoked[epoch] == true` → throw `RESPONSE_EPOCH_REVOKED`.
3. Customer-comms within 5min via §11 template "Emergency fail-close".
4. Resolution: investigate root cause; rotate per §5a; un-paused only after multi-day soak.

---

## 11. Customer-comms templates

**Channels (R12 Maint M-4 + Sec MED-2):**
- GitHub Discussions on `paladinfi/eliza-plugin-trust` repo (primary)
- Signed events.json feed (machine-readable; secondary)
- @paladin_fi on X (high-visibility broadcast for P0/P1)
- v0.3.0 traction-gate: customer email list (ETA TBD)

**3-adversary review checklist before publication** (per CLAUDE.md Adversarial Review Gate):
- Brand Auditor + Domain Skeptic + B2B Buyer roles for routine messages
- For emergency messages: Security + Brand Auditor + B2B Buyer; Security prompt MUST include "treat as audit not code review"

**T+7d handoff post-comment template (R12 retained):**
> **Release-window monitoring complete.** Window for v0.2.0 closed at T+7d. We monitored this Discussion thread with 48h response SLA from $POST_DATE through $T_PLUS_7D. From here on, this thread is in regular triage cadence (weekly). For active issues or new bug reports, please open a fresh Issue.

**Routine rotation complete template:**
> **Routine /v1/simulate rotation complete.** New signing-key pair active at on-chain epoch $EPOCH as of $TX_HASH. No customer action required; the plugin reads the new keys automatically via on-chain trust anchor. If you see `RESPONSE_EPOCH_MISMATCH` retried-and-resolved in your logs, that is the expected automatic re-sync behavior.

**Cloud account suspension template:**
> **Cloud-provider account suspension — $PROVIDER ($IMPACT).** $PROVIDER suspended access to our $KEY_NAME at $TIMESTAMP. We are working to restore service and will update this thread every 24h. **Mitigation for affected customers:** switch to `simulationVerifier: 'tenderly'` (see [README §If PaladinFi is unavailable](./README.md#if-paladinfi-is-unavailable)) OR `keyTrustMode: 'pinned'` if you've already pinned the current trust pair. Documented fail-closed window: 7-10 days per [THREAT_MODEL.md §8](./THREAT_MODEL.md). Updates: [link to status thread].

**Emergency revoke template:**
> **EMERGENCY: epoch $EPOCH revoked at $TX_HASH.** We have revoked the current /v1/simulate signing pair due to $REASON_REDACTED_OR_GENERAL. Any in-flight `paladin_swap` calls will fail with `RESPONSE_EPOCH_REVOKED`. **Customer action required:** none — the plugin will automatically pick up the next valid epoch once rotation completes (~7-day timelock from the new `proposeRotation`). If you have questions or believe you're affected by funds movement during the affected window, please contact $CONTACT_CHANNEL with your debug bundle (`paladinSwapDebug: true`).

**Emergency fail-close template:**
> **EMERGENCY: paladin_swap fail-close active.** All `paladinSwapEnabled: true` customers will receive `RESPONSE_EPOCH_REVOKED` until further notice. We have detected $REASON_REDACTED and are erring on the side of customer safety. **No customer action required.** We will post resolution in this thread. Status updates every 1h from $TIMESTAMP.

**Indexer outage template:**
> **Indexer outage (transparency paused).** events.json publication is paused due to $REASON. **Customer trust path is not affected** — the plugin verifies against on-chain `PaladinKeyRegistry` directly; events.json is a transparency mirror only. Resolution ETA: $ETA. Updates every 6h.

**Transparency paused (compromise rotation in progress):**
> **Indexer attestation key rotation in progress (precautionary).** We are rotating the indexer attestation key due to $REASON_GENERAL_NOT_REDACTED. events.json publication will resume after the 7-day timelock + finalize. Customer trust path is not affected. Resolution ETA: ~7 days from $TIMESTAMP.

**Multisig signer rotation (emergency):**
> **Multisig signer rotation (emergency).** We have rotated $N of the multisig signer set due to $REASON_GENERAL. Customer trust path is not affected — the multisig owns the registry contract but customers verify against per-epoch keys. New owner set on-chain at $TX_HASH; verifiable via Safe explorer at $LINK.

---

## 12. Doc-update discipline

**Every code change deployed to EC2 = same-session doc updates** per CLAUDE.md "Versioning Rules". For the eliza-plugin-trust npm package, this maps to:

- README.md — for any customer-visible behavior change
- THREAT_MODEL.md — for any trust-model change (any state of layer defenses, multisig threshold, KMS layout, fail-closed semantics)
- CHANGELOG.md — every release; semver bump; MUST-READ flag for breaking-trust changes
- This RUNBOOK.md — for any operational procedure change
- `paladinfi-contracts/audit-trail/` — every on-chain operational event
- `paladinfi-contracts/deployments.json` — every KMS-key change, multisig signer change, contract redeploy
- `_archive/` — historical plans (`PLAN_v0.2.0_v3.md` through `PLAN_v0.2.0_v10.md`); `PLAN_v0.2.0_v11.md` is current canonical

**Quarterly doc audit (`scripts/doc_audit.sh` cron, R12 Maint M-5 + R13 extension):**
- Verify README §17 callout is the first non-blank-line content of section 17
- Verify THREAT_MODEL.md last-modified date < 90 days OR trust-model unchanged in changelog
- Verify all _archive/ plan files have `_archive/` prefix in cross-references
- Verify `paladinfi-contracts/deployments.json` schema matches plan §4.1

---

## 13. Reference

### Plugin file paths

| File | Path |
|---|---|
| Plugin npm root | `D:\Documents\Business\AI\PaladinFi\eliza-plugin-trust\` |
| Plan (canonical) | `PLAN_v0.2.0_v11.md` |
| Test wallet env | `.env.local` (Account 4: `0x18779E5478...0aC1`; per CLAUDE.md memory `feedback_test_wallet_permanent.md`) |
| Plugin source | `src/` |
| Plugin tests | `tests/` |

### Server-side file paths (on EC2/VM hosts; written at Step 22-32 deploy)

| File | Path |
|---|---|
| Simulator service | `/opt/paladin/simulator/paladin_simulator_service.py` |
| Simulator env | `/etc/paladin/simulator.env` |
| Indexer service | `/opt/paladin/trust-services/paladin_simulator_indexer.py` |
| Indexer SQLite | `/var/lib/paladin/indexer.sqlite` |
| Indexer signing queue | `/var/lib/paladin/indexer_signing_queue.sqlite` |
| Retry-token store | `/var/lib/paladin/retry_tokens.sqlite` |
| Allowlist file | `/etc/paladin/iam-allowlist.json` |
| Decommissioner heartbeat | `/var/run/paladin/decommissioner.last_run` |
| iam-updater service | `/opt/paladin/trust-services/paladin_iam_updater.py` |
| Indexer attestation rotation script | `/opt/paladin/trust-services/scripts/rotate_indexer_attestation_key.py` |
| Decommissioner script | `/opt/paladin/trust-services/scripts/decommission_old_key.py` |
| Shared known RPC operators | `/opt/paladin/shared/known_rpc_operators.py` |

### systemd units

| Unit | Host | Notes |
|---|---|---|
| `paladin-simulator.service` | simulator EC2 | gunicorn + Anvil; lifespan handler |
| `paladin-indexer.service` | trust-services VM | starts FIRST (heartbeat receiver) |
| `paladin-iam-updater.service` | trust-services VM | `Requires=paladin-indexer.service`; ExecStartPre indexer heartbeat check |
| `paladin-decommissioner.service` | trust-services VM | cron-driven; ExecStartPre allowlist mtime check (24h fail-closed) |

### Per-service systemd hardening (Sec MED-1)

```ini
[Service]
User=paladin-{indexer,iam-updater,decommissioner}
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
NoNewPrivileges=true
RestrictNamespaces=true
RestrictRealtime=true
SystemCallFilter=@system-service
ReadWritePaths=/var/lib/paladin /var/log/paladin
```

### Cross-cutting references

- **PLAN canonical**: `PLAN_v0.2.0_v11.md` §4.13 (this RUNBOOK is its rendered operational form)
- **Project CLAUDE.md** (top-level): adversarial review gate, versioning rules, code conventions
- **REMINDERS.md** (top-level): infrastructure-capacity watch, DMARC ramp dates
- **ACCOUNTS.md** (top-level): vendor email mappings (DO NOT duplicate here; cross-reference)
- **CLOUD_SETUP.md** (this dir): pre-deploy cloud-account provisioning
- **THREAT_MODEL.md** (this dir): customer-facing threat disclosure
- **`paladinfi-contracts/`** (sibling dir): Solidity contract + Foundry tests + deployments.json + audit-trail

### Audit-trail file naming

`NNNN-{event}-{kind}-{epoch}-...md` — sequence-numbered, descriptive. Examples:
- `0001-placeholder-pre-deploy.md` (bootstrap discipline)
- `0002-deploy-base-mainnet.md` (Step 47 first deploy)
- `0003-rotation-key-1-epoch-1.md`
- `0004-rotation-key-2-epoch-1.md`
- `0005-rotation-key-3-epoch-1.md`
- `0006-cancellation-rotation-key-1-epoch-2.md`
- `0007-revoke-epoch-2.md`

Files are append-only. Corrections go in subsequent entries. Required fields per `audit-trail/0001-placeholder-pre-deploy.md`.
