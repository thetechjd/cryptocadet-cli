// HUMAN-ONLY verbs. These edit local policy / keys and are invoked ONLY from the CLI on
// the machine that holds the keys. They are NEVER registered on the agent transport.
// Policy is the sole enforcement; the dashboard renders it read-only and cannot call these.

import { getAddress } from 'ethers';
import type { Policy, AllowedToken } from '../types/policy.js';
import { emptyPolicy } from '../types/policy.js';
import { loadPolicy, savePolicy, policyExists } from '../config/policy-store.js';

function mutate(fn: (p: Policy) => void): Policy {
  const p = loadPolicy();
  fn(p);
  savePolicy(p);
  return p;
}

/** add to / update the token allowlist. v4 default: REJECT fee-on-transfer at allowlist time. */
export function editAllowlist(
  action: 'add' | 'remove',
  token: string,
  meta?: AllowedToken,
): Policy {
  const addr = token.toLowerCase();
  return mutate((p) => {
    if (action === 'remove') {
      delete p.allowlist[addr];
      return;
    }
    if (!meta) throw new Error('edit_allowlist add requires {symbol, decimals, feeOnTransfer}');
    if (meta.feeOnTransfer) throw new Error(`refusing fee-on-transfer token ${addr} (v4 rejects these at allowlist time)`);
    p.allowlist[addr] = meta;
  });
}

export function setRecipient(action: 'add' | 'remove', recipient: string): Policy {
  const addr = getAddress(recipient).toLowerCase(); // throws on malformed
  return mutate((p) => {
    const set = new Set(p.recipients.map((r) => r.toLowerCase()));
    if (action === 'add') set.add(addr);
    else set.delete(addr);
    p.recipients = [...set];
  });
}

export type LimitKind = 'perTx' | 'daily' | 'requireHumanAbove';

export function setLimit(kind: LimitKind, token: string, amount: string): Policy {
  const addr = token.toLowerCase();
  if (!/^\d+$/.test(amount)) throw new Error('amount must be a base-unit non-negative integer string');
  return mutate((p) => {
    if (kind === 'perTx') p.perTxCap[addr] = amount;
    else if (kind === 'daily') p.dailyCap[addr] = amount;
    else p.requireHumanAboveTx[addr] = amount;
  });
}

export function setReserve(token: string, amount: string): Policy {
  const addr = token.toLowerCase();
  if (!/^\d+$/.test(amount)) throw new Error('reserve must be a base-unit non-negative integer string');
  return mutate((p) => {
    p.subscriptionReserve[addr] = amount;
  });
}

/** Create a fresh deny-everything policy (used by init). */
export function initPolicy(chainId: Policy['chainId']): Policy {
  if (policyExists()) throw new Error('policy.json already exists; refusing to overwrite');
  const p = emptyPolicy(chainId);
  savePolicy(p);
  return p;
}
