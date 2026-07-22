// Wires the abstract Broadcaster/readBalance to real ethers signing with the agent
// hot-wallet key. This is the production implementation injected into PaymentSigner.

import type { JsonRpcProvider, Wallet } from 'ethers';
import { sendTransfer, tokenBalance } from '../chain/erc20.js';
import type { Broadcaster, BroadcastResult } from './signer.js';

export function liveReadBalance(provider: JsonRpcProvider, agentAddress: string) {
  return (token: string): Promise<string> => tokenBalance(provider, token, agentAddress);
}

/** `beforeSend` runs once, immediately before the transfer is signed — used to top up gas
 *  (USDC→ETH) when the wallet is short. It is NOT a second payment call site: it never signs a
 *  merchant transfer. If it throws (e.g. gas cannot be secured), the transfer is not sent and
 *  the error surfaces as a normal broadcast failure with a clear reason. */
export function liveBroadcaster(wallet: Wallet, beforeSend?: () => Promise<void>): Broadcaster {
  return async (token, recipient, amount): Promise<BroadcastResult> => {
    if (beforeSend) await beforeSend();
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
