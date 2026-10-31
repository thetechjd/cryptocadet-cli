import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Interface } from 'ethers';

// Fake ERC-20 contract: records approve calls and serves a configurable allowance.
const state = { allowance: 0n, approvals: [] as Array<{ spender: string; amount: bigint }>, approveStatus: 1 };
vi.mock('ethers', async (orig) => {
  const real = await orig<typeof import('ethers')>();
  class FakeContract {
    allowance = async () => state.allowance;
    approve = async (spender: string, amount: bigint) => {
      state.approvals.push({ spender, amount });
      return { wait: async () => ({ status: state.approveStatus }) };
    };
  }
  return { ...real, Contract: FakeContract };
});

const { routedPaymentData, quoteIdSuffix, sendRoutedPayment } = await import('../src/chain/router.js');

const ROUTER = '0xffe91f1582080c85f7651fa32de2186df1b9343b';
const USDC = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
const SELLER = '0x1111111111111111111111111111111111111111';
const QID = '5f0c2a8e-9b1d-4c3e-8f7a-1234567890ab';

function fakeWallet() {
  const sent: Array<{ to: string; data: string }> = [];
  const wallet = {
    address: '0x2222222222222222222222222222222222222222',
    sendTransaction: vi.fn(async (tx: { to: string; data: string }) => {
      sent.push(tx);
      return { hash: '0xpaid' };
    }),
  };
  return { wallet: wallet as never, sent };
}

beforeEach(() => {
  state.allowance = 0n;
  state.approvals = [];
  state.approveStatus = 1;
});

describe('routed payment primitive', () => {
  it('encodes payWithToken(payee, token, amount) with the quoteId bytes appended', () => {
    const data = routedPaymentData(SELLER, USDC, '4000000', QID);
    expect(data.endsWith(quoteIdSuffix(QID))).toBe(true);
    const iface = new Interface(['function payWithToken(address,address,uint256)']);
    const [payee, token, amount] = iface.decodeFunctionData('payWithToken', data.slice(0, -32));
    expect([String(payee).toLowerCase(), String(token).toLowerCase(), amount]).toEqual([SELLER, USDC, 4_000_000n]);
  });

  it('refuses a non-uuid quoteId (the server could not bind the tx to it)', () => {
    expect(() => routedPaymentData(SELLER, USDC, '1', 'quote-1')).toThrow(/uuid/);
  });

  it('approves the router for exactly the payment, then pays through it', async () => {
    const { wallet, sent } = fakeWallet();
    await sendRoutedPayment(wallet, ROUTER, USDC, SELLER, '4000000', QID);
    expect(state.approvals).toEqual([{ spender: ROUTER, amount: 4_000_000n }]);
    expect(sent).toEqual([{ to: ROUTER, data: routedPaymentData(SELLER, USDC, '4000000', QID) }]);
  });

  it('reuses a leftover allowance instead of approving again', async () => {
    state.allowance = 4_000_000n;
    const { wallet, sent } = fakeWallet();
    await sendRoutedPayment(wallet, ROUTER, USDC, SELLER, '4000000', QID);
    expect(state.approvals).toHaveLength(0);
    expect(sent).toHaveLength(1);
  });

  it('does not pay when the approval reverts', async () => {
    state.approveStatus = 0;
    const { wallet, sent } = fakeWallet();
    await expect(sendRoutedPayment(wallet, ROUTER, USDC, SELLER, '4000000', QID)).rejects.toThrow(/approval reverted/);
    expect(sent).toHaveLength(0);
  });
});
