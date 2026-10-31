// Fetch a URL, settling an HTTP 402 if one comes back. The ONE implementation behind the
// agent tool `fetch_paid` and the human `fetch` verb.
//
// Payment never bypasses the gate: the USDC rail pays only via PaymentSigner.pay() (serverSig
// check + local policy, the single gated broadcast). The credits rail signs nothing; it
// sends the agent token, and only to the configured CryptoCadet origin (creditsOrigins),
// where the server enforces the token's per-call / daily caps.

import type { PaymentSigner, PayResult } from '../signer/signer.js';
import type { QuoteClient } from '../server/client.js';
import { fetchWithPayment, type PaySettlement, type PaymentRequirement } from './x402.js';

export interface PaidFetchDeps {
  chainId: number;
  signer: Pick<PaymentSigner, 'pay'>;
  server: QuoteClient;
  /** read lazily so a token created after the runtime started is picked up */
  agentToken: () => Promise<string | null>;
  creditsOrigins: readonly string[];
  fetchImpl?: typeof fetch;
  /** Confirm a payment above the policy's requireHumanAbove threshold (human `fetch --approve`). */
  humanApproved?: boolean;
}

export interface PaidFetchArgs {
  url: string;
  method?: string;
  body?: string;
  headers?: Record<string, string>;
}

export interface PaidFetchResult {
  status: number;
  paid: boolean;
  rail: 'credits' | 'usdc' | null;
  quoteId?: string;
  txHash?: string;
  /** micro-USD charged on the credits rail (X-CryptoCadet-Charged), when reported */
  charged?: string;
  contentType: string | null;
  body: string;
  truncated: boolean;
}

const MAX_BODY = 64 * 1024;
// Never let the caller smuggle payment credentials into the request themselves.
const RESERVED_HEADERS = new Set(['x-cryptocadet-agent', 'x-payment', 'authorization']);

/** Turn a policy refusal into the command that resolves it. */
function withHint(reason: string): string {
  const m = reason.match(/^recipient not allowlisted (0x[0-9a-fA-F]{40})/);
  if (m) return `${reason}. To trust this seller: cryptocadet allowlist:add --kind recipient --address ${m[1]}`;
  if (reason === 'exceeds per-tx cap') return `${reason}. Raise it: cryptocadet policy:set --kind perTx --token <usdc> --usdc <amount>`;
  if (reason === 'exceeds daily cap') return `${reason}. Raise it: cryptocadet policy:set --kind daily --token <usdc> --usdc <amount>`;
  return reason;
}

function settlement(r: PayResult): PaySettlement {
  if (r.status === 'CONFIRMED') return { status: r.status, txHash: r.txHash };
  if (r.status === 'PENDING') return { status: r.status, txHash: r.txHash, reason: 'broadcast but not yet confirmed' };
  if (r.status === 'DUPLICATE') {
    return r.row.status === 'CONFIRMED' && r.row.tx_hash
      ? { status: 'CONFIRMED', txHash: r.row.tx_hash }
      : { status: r.status, reason: `quote already ${r.row.status}` };
  }
  if (r.status === 'ESCALATE') return { status: r.status, reason: `${r.reason}. Confirm it: re-run with --approve` };
  return { status: r.status, reason: withHint(r.reason) };
}

export async function paidFetch(deps: PaidFetchDeps, args: PaidFetchArgs): Promise<PaidFetchResult> {
  let url: URL;
  try {
    url = new URL(args.url);
  } catch {
    throw new Error('fetch_paid: url must be absolute');
  }
  if (url.protocol !== 'https:' && url.hostname !== 'localhost' && url.hostname !== '127.0.0.1') {
    throw new Error('fetch_paid: only https URLs');
  }
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(args.headers ?? {})) {
    if (RESERVED_HEADERS.has(k.toLowerCase())) throw new Error(`fetch_paid: header ${k} is set by the payment flow`);
    headers[k] = String(v);
  }
  const init: RequestInit = {
    method: (args.method ?? 'GET').toUpperCase(),
    headers,
    ...(args.body !== undefined ? { body: args.body } : {}),
  };

  const token = await deps.agentToken();
  const payOpts = deps.humanApproved ? { humanApproved: true } : {};
  const result = await fetchWithPayment(url.toString(), init, {
    chainId: deps.chainId,
    // Non-gateway 402s: the account quote path (server resolves the recipient).
    quoteFor: async (req: PaymentRequirement) =>
      deps.server.requestQuote({ token: req.asset.toLowerCase(), recipient: req.payTo, amount: req.maxAmountRequired, purpose: 'per_call' }),
    pay: async (quoteId) => settlement(await deps.signer.pay(await deps.server.getQuoteById(quoteId), payOpts)),
    paySignedQuote: async (quote) => settlement(await deps.signer.pay(quote, payOpts)),
    ...(token ? { agentToken: token } : {}),
    creditsOrigins: deps.creditsOrigins,
    ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
  });

  const text = await result.response.text();
  const charged = result.response.headers.get('x-cryptocadet-charged');
  return {
    status: result.response.status,
    paid: result.paid,
    rail: result.rail ?? null,
    ...(result.quoteId ? { quoteId: result.quoteId } : {}),
    ...(result.txHash ? { txHash: result.txHash } : {}),
    ...(charged ? { charged } : {}),
    contentType: result.response.headers.get('content-type'),
    body: text.length > MAX_BODY ? text.slice(0, MAX_BODY) : text,
    truncated: text.length > MAX_BODY,
  };
}
