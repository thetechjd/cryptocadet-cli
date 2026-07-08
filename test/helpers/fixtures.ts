import { getAddress, Wallet } from 'ethers';
import type { Policy } from '../../src/types/policy.js';
import type { Broadcaster, BroadcastResult } from '../../src/signer/signer.js';

// USDC on Base (6 decimals). 1_000000 == 1.00 USDC.
export const USDC = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
export const SELLER = getAddress('0x1111111111111111111111111111111111111111');
export const ATTACKER = getAddress('0x2222222222222222222222222222222222222222');
export const RANDOM_TOKEN = '0x3333333333333333333333333333333333333333';

export function policyWithUsdc(over: Partial<Policy> = {}): Policy {
  return {
    version: 1,
    chainId: 8453,
    allowlist: { [USDC]: { symbol: 'USDC', decimals: 6, feeOnTransfer: false } },
    recipients: [SELLER.toLowerCase()],
    perTxCap: { [USDC]: '10000000' }, // 10 USDC
    dailyCap: { [USDC]: '50000000' }, // 50 USDC
    subscriptionReserve: { [USDC]: '20000000' }, // 20 USDC reserved
    requireHumanAboveTx: { [USDC]: '5000000' }, // escalate above 5 USDC
    ...over,
  };
}

/** A broadcaster that records every call (i.e. every signature) and confirms instantly. */
export function recordingBroadcaster(opts: { outcome?: 'confirmed' | 'failed'; throwOnSend?: boolean } = {}) {
  const calls: Array<{ token: string; recipient: string; amount: string }> = [];
  let n = 0;
  const broadcast: Broadcaster = async (token, recipient, amount): Promise<BroadcastResult> => {
    if (opts.throwOnSend) throw new Error('rpc down');
    calls.push({ token, recipient, amount });
    n += 1;
    const txHash = `0xtx${n}`;
    return { txHash, wait: async () => opts.outcome ?? 'confirmed' };
  };
  return { broadcast, calls };
}

export function randomAgentWallet(): Wallet {
  return Wallet.createRandom();
}
