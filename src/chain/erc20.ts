// ERC-20 read + transfer. No native-token spending, ever (native is only drained last
// during sweep). All amounts are BigInt / base-unit strings — no floats in the money path.

import { Contract, Interface, type JsonRpcProvider, type Wallet, type TransactionResponse } from 'ethers';

export const ERC20_ABI = [
  'function balanceOf(address owner) view returns (uint256)',
  'function decimals() view returns (uint8)',
  'function symbol() view returns (string)',
  'function transfer(address to, uint256 amount) returns (bool)',
  'function transferFrom(address from, address to, uint256 amount) returns (bool)',
  'function approve(address spender, uint256 amount) returns (bool)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'event Transfer(address indexed from, address indexed to, uint256 value)',
];

export const erc20Interface = new Interface(ERC20_ABI);

/** On-chain token balance for an address, as a base-unit decimal string. */
export async function tokenBalance(
  provider: JsonRpcProvider,
  token: string,
  owner: string,
): Promise<string> {
  const c = new Contract(token, ERC20_ABI, provider);
  const bal = (await c.balanceOf!(owner)) as bigint;
  return bal.toString();
}

export async function tokenMeta(
  provider: JsonRpcProvider,
  token: string,
): Promise<{ symbol: string; decimals: number }> {
  const c = new Contract(token, ERC20_ABI, provider);
  const [symbol, decimals] = await Promise.all([c.symbol!() as Promise<string>, c.decimals!() as Promise<bigint>]);
  return { symbol, decimals: Number(decimals) };
}

/** Sign & broadcast an ERC-20 transfer. Returns the tx response (not yet confirmed).
 *  `amount` is a base-unit decimal string. The wallet must be the agent hot wallet. */
export async function sendTransfer(
  wallet: Wallet,
  token: string,
  recipient: string,
  amount: string,
): Promise<TransactionResponse> {
  const c = new Contract(token, ERC20_ABI, wallet);
  return (await c.transfer!(recipient, BigInt(amount))) as TransactionResponse;
}

/** Sign & broadcast an ERC-20 `approve(spender, amount)` — the capped grant that lets a
 *  subscription collector `transferFrom` up to `amount`. `amount` is base units; '0'
 *  revokes. HUMAN-ONLY: this delegates pull authority and is never on the agent surface. */
export async function approveToken(
  wallet: Wallet,
  token: string,
  spender: string,
  amount: string,
): Promise<TransactionResponse> {
  const c = new Contract(token, ERC20_ABI, wallet);
  return (await c.approve!(spender, BigInt(amount))) as TransactionResponse;
}

/** Remaining allowance owner→spender, base-unit string (the collector's pull ceiling). */
export async function tokenAllowance(
  provider: JsonRpcProvider,
  token: string,
  owner: string,
  spender: string,
): Promise<string> {
  const c = new Contract(token, ERC20_ABI, provider);
  const a = (await c.allowance!(owner, spender)) as bigint;
  return a.toString();
}

/** Collector-side pull: sign `transferFrom(from, to, amount)` with the collector (spender)
 *  wallet. Bounded on-chain by the buyer's approval — the chain rejects anything above it. */
export async function sendTransferFrom(
  wallet: Wallet,
  token: string,
  from: string,
  to: string,
  amount: string,
): Promise<TransactionResponse> {
  const c = new Contract(token, ERC20_ABI, wallet);
  return (await c.transferFrom!(from, to, BigInt(amount))) as TransactionResponse;
}
