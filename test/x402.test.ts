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
