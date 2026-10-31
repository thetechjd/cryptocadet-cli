// HTTP client for the server's treasury-facing payout endpoints. Auth is the shared
// `x-internal-secret` (server-to-operator), read from the environment, never from disk.

import type { PayoutInstruction, TreasuryClient } from './executor.js';

export function treasuryClient(baseUrl: string, internalSecret: string): TreasuryClient {
  const base = baseUrl.replace(/\/$/, '');
  const headers = { 'content-type': 'application/json', 'x-internal-secret': internalSecret };

  return {
    async claim(limit: number): Promise<PayoutInstruction[]> {
      const r = await fetch(`${base}/v4/internal/payouts/claim`, { method: 'POST', headers, body: JSON.stringify({ limit }) });
      if (!r.ok) throw new Error(`payouts/claim failed: ${r.status}`);
      return (await r.json()) as PayoutInstruction[];
    },
    async report(id, result): Promise<unknown> {
      const r = await fetch(`${base}/v4/internal/payouts/${encodeURIComponent(id)}/result`, {
        method: 'POST',
        headers,
        body: JSON.stringify(result),
      });
      if (!r.ok) throw new Error(`payouts/${id}/result failed: ${r.status}`);
      return r.json();
    },
  };
}
