import { describe, it, expect, vi } from 'vitest';
import { paidFetch, type PaidFetchDeps } from '../src/x402/paid-fetch.js';

const GATEWAY = 'https://api.v4.cryptocadet.app';
const ITEM = `${GATEWAY}/v4/g/cc-test/router-test`;
const QUOTE = {
  quoteId: '5f0c2a8e-9b1d-4c3e-8f7a-1234567890ab',
  chainId: 8453,
  token: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
  recipient: '0x1111111111111111111111111111111111111111',
  amount: '1000000',
  purpose: 'per_call',
  expiresAt: 9_999_999_999,
  router: '0xffe91f1582080c85f7651fa32de2186df1b9343b',
  serverSig: 'sig',
};
const CHALLENGE = {
  x402Version: 1,
  accepts: [
    { scheme: 'cryptocadet-credits', rail: 'credits', header: 'X-CryptoCadet-Agent', maxAmountRequired: '1000000', asset: '', payTo: '' },
    {
      scheme: 'cryptocadet-v4', rail: 'usdc', network: 'base', chainId: 8453, asset: QUOTE.token, maxAmountRequired: '1000000',
      payTo: QUOTE.recipient, quoteUrl: `${GATEWAY}/v4/gateway/quotes`, quoteBody: { handle: 'cc-test', slug: 'router-test' },
    },
  ],
};
const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

function gateway() {
  const seen: Array<{ url: string; headers: Record<string, string> }> = [];
  const fetchImpl = vi.fn(async (url: string, init: RequestInit = {}) => {
    const h = (init.headers as Record<string, string>) ?? {};
    seen.push({ url, headers: h });
    if (url.endsWith('/v4/gateway/quotes')) return json(201, { quote: QUOTE, redeemToken: 'ccr_secret' });
    if (h['X-CryptoCadet-Agent']) return new Response('the memo', { status: 200, headers: { 'x-cryptocadet-charged': '1000000' } });
    if (h['X-PAYMENT']) return new Response('the memo', { status: 200 });
    return json(402, CHALLENGE);
  }) as unknown as typeof fetch;
  return { fetchImpl, seen };
}

function deps(over: Partial<PaidFetchDeps> & { fetchImpl: typeof fetch }): PaidFetchDeps & { pay: ReturnType<typeof vi.fn> } {
  const pay = vi.fn(async () => ({ status: 'CONFIRMED' as const, quoteId: QUOTE.quoteId, txHash: '0xpaid' }));
  return {
    chainId: 8453,
    signer: { pay } as never,
    server: { requestQuote: vi.fn(), getQuoteById: vi.fn(), finalize: vi.fn() } as never,
    agentToken: async () => null,
    creditsOrigins: [GATEWAY],
    ...over,
    pay,
  };
}

describe('paidFetch (agent fetch_paid / CLI fetch)', () => {
  it('card-funded agent: pays with credits on the gateway and signs nothing', async () => {
    const g = gateway();
    const d = deps({ fetchImpl: g.fetchImpl, agentToken: async () => 'ccx_agent_abc' });
    const r = await paidFetch(d, { url: ITEM });
    expect(r).toMatchObject({ status: 200, paid: true, rail: 'credits', charged: '1000000', body: 'the memo' });
    expect(d.pay).not.toHaveBeenCalled();
  });

  it('self-funded agent: pays the router-bound gateway quote through the gated signer', async () => {
    const g = gateway();
    const d = deps({ fetchImpl: g.fetchImpl });
    const r = await paidFetch(d, { url: ITEM });
    expect(r).toMatchObject({ status: 200, paid: true, rail: 'usdc', quoteId: QUOTE.quoteId, txHash: '0xpaid' });
    expect(d.pay).toHaveBeenCalledWith(QUOTE);
    const proof = JSON.parse(Buffer.from(g.seen.at(-1)!.headers['X-PAYMENT']!, 'base64').toString());
    expect(proof).toMatchObject({ quoteId: QUOTE.quoteId, txHash: '0xpaid', redeemToken: 'ccr_secret' });
  });

  it('a policy refusal is reported and the request is not retried', async () => {
    const g = gateway();
    const d = deps({ fetchImpl: g.fetchImpl });
    d.pay.mockResolvedValueOnce({ status: 'REFUSED', quoteId: QUOTE.quoteId, reason: 'recipient not allowlisted' } as never);
    await expect(paidFetch(d, { url: ITEM })).rejects.toThrow(/recipient not allowlisted/);
    expect(g.seen.some((s) => s.headers['X-PAYMENT'])).toBe(false);
  });

  it('never sends the credits token to another origin', async () => {
    const g = gateway();
    const d = deps({ fetchImpl: g.fetchImpl, agentToken: async () => 'ccx_agent_abc', creditsOrigins: ['https://other.example'] });
    await paidFetch(d, { url: ITEM });
    expect(g.seen.some((s) => s.headers['X-CryptoCadet-Agent'])).toBe(false);
  });

  it('refuses caller-supplied payment headers and non-https URLs', async () => {
    const d = deps({ fetchImpl: gateway().fetchImpl });
    await expect(paidFetch(d, { url: ITEM, headers: { 'X-PAYMENT': 'forged' } })).rejects.toThrow(/set by the payment flow/);
    await expect(paidFetch(d, { url: ITEM, headers: { authorization: 'Bearer x' } })).rejects.toThrow(/set by the payment flow/);
    await expect(paidFetch(d, { url: 'http://example.com/x' })).rejects.toThrow(/only https/);
  });

  it('returns a free (non-402) response without paying', async () => {
    const fetchImpl = vi.fn(async () => new Response('free', { status: 200 })) as unknown as typeof fetch;
    const d = deps({ fetchImpl, agentToken: async () => 'ccx_agent_abc' });
    expect(await paidFetch(d, { url: ITEM })).toMatchObject({ status: 200, paid: false, rail: null, body: 'free' });
    expect(d.pay).not.toHaveBeenCalled();
  });
});
