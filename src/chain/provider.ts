import { JsonRpcProvider, Wallet } from 'ethers';
import type { Config } from '../config/config.js';

export function makeProvider(cfg: Pick<Config, 'rpcUrl' | 'chainId'>): JsonRpcProvider {
  // staticNetwork avoids an extra eth_chainId round-trip per call and pins the chain.
  return new JsonRpcProvider(cfg.rpcUrl, cfg.chainId, { staticNetwork: true });
}

export function makeWallet(privateKeyHex: string, provider: JsonRpcProvider): Wallet {
  return new Wallet(privateKeyHex, provider);
}

/** Confirmation depth before a payment is treated as settled. Conservative defaults;
 *  Base has fast blocks. Overridable per deployment if the v3 harvest says otherwise. */
export function confirmationDepth(chainId: number): number {
  return chainId === 8453 ? 3 : 1; // mainnet vs testnet
}
