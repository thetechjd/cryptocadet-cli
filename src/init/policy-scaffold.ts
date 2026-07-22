// Conservative, FAIL-CLOSED policy scaffold written on first init. USDC on the chosen Base
// network is allowlisted with LOW caps, but the recipient allowlist is EMPTY — so an
// un-edited policy can quote and dry-run yet cannot pay anyone until the user adds a payee
// with `cryptocadet allowlist:add --kind recipient`.

import type { Policy } from '../types/policy.js';
import { emptyPolicy } from '../types/policy.js';

/** Canonical USDC contract per Base network (lowercased), 6 decimals. */
export const USDC_BY_CHAIN: Record<8453 | 84532, string> = {
  8453: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
  84532: '0x036cbd53842c5426634e7929541ec2318f3dcf7e',
};

// Conservative first-run caps (USDC base units, 6 decimals).
const DEFAULTS = {
  perTx: '1000000', // 1.00 USDC
  daily: '5000000', // 5.00 USDC
  reserve: '0',
  humanAbove: '500000', // 0.50 USDC — escalate above this
};

// Conservative gas top-up defaults. Base gas is fractions of a cent, so a few ten-thousandths
// of an ETH covers many transfers; the USDC ceiling caps a single swap's spend. Enabled by
// default so an ERC-20-only wallet can actually pay its own gas out of the box.
const GAS_SWAP_DEFAULTS = {
  minWei: '100000000000000', // 0.0001 ETH — below this, top up before signing
  targetWei: '400000000000000', // 0.0004 ETH — swap targets this balance
  maxUsdcPerSwap: '2000000', // 2.00 USDC — hard ceiling per gas swap
};

export function scaffoldPolicy(chainId: 8453 | 84532): Policy {
  const usdc = USDC_BY_CHAIN[chainId];
  const p = emptyPolicy(chainId);
  p.allowlist[usdc] = { symbol: 'USDC', decimals: 6, feeOnTransfer: false };
  p.perTxCap[usdc] = DEFAULTS.perTx;
  p.dailyCap[usdc] = DEFAULTS.daily;
  p.subscriptionReserve[usdc] = DEFAULTS.reserve;
  p.requireHumanAboveTx[usdc] = DEFAULTS.humanAbove;
  p.gasSwap = { enabled: true, ...GAS_SWAP_DEFAULTS };
  // recipients stays [] on purpose — fail closed until the user adds a payee.
  return p;
}
