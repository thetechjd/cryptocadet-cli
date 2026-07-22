import { JsonRpcProvider, Wallet } from 'ethers';
import type { Config } from '../config/config.js';

export function makeProvider(cfg: Pick<Config, 'rpcUrl' | 'chainId'>): JsonRpcProvider {
  // staticNetwork avoids an extra eth_chainId round-trip per call and pins the chain.
  return new JsonRpcProvider(cfg.rpcUrl, cfg.chainId, { staticNetwork: true });
}

export function makeWallet(privateKeyHex: string, provider: JsonRpcProvider): Wallet {
  return new Wallet(privateKeyHex, provider);
}

/** Confirmation depth before a payment is treated as settled. MUST be >= the v4 server's
 *  verifier depth (CONFIRMATION_DEPTH, default 6 on mainnet) — if the client finalizes at a
 *  shallower depth than the server accepts, the server 422s, records nothing, and the
 *  balance is never credited. Overridable per deployment via config.confirmationDepth. */
export function confirmationDepth(chainId: number, override?: number): number {
  if (override && Number.isInteger(override) && override > 0) return override;
  return chainId === 8453 ? 6 : 1; // mainnet matches server default; testnet is 1
}
