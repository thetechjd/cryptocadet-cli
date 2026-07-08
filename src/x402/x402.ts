// x402 PUSH-per-call client. When a resource server answers HTTP 402 Payment Required
// with a challenge, this maps the challenge onto the CryptoCadet flow — obtain a
// server-issued quote, PAY it through the local signer (which re-checks local policy),
// then retry the request with an X-PAYMENT proof header.
//
// Signing still happens ONLY behind the policy-gated signer; this module never touches a
// key. It is the transport glue an agent host uses around `quote_payment` + `pay`.

export interface PaymentRequirement {
  /** payment scheme, e.g. 'exact' or 'cryptocadet-v4' */
  scheme: string;
  /** network label ('base', 'base-sepolia') and/or an explicit chainId */
  network?: string;
  chainId?: number;
  /** ERC-20 asset (token contract), lowercased */
  asset: string;
  /** amount required, token base units (decimal string) */
  maxAmountRequired: string;
  /** recipient the resource wants paid */
  payTo: string;
  /** the protected resource (echoed for binding) */
  resource?: string;
}

export interface Challenge402 {
  x402Version?: number;
  accepts: PaymentRequirement[];
}

const NETWORK_CHAIN: Record<string, number> = {
  base: 8453,
  'base-mainnet': 8453,
  'base-sepolia': 84532,
  'base-testnet': 84532,
};

/** Resolve a requirement's chain id from an explicit chainId or a known network label. */
export function requirementChainId(req: PaymentRequirement): number | null {
  if (typeof req.chainId === 'number') return req.chainId;
  if (req.network && NETWORK_CHAIN[req.network.toLowerCase()] !== undefined) return NETWORK_CHAIN[req.network.toLowerCase()]!;
  return null;
}

/** Parse a 402 response body into a challenge. Accepts `{ accepts: [...] }` (x402 shape). */
export async function parseChallenge(res: Response): Promise<Challenge402> {
  let body: unknown;
  try {
    body = await res.clone().json();
  } catch {
    throw new Error('x402: 402 response had no JSON challenge body');
  }
  const b = body as { accepts?: unknown; x402Version?: number };
  if (!Array.isArray(b.accepts) || b.accepts.length === 0) throw new Error('x402: challenge missing `accepts` requirements');
  return {
    accepts: b.accepts as PaymentRequirement[],
    ...(b.x402Version !== undefined ? { x402Version: b.x402Version } : {}),
  };
}

/** Pick the first requirement payable on our chain. */
export function selectRequirement(challenge: Challenge402, chainId: number): PaymentRequirement | null {
  return challenge.accepts.find((r) => requirementChainId(r) === chainId) ?? null;
}

/** The X-PAYMENT proof header value the client sends on retry (base64 JSON). */
export function buildPaymentProof(quoteId: string, txHash: string): string {
  const proof = { scheme: 'cryptocadet-v4', quoteId, txHash };
  return Buffer.from(JSON.stringify(proof), 'utf8').toString('base64');
}

export interface PaySettlement {
  status: string; // 'CONFIRMED' on success
  txHash?: string;
  reason?: string;
}

export interface X402Deps {
  /** the client's configured chain (8453 / 84532) */
  chainId: number;
  /** obtain a server-issued quote id for a requirement (proxies to quote_payment) */
  quoteFor: (req: PaymentRequirement) => Promise<{ quoteId: string }>;
  /** execute a quote via the local policy-gated signer */
  pay: (quoteId: string) => Promise<PaySettlement>;
  /** injectable fetch (defaults to global) */
  fetchImpl?: typeof fetch;
}

export interface X402Result {
  response: Response;
  paid: boolean;
  quoteId?: string;
  txHash?: string;
}

/**
 * Fetch a resource, transparently settling an x402 challenge if one is returned. If the
 * first response is not 402, it is returned as-is (no payment). On 402 it obtains a quote,
 * pays it (policy-gated), and retries once with the proof header.
 */
export async function fetchWithPayment(
  url: string,
  init: RequestInit,
  deps: X402Deps,
): Promise<X402Result> {
  const doFetch = deps.fetchImpl ?? fetch;

  const first = await doFetch(url, init);
  if (first.status !== 402) return { response: first, paid: false };

  const challenge = await parseChallenge(first);
  const req = selectRequirement(challenge, deps.chainId);
  if (!req) throw new Error(`x402: no requirement payable on chain ${deps.chainId}`);

  const { quoteId } = await deps.quoteFor(req);
  const settlement = await deps.pay(quoteId);
  if (settlement.status !== 'CONFIRMED' || !settlement.txHash) {
    // Do NOT retry on a refusal/escalation/failure — the policy engine or chain rejected it.
    throw new Error(`x402: payment not settled (${settlement.reason ?? settlement.status})`);
  }

  const headers: Record<string, string> = {
    ...((init.headers as Record<string, string>) ?? {}),
    'X-PAYMENT': buildPaymentProof(quoteId, settlement.txHash),
  };
  const response = await doFetch(url, { ...init, headers });
  return { response, paid: true, quoteId, txHash: settlement.txHash };
}
