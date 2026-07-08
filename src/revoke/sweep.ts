// Sweep — the revocation drain. HUMAN-ONLY; never on the agent transport.
//
// Sweep MUST be balance-discovery-driven, not config-list-driven. A config-list sweep
// leaves behind exactly the forgotten long-tail token an attacker would take. We
// discover tokens by scanning inbound ERC-20 Transfer logs to the agent wallet, then
// drain every token with a positive current balance, and drain native gas LAST so
// nothing is left recoverable.

import { Contract, getAddress, id as keccakId, zeroPadValue, type JsonRpcProvider, type Wallet } from 'ethers';
import { ERC20_ABI } from '../chain/erc20.js';

const TRANSFER_TOPIC = keccakId('Transfer(address,address,uint256)');

export interface SweepResultToken {
  token: string;
  symbol: string;
  amount: string; // base units swept
  txHash: string;
}

export interface SweepReport {
  to: string;
  tokens: SweepResultToken[];
  native: { amount: string; txHash: string } | null;
  discovered: string[]; // every candidate token contract discovered
}

export interface SweepOptions {
  /** Block to scan logs from. Default 0 (full history) — correctness over RPC cost; a
   *  forgotten token funded once must still be found. Override for known-young wallets. */
  fromBlock?: number;
  /** Max block span per getLogs call (some RPCs cap this). */
  logChunk?: number;
}

/** Discover every ERC-20 contract that has ever sent tokens TO the agent wallet. */
export async function discoverTokens(
  provider: JsonRpcProvider,
  agentAddress: string,
  opts: SweepOptions = {},
): Promise<string[]> {
  const to = getAddress(agentAddress);
  const toTopic = zeroPadValue(to, 32).toLowerCase();
  const latest = await provider.getBlockNumber();
  const from = opts.fromBlock ?? 0;
  const chunk = opts.logChunk ?? 50_000;
  const found = new Set<string>();
  for (let start = from; start <= latest; start += chunk) {
    const end = Math.min(start + chunk - 1, latest);
    const logs = await provider.getLogs({
      fromBlock: start,
      toBlock: end,
      topics: [TRANSFER_TOPIC, null, toTopic], // any from, to == agent
    });
    for (const log of logs) found.add(log.address.toLowerCase());
  }
  return [...found];
}

/** Drain all discovered tokens, then native gas. Returns a full report of what moved. */
export async function sweep(
  provider: JsonRpcProvider,
  wallet: Wallet,
  to: string,
  opts: SweepOptions = {},
): Promise<SweepReport> {
  const agent = await wallet.getAddress();
  const dest = getAddress(to);
  const discovered = await discoverTokens(provider, agent, opts);

  const swept: SweepResultToken[] = [];
  for (const token of discovered) {
    const c = new Contract(token, ERC20_ABI, wallet);
    const bal = (await c.balanceOf!(agent)) as bigint;
    if (bal <= 0n) continue;
    let symbol = '?';
    try {
      symbol = (await c.symbol!()) as string;
    } catch {
      /* non-standard token without symbol(); still sweep it */
    }
    const tx = await c.transfer!(dest, bal); // human-only revocation transfer
    await tx.wait();
    swept.push({ token, symbol, amount: bal.toString(), txHash: tx.hash });
  }

  // Drain native gas LAST — leave nothing recoverable.
  let native: SweepReport['native'] = null;
  const nativeBal = await provider.getBalance(agent);
  if (nativeBal > 0n) {
    const feeData = await provider.getFeeData();
    const gasPrice = feeData.maxFeePerGas ?? feeData.gasPrice ?? 0n;
    const gasLimit = 21_000n;
    const cost = gasPrice * gasLimit;
    if (nativeBal > cost) {
      const value = nativeBal - cost;
      const tx = await wallet.sendTransaction({ to: dest, value, gasLimit });
      await tx.wait();
      native = { amount: value.toString(), txHash: tx.hash };
    }
  }

  return { to: dest, tokens: swept, native, discovered };
}
