/**
 * The deployed ERC8056Guard and the RPC it is read through. Kept free of imports so pages can
 * print these without pulling viem into their bundle; the reader itself lives in ./wallet-check
 * and is loaded only when someone presses Check.
 */
export const GUARD_ADDRESS = '0x674f9b0eC3C3643c1f51c0a40D4837932F9c1648'
export const RH_RPC_URL = 'https://rpc.mainnet.chain.robinhood.com'
/** A neutral demo: the common burn address holds dust of about twenty divergent tokens. */
export const BURN_ADDRESS = '0x000000000000000000000000000000000000dEaD'
