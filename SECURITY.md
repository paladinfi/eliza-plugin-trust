# Security Policy

## Reporting a Vulnerability

If you discover a security issue in `@paladinfi/eliza-plugin-trust` or in the hosted PaladinFi endpoints this plugin calls, please email **[dev@paladinfi.com](mailto:dev@paladinfi.com)** with:

- A clear description of the issue + reproduction steps
- The affected action, factory option, file path, or HTTP call path
- Any logs, error responses, or proof-of-concept
- Whether the issue has been disclosed publicly elsewhere

We aim to acknowledge within **5 business days** and provide a triage update within **7 days**. Please do **not** open a public Issue for security-relevant findings.

PaladinFi operates with a small engineering team. We do not currently run a bug bounty.

## Scope

In scope:

- The `@paladinfi/eliza-plugin-trust` npm package and its source in this repository (`src/`)
- The PaladinFi endpoints this plugin calls: `swap.paladinfi.com/v1/trust-check` (paid) and `swap.paladinfi.com/v1/trust-check/preview` (free)
- The x402 pre-sign validation hooks (`src/x402/validate.ts`) and the hard-coded constants they enforce (Base USDC contract, PaladinFi treasury address, max amount, EIP-3009 only)
- The smoke-test scripts in this repository

Out of scope:

- Issues in `@elizaos/core`, `@x402/*`, `viem`, or other upstream dependencies — please report to those projects directly
- Issues that require a malicious customer to opt themselves into harm (e.g., disabling the pre-sign validation in a fork of this package, supplying a wallet provider that returns wrong addresses)
- Customer-specific OFAC / GoPlus / Etherscan data quality — these are external feeds; correctness disputes go to the source provider
- Bus-factor / single-admin concerns documented as known limitations in [`THREAT_MODEL.md`](THREAT_MODEL.md) (when v0.2.0 ships) and the README — these are operational, not technical, and tracked separately

## Disclosure

After a fix ships, we publish a CHANGELOG entry describing the issue, the fix, and the affected versions. If you reported the issue, we credit you by handle (with your permission) in the CHANGELOG.

## Sister package

`@paladinfi/agentkit-actions` ships the same trust-check semantic for Coinbase AgentKit agents and shares the security architecture (pre-sign hard constants, scrubbed errors). Vulnerabilities affecting both packages can be reported once via this channel — we'll patch in lockstep. See https://github.com/paladinfi/agentkit-actions/blob/main/SECURITY.md (when published).
