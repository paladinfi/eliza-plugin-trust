/**
 * Prompt template for natural-language extraction of paladin_swap parameters.
 *
 * Same pattern as templates/trust-check.ts (v0.1.0): the handler runs
 * `composePromptFromState({ state, template })` then `runtime.useModel(...)`
 * then `parseKeyValueXml`.
 *
 * The model emits a strict key-value-XML block. Anything that can't be
 * extracted comes back as `<field>none</field>`, which the handler treats
 * as "could not extract; ask the user."
 *
 * IMPORTANT — fields explicitly NOT extracted:
 *   - `onTrustBlock` (block | report) — factory-time only per v11 §4.4.
 *     Even if the user says "yes block this swap" we ignore it; per-call
 *     mode is tightening-only and the LLM cannot loosen the factory's choice.
 *   - `acknowledgeRisks` — factory-time only. The LLM cannot ack risks
 *     on the customer's behalf.
 *   - `taker` — derived from `walletClientAccount.address`, not user input.
 *     We DO ask the LLM to extract any explicit address mentioned, then
 *     enforce taker === wallet.address at handler step 4 (INVALID_TAKER).
 *
 * Token symbol mapping: the LLM is given a per-symbol → canonical Base
 * address map for the 7 v0.2.0-supported tokens (USDC, USDT, WETH, cbBTC,
 * DAI, AERO, USDbC). Anything else extracts as `none` and the handler
 * fails at step 5 (TOKEN_NOT_SUPPORTED).
 *
 * `sellAmount` is extracted in human units (e.g., "100 USDC" → "100"); the
 * handler converts to base units using `TOKEN_REGISTRY[token].decimals`
 * before the cap check at step 6.
 */

export const paladinSwapTemplate = `You are extracting parameters for a swap on Base (chain-id 8453) via PaladinFi's paladin_swap action.

Conversation context:
{{recentMessages}}

The user wants to swap one ERC-20 token for another on Base. From the most recent message, extract:

- **sellTokenSymbol**: the token the user wants to swap FROM. Must be one of: USDC, USDT, WETH, cbBTC, DAI, AERO, USDbC. If unclear or unsupported, output \`none\`.
- **buyTokenSymbol**: the token the user wants to swap TO. Same supported set. Must differ from sellTokenSymbol. If unclear, output \`none\`.
- **sellAmount**: the human-readable quantity of sellToken to sell. E.g., "100 USDC" → \`100\`, "0.5 WETH" → \`0.5\`. Output as a decimal string. If unclear, output \`none\`.
- **chainId**: the EIP-155 chain id. PaladinFi v0.2.0 supports Base only (8453). If user mentions another chain, output \`none\` (the handler will reject with TOKEN_NOT_SUPPORTED). If unclear or Base-implied, output \`8453\`.
- **takerAddress**: optional. If the user explicitly mentions an address that should be the taker/from-address, extract it (must be 0x-prefixed 40-hex). The handler enforces it equals the configured wallet address. If no address is mentioned, output \`none\`.

Token symbol → canonical Base address (for the model's reference; do NOT include in output):
- USDC: 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913
- USDT: 0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2
- WETH: 0x4200000000000000000000000000000000000006
- cbBTC: 0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf
- DAI: 0x50c5725949A6F0c72E6C4a641F24049A917DB0Cb
- AERO: 0x940181a94A35A4569E4529A3CDfB74e38FD98631
- USDbC: 0xd9AAEc86B65D86f6A7B5B1b0c42FFA531710b6CA

DO NOT extract: trust-block mode, risk acknowledgement, slippage, deadline, or any onTrustBlock/acknowledgeRisks field. These are factory-time configuration set by the agent operator, not user input.

Respond with ONLY this XML block, no prose:

<response>
<sellTokenSymbol>USDC</sellTokenSymbol>
<buyTokenSymbol>WETH</buyTokenSymbol>
<sellAmount>100</sellAmount>
<chainId>8453</chainId>
<takerAddress>none</takerAddress>
</response>
`;
