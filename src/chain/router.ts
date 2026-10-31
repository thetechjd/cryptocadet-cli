// Routed payment primitive: approve the pinned router for EXACTLY this payment, then call
// payWithToken with the quoteId appended to the calldata (Solidity ignores trailing bytes;
// the server uses them to bind the tx to one quote). Called only from the live broadcaster,
// i.e. the tail of the single policy-gated signing path.

import { Contract, Interface, type TransactionResponse, type Wallet } from 'ethers';
import { ERC20_ABI } from './erc20.js';

const ROUTER_IFACE = new Interface(['function payWithToken(address _payee, address _token, uint256 _amount) returns (bool)']);

/** The 16 quoteId bytes as hex (no 0x) — the calldata suffix the server checks. */
export function quoteIdSuffix(quoteId: string): string {
  const hex = quoteId.replace(/-/g, '').toLowerCase();
  if (!/^[0-9a-f]{32}$/.test(hex)) throw new Error(`routed payment needs a uuid quoteId, got ${quoteId}`);
  return hex;
}

export function routedPaymentData(payee: string, token: string, amount: string, quoteId: string): string {
  return ROUTER_IFACE.encodeFunctionData('payWithToken', [payee, token, BigInt(amount)]) + quoteIdSuffix(quoteId);
}

export async function sendRoutedPayment(
  wallet: Wallet,
  router: string,
  token: string,
  payee: string,
  amount: string,
  quoteId: string,
): Promise<TransactionResponse> {
  const data = routedPaymentData(payee, token, amount, quoteId); // validates the quoteId first
  const erc20 = new Contract(token, ERC20_ABI, wallet);
  const allowance = (await erc20.allowance!(wallet.address, router)) as bigint;
  // Exact, per-payment approval. A leftover allowance (e.g. an approve whose payment then
  // failed) is reused rather than topped up, so the router never holds more than one payment.
  if (allowance < BigInt(amount)) {
    const approval = (await erc20.approve!(router, BigInt(amount))) as TransactionResponse;
    const receipt = await approval.wait(1);
    if (!receipt || receipt.status !== 1) throw new Error('router approval reverted');
  }
  return wallet.sendTransaction({ to: router, data });
}
