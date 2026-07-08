// Wires the abstract Broadcaster/readBalance to real ethers signing with the agent
// hot-wallet key. This is the production implementation injected into PaymentSigner.

import type { JsonRpcProvider, Wallet } from 'ethers';
import { sendTransfer, tokenBalance } from '../chain/erc20.js';
import type { Broadcaster, BroadcastResult } from './signer.js';

export function liveReadBalance(provider: JsonRpcProvider, agentAddress: string) {
  return (token: string): Promise<string> => tokenBalance(provider, token, agentAddress);
}

export function liveBroadcaster(wallet: Wallet): Broadcaster {
  return async (token, recipient, amount): Promise<BroadcastResult> => {
    const tx = await sendTransfer(wallet, token, recipient, amount); // <- the actual key signature
    return {
      txHash: tx.hash,
      wait: async (confirmations) => {
        const receipt = await tx.wait(confirmations);
        if (!receipt) return 'failed';
        return receipt.status === 1 ? 'confirmed' : 'failed';
      },
    };
  };
}
