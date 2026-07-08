// HTTP client for the server's collector-facing pull endpoints. Auth is the shared
// `x-internal-secret` (server-to-collector), NOT a per-account API key — the collector is
// trusted rail infrastructure. The secret is read from the environment, never from disk.

import type { PullClient, PullInstruction } from './executor.js';

export function collectorClient(baseUrl: string, internalSecret: string): PullClient {
  const base = baseUrl.replace(/\/$/, '');
  const headers = { 'content-type': 'application/json', 'x-internal-secret': internalSecret };

  return {
    async pending(): Promise<PullInstruction[]> {
      const r = await fetch(`${base}/v4/internal/pulls/pending`, { headers });
      if (!r.ok) throw new Error(`pulls/pending failed: ${r.status}`);
      return (await r.json()) as PullInstruction[];
    },
    async report(id, result): Promise<unknown> {
      const r = await fetch(`${base}/v4/internal/pulls/${encodeURIComponent(id)}/result`, {
        method: 'POST',
        headers,
        body: JSON.stringify(result),
      });
      if (!r.ok) throw new Error(`pulls/${id}/result failed: ${r.status}`);
      return r.json();
    },
  };
}
