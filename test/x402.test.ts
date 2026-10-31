import { describe, it, expect, vi } from 'vitest';
import {
  parseChallenge,
  selectRequirement,
  requirementChainId,
  buildPaymentProof,
  fetchWithPayment,
  type PaymentRequirement,
} from '../src/x402/x402.js';
import { USDC, SELLER } from './helpers/fixtures.js';

function res(status: number, body?: unknown): Response {
  return new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const REQ: PaymentRequirement = {
  scheme: 'exact',
  network: 'base-sepolia',
  asset: USDC,
  maxAmountRequired: '1000000',
  payTo: SELLER,
};

describe('x402 helpers', () => {
  it('resolves chainId from network label or explicit chainId', () => {
    expect(requirementChainId({ ...REQ })).toBe(84532);
    expect(requirementChainId({ ...REQ, network: undefined, chainId: 8453 })).toBe(8453);
    expect(requirementChainId({ ...REQ, network: 'ethereum', chainId: undefined })).toBeNull();
  });

  it('selects the requirement matching our chain', async () => {
    const ch = await parseChallenge(res(402, { accepts: [{ ...REQ, network: 'base' }, REQ] }));
    expect(selectRequirement(ch, 84532)).toEqual(REQ);
    expect(selectRequirement(ch, 137)).toBeNull();
  });

  it('builds a decodable base64 proof', () => {
    const decoded = JSON.parse(Buffer.from(buildPaymentProof('q1', '0xtx'), 'base64').toString());
    expect(decoded).toEqual({ scheme: 'cryptocadet-v4', quoteId: 'q1', txHash: '0xtx' });
  });
});

describe('fetchWithPayment', () => {
  const deps = (fetchImpl: typeof fetch, pay = vi.fn(async () => ({ status: 'CONFIRMED', txHash: '0xabc' }))) => ({
    chainId: 84532,
    quoteFor: vi.fn(async () => ({ quoteId: 'quote-1' })),
    pay,
    fetchImpl,
  });

  it('returns the response unchanged when no payment is required', async () => {
    const fetchImpl = vi.fn(async () => res(200, { ok: true })) as unknown as typeof fetch;
    const d = deps(fetchImpl);
    const out = await fetchWithPayment('https://api/x', {}, d);
    expect(out.paid).toBe(false);
    expect(out.response.status).toBe(200);
    expect(d.quoteFor).not.toHaveBeenCalled();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('on 402: quotes, pays, and retries with the X-PAYMENT proof header', async () => {
    const calls: RequestInit[] = [];
    let n = 0;
    const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
      calls.push(init);
      n += 1;
      return n === 1 ? res(402, { accepts: [REQ] }) : res(200, { data: 'paid content' });
    }) as unknown as typeof fetch;

    const d = deps(fetchImpl);
    const out = await fetchWithPayment('https://api/x', { method: 'GET' }, d);

    expect(d.quoteFor).toHaveBeenCalledWith(REQ);
    expect(d.pay).toHaveBeenCalledWith('quote-1');
    expect(out).toMatchObject({ paid: true, quoteId: 'quote-1', txHash: '0xabc' });
    expect(out.response.status).toBe(200);
    // retry carried the proof
    const proof = (calls[1]!.headers as Record<string, string>)['X-PAYMENT'];
    expect(JSON.parse(Buffer.from(proof, 'base64').toString())).toMatchObject({ quoteId: 'quote-1', txHash: '0xabc' });
  });

  it('does NOT retry when the payment is refused by policy', async () => {
    let n = 0;
    const fetchImpl = vi.fn(async () => {
      n += 1;
      return res(402, { accepts: [REQ] });
    }) as unknown as typeof fetch;
    const pay = vi.fn(async () => ({ status: 'REFUSED', reason: 'recipient not allowlisted' }));
    await expect(fetchWithPayment('https://api/x', {}, deps(fetchImpl, pay))).rejects.toThrow(/not settled|not allowlisted/);
    expect(n).toBe(1); // only the initial request; no retry after refusal
  });

  it('throws when no requirement is payable on our chain', async () => {
    const fetchImpl = vi.fn(async () => res(402, { accepts: [{ ...REQ, network: 'ethereum', chainId: 1 }] })) as unknown as typeof fetch;
    await expect(fetchWithPayment('https://api/x', {}, deps(fetchImpl))).rejects.toThrow(/no requirement payable/);
  });
});

describe('fetchWithPayment — CryptoCadet gateway rails', () => {
  const GATEWAY = 'https://api.v4.cryptocadet.app';
  const URL_ = `${GATEWAY}/v4/g/hale/nda-checklist`;
  const CREDITS: PaymentRequirement = {
    scheme: 'cryptocadet-credits',
    asset: '',
    maxAmountRequired: '4000000',
    payTo: '',
    header: 'X-CryptoCadet-Agent',
  };
  const USDC_GW: PaymentRequirement = {
    ...REQ,
    scheme: 'cryptocadet-v4',
    quoteUrl: `${GATEWAY}/v4/gateway/quotes`,
    quoteBody: { handle: 'hale', slug: 'nda-checklist' },
  };
  const QUOTE = {
    quoteId: 'gw-quote-1',
    chainId: 84532,
    token: USDC,
    recipient: SELLER,
    amount: '4000000',
    purpose: 'per_call',
    expiresAt: 9_999_999_999,
    serverSig: 'sig',
  };

  function gatewayFetch(opts: { creditsStatus: number; creditsBody?: unknown }) {
    const calls: { url: string; init: RequestInit }[] = [];
    const fetchImpl = vi.fn(async (url: string, init: RequestInit = {}) => {
      calls.push({ url, init });
      const h = (init.headers as Record<string, string>) ?? {};
      if (url.endsWith('/v4/gateway/quotes')) return res(201, { quote: QUOTE });
      if (h['X-CryptoCadet-Agent']) return res(opts.creditsStatus, opts.creditsBody ?? { content: 'nda' });
      if (h['X-PAYMENT']) return res(200, { content: 'nda via usdc' });
      return res(402, { accepts: [CREDITS, USDC_GW] });
    }) as unknown as typeof fetch;
    return { fetchImpl, calls };
  }

  const base = (fetchImpl: typeof fetch) => ({
    chainId: 84532,
    quoteFor: vi.fn(async () => ({ quoteId: 'account-quote' })),
    pay: vi.fn(async () => ({ status: 'CONFIRMED', txHash: '0xpay' })),
    paySignedQuote: vi.fn(async () => ({ status: 'CONFIRMED', txHash: '0xgw' })),
    agentToken: 'ccx_agent_secret',
    creditsOrigins: [GATEWAY],
    fetchImpl,
  });

  it('pays with credits on a trusted gateway: no quote, no signing', async () => {
    const { fetchImpl, calls } = gatewayFetch({ creditsStatus: 200 });
    const d = base(fetchImpl);
    const out = await fetchWithPayment(URL_, { method: 'GET' }, d);
    expect(out).toMatchObject({ paid: true, rail: 'credits' });
    expect((calls[1]!.init.headers as Record<string, string>)['X-CryptoCadet-Agent']).toBe('ccx_agent_secret');
    expect(d.pay).not.toHaveBeenCalled();
    expect(d.paySignedQuote).not.toHaveBeenCalled();
  });

  it('never sends the agent token to an untrusted origin (pays USDC instead)', async () => {
    const { fetchImpl, calls } = gatewayFetch({ creditsStatus: 200 });
    const d = { ...base(fetchImpl), creditsOrigins: ['https://other.example'] };
    const out = await fetchWithPayment(URL_, {}, d);
    expect(out.rail).toBe('usdc');
    expect(calls.some((c) => (c.init.headers as Record<string, string> | undefined)?.['X-CryptoCadet-Agent'])).toBe(false);
  });

  it('falls back to a gateway-bound USDC quote when credits are refused', async () => {
    const { fetchImpl, calls } = gatewayFetch({ creditsStatus: 402, creditsBody: { code: 'INSUFFICIENT_CREDITS', accepts: [] } });
    const d = base(fetchImpl);
    const out = await fetchWithPayment(URL_, {}, d);
    expect(out).toMatchObject({ paid: true, rail: 'usdc', quoteId: 'gw-quote-1', txHash: '0xgw' });
    const quoteCall = calls.find((c) => c.url.endsWith('/v4/gateway/quotes'))!;
    expect(JSON.parse(String(quoteCall.init.body))).toEqual({ handle: 'hale', slug: 'nda-checklist' });
    expect(d.paySignedQuote).toHaveBeenCalledWith(QUOTE);
    expect(d.quoteFor).not.toHaveBeenCalled();
    const proof = (calls.at(-1)!.init.headers as Record<string, string>)['X-PAYMENT'];
    expect(JSON.parse(Buffer.from(proof!, 'base64').toString())).toMatchObject({ quoteId: 'gw-quote-1', txHash: '0xgw' });
  });

  it('reports the credits refusal when there is no USDC option', async () => {
    const fetchImpl = vi.fn(async (_u: string, init: RequestInit = {}) =>
      (init.headers as Record<string, string> | undefined)?.['X-CryptoCadet-Agent']
        ? res(402, { code: 'AGENT_DAILY_CAP', message: 'cap reached', accepts: [CREDITS] })
        : res(402, { accepts: [CREDITS] }),
    ) as unknown as typeof fetch;
    await expect(fetchWithPayment(URL_, {}, base(fetchImpl))).rejects.toThrow(/credits refused \(AGENT_DAILY_CAP/);
  });

  it('uses the account quote path when the client cannot pay a full signed quote', async () => {
    const { fetchImpl } = gatewayFetch({ creditsStatus: 200 });
    const d = { ...base(fetchImpl), agentToken: undefined, paySignedQuote: undefined };
    const out = await fetchWithPayment(URL_, {}, d);
    expect(out.quoteId).toBe('account-quote');
    expect(d.quoteFor).toHaveBeenCalled();
  });
});
