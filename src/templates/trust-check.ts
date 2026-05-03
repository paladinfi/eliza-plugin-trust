/**
 * Prompt template for natural-language extraction of trust-check parameters.
 *
 * The handler runs `composePromptFromState({ state, template })` then
 * `runtime.useModel(ModelType.TEXT_SMALL, { prompt })` then `parseKeyValueXml`
 * — same pattern as @elizaos/plugin-evm/transfer.ts and other v2-alpha plugins.
 *
 * The model is instructed to emit a strict key-value-XML block. Anything that
 * isn't a valid EVM hex address must come back as `<address>none</address>`,
 * which the handler treats as "could not extract; ask the user."
 *
 * Note: the extracted address is REQUEST INPUT to the trust-check call. It is
 * NOT signed over and cannot redirect a payment — payment fields (treasury,
 * asset, amount) are validated against hard-coded constants in the pre-sign hook.
 */

export const trustCheckTemplate = `You are extracting parameters for a token trust-check on an EVM chain.

Conversation context:
{{recentMessages}}

The user wants to verify the safety of a token contract before trading it. From the most recent message, extract:

- **address**: the EVM token contract address the user wants checked. Must be a valid 0x-prefixed 40-hex-character address. If no address is mentioned or the value is not a valid 0x... address, output \`none\`.
- **chainId**: the EIP-155 chain id. If the user mentions Base, output 8453. If they mention Ethereum mainnet, output 1. If unclear, output 8453 (Base — PaladinFi's primary supported chain).
- **taker**: optional. The address that will swap/buy the token. Only populate if a SECOND address is explicitly given as the buyer/taker. Otherwise output \`none\`.

Respond with ONLY this XML block, no prose:

<response>
<address>0x...</address>
<chainId>8453</chainId>
<taker>none</taker>
</response>
`;
