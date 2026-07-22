import { describe, it, expect } from 'vitest';
import { ensureGas, GasSwapError, type GasSwapExecutor } from '../src/chain/swap.js';
import type { GasSwapPolicy } from '../src/types/policy.js';

const GAS: GasSwapPolicy = {
  enabled: true,
  minWei: '100000000000000', // 0.0001 ETH
  targetWei: '400000000000000', // 0.0004 ETH
  maxUsdcPerSwap: '2000000', // 2 USDC
};

/** Recording fake executor. `balance` is native wei; everything else is scripted. */
function fakeExec(over: Partial<{ balance: bigint; swapCost: bigint; quote: bigint }> = {}): {
  exec: GasSwapExecutor;
  swaps: Array<{ ethWei: bigint; maxUsdcIn: bigint }>;
} {
  const swaps: Array<{ ethWei: bigint; maxUsdcIn: bigint }> = [];
  const exec: GasSwapExecutor = {
    nativeBalanceWei: async () => over.balance ?? 0n,
    estimateSwapCostWei: async () => over.swapCost ?? 10_000_000_000n, // ~1e10 wei, cheap
    quoteUsdcInForEthOut: async () => over.quote ?? 1_000_000n, // 1 USDC
    swapUsdcForExactEth: async (ethWei, maxUsdcIn) => {
      swaps.push({ ethWei, maxUsdcIn });
      return { txHash: '0xswap' };
    },
  };
  return { exec, swaps };
}

describe('ensureGas', () => {
  it('no swap when the policy has gas swap disabled', async () => {
    const { exec, swaps } = fakeExec({ balance: 0n });
    const r = await ensureGas({ gasSwap: { ...GAS, enabled: false } }, exec);
    expect(r).toMatchObject({ swapped: false, reason: 'disabled' });
    expect(swaps).toHaveLength(0);
  });

  it('no swap when gasSwap is absent entirely (legacy policy)', async () => {
    const { exec, swaps } = fakeExec({ balance: 0n });
    const r = await ensureGas({}, exec);
    expect(r).toMatchObject({ swapped: false, reason: 'disabled' });
    expect(swaps).toHaveLength(0);
  });

  it('no swap when native balance already >= minWei', async () => {
    const { exec, swaps } = fakeExec({ balance: BigInt(GAS.minWei) });
    const r = await ensureGas({ gasSwap: GAS }, exec);
    expect(r).toMatchObject({ swapped: false, reason: 'sufficient' });
    expect(swaps).toHaveLength(0);
  });

  it('swaps up to the deficit when below minWei, spending at most the cap', async () => {
    // balance 0.00005 ETH < min 0.0001 -> deficit to target 0.0004 = 0.00035 ETH.
    const balance = 50_000_000_000_000n;
    const { exec, swaps } = fakeExec({ balance });
    const r = await ensureGas({ gasSwap: GAS }, exec);
    expect(r.swapped).toBe(true);
    expect(r.reason).toBe('topped-up');
    expect(r.txHash).toBe('0xswap');
    expect(swaps).toHaveLength(1);
    expect(swaps[0]!.ethWei).toBe(BigInt(GAS.targetWei) - balance);
    expect(swaps[0]!.maxUsdcIn).toBe(BigInt(GAS.maxUsdcPerSwap));
  });

  it('throws GasSwapError when the balance cannot even afford the swap tx (zero-bootstrap)', async () => {
    // balance below both minWei AND the swap gas cost -> unsafe to self-swap.
    const { exec, swaps } = fakeExec({ balance: 5n, swapCost: 1_000_000n });
    await expect(ensureGas({ gasSwap: GAS }, exec)).rejects.toBeInstanceOf(GasSwapError);
    expect(swaps).toHaveLength(0);
  });

  it('throws GasSwapError when the quote exceeds maxUsdcPerSwap', async () => {
    const balance = 50_000_000_000_000n;
    const { exec, swaps } = fakeExec({ balance, quote: 5_000_000n }); // 5 USDC > 2 USDC cap
    await expect(ensureGas({ gasSwap: GAS }, exec)).rejects.toBeInstanceOf(GasSwapError);
    expect(swaps).toHaveLength(0);
  });
});
