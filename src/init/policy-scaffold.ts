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

export function scaffoldPolicy(chainId: 8453 | 84532): Policy {
  const usdc = USDC_BY_CHAIN[chainId];
  const p = emptyPolicy(chainId);
  p.allowlist[usdc] = { symbol: 'USDC', decimals: 6, feeOnTransfer: false };
  p.perTxCap[usdc] = DEFAULTS.perTx;
  p.dailyCap[usdc] = DEFAULTS.daily;
  p.subscriptionReserve[usdc] = DEFAULTS.reserve;
  p.requireHumanAboveTx[usdc] = DEFAULTS.humanAbove;
  // recipients stays [] on purpose — fail closed until the user adds a payee.
  return p;
}
