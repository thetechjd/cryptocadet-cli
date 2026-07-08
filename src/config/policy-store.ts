// Load/save policy.json. Policy is the SOLE enforcement and is local-authoritative.
// It is edited ONLY by human-only CLI verbs on the machine holding the keys. The
// dashboard renders it READ ONLY and cannot write it.

import { readFileSync, writeFileSync, existsSync, chmodSync } from 'node:fs';
import type { Policy } from '../types/policy.js';
import { paths } from './paths.js';
import { ensureRoot } from './config.js';

export function policyExists(): boolean {
  return existsSync(paths.policy());
}

function validate(p: Policy): Policy {
  if (p.version !== 1) throw new Error(`policy: unsupported version ${p.version}`);
  if (p.chainId !== 8453 && p.chainId !== 84532)
    throw new Error(`policy: unsupported chainId ${p.chainId}`);
  // Records may be empty (deny-everything is a valid, safe state) but must be objects.
  for (const k of ['allowlist', 'perTxCap', 'dailyCap', 'subscriptionReserve', 'requireHumanAboveTx'] as const) {
    if (typeof p[k] !== 'object' || p[k] === null) throw new Error(`policy: ${k} must be an object`);
  }
  if (!Array.isArray(p.recipients)) throw new Error('policy: recipients must be an array');
  return p;
}

export function loadPolicy(): Policy {
  return validate(JSON.parse(readFileSync(paths.policy(), 'utf8')) as Policy);
}

export function savePolicy(p: Policy): void {
  ensureRoot();
  validate(p);
  const file = paths.policy();
  writeFileSync(file, JSON.stringify(p, null, 2), { mode: 0o600 });
  chmodSync(file, 0o600);
}
