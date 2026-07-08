// Subscription setup: the buyer's capped on-chain approval that a `subscription_setup`
// quote drives. Granting `approve(collector, cap)` delegates PULL authority to the seller's
// collector up to `cap` — this bypasses the per-call policy engine (which only gates the
// agent's own transfers, not a third party's transferFrom), so the CAP is the enforcement.
//
// Therefore this is HUMAN-ONLY (a CLI verb, never the agent surface), the human chooses the
// cap deliberately, and rotate/sweep invalidate the grant (the approval lives on the old
// wallet). Revoke = approve(collector, 0).

import { getAddress } from 'ethers';
import type { Policy } from '../types/policy.js';

/** Validate a grant against local policy. Throws (fail-closed) on anything off. */
export function validateGrant(policy: Policy, token: string, cap: string): void {
  const t = token.toLowerCase();
  if (!policy.allowlist[t]) throw new Error(`token not allowlisted: ${t}`);
  if (policy.allowlist[t]!.feeOnTransfer) throw new Error(`fee-on-transfer token not supported: ${t}`);
  if (!/^[1-9][0-9]*$/.test(cap)) throw new Error('cap must be a positive base-unit integer string');
}

export interface GrantDeps {
  policy: Policy;
  /** signs approve(spender, amount); injected so this is testable without a chain */
  approve: (token: string, spender: string, amount: string) => Promise<{ txHash: string }>;
}

export interface GrantRequest {
  token: string;
  collector: string;
  cap: string; // base units
}

export interface GrantReport {
  token: string;
  collector: string;
  cap: string;
  txHash: string;
}

/** Grant a capped approval to a subscription collector. */
export async function grantSubscriptionApproval(deps: GrantDeps, req: GrantRequest): Promise<GrantReport> {
  validateGrant(deps.policy, req.token, req.cap);
  let collector: string;
  try {
    collector = getAddress(req.collector);
  } catch {
    throw new Error(`malformed collector address: ${req.collector}`);
  }
  const token = req.token.toLowerCase();
  const { txHash } = await deps.approve(token, collector, req.cap);
  return { token, collector, cap: req.cap, txHash };
}

/** Revoke a collector's approval (set allowance to 0). Does not require a positive cap. */
export async function revokeSubscriptionApproval(
  deps: Pick<GrantDeps, 'approve'>,
  req: { token: string; collector: string },
): Promise<GrantReport> {
  let collector: string;
  try {
    collector = getAddress(req.collector);
  } catch {
    throw new Error(`malformed collector address: ${req.collector}`);
  }
  const token = req.token.toLowerCase();
  const { txHash } = await deps.approve(token, collector, '0');
  return { token, collector, cap: '0', txHash };
}
