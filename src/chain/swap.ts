// Bounded USDC→native-ETH gas top-up.
//
// WHY THIS EXISTS: the agent wallet is ERC-20-only by design ("No native-token spending,
// ever" — see chain/erc20.ts). But every ERC-20 transfer/approve costs gas, paid in native
// ETH. With no ETH the wallet cannot move its own USDC at all. This module swaps a small,
// policy-capped amount of USDC to ETH just-in-time so the next signing op can pay for itself.
//
// HONEST LIMITATION: this is an ON-CHAIN swap, so the swap transaction ITSELF costs gas. It
// therefore keeps a low-but-nonzero wallet topped up (never lets it run dry); it CANNOT
// bootstrap from an absolutely-zero balance — that first bit of ETH must come from a human
// top-up (or, as a future option, a paymaster/relayer). When the balance is too low to even
// afford the swap tx, ensureGas throws a clear, actionable error instead of the cryptic
// "insufficient funds for intrinsic transaction cost" ethers would otherwise surface.
//
// This is a DELIBERATE, bounded exception to the no-native-spending rule, gated entirely by
// policy.gasSwap (enabled + minWei + targetWei + maxUsdcPerSwap). It is a self-custody swap,
// NOT a merchant payment: it does not go through the single gated signer call site.

import { Contract, getAddress, type JsonRpcProvider, type Wallet } from 'ethers';
import type { Policy } from '../types/policy.js';
import { tokenAllowance } from './erc20.js';

/** Per-chain Uniswap v3 addresses + the USDC/WETH fee tier used for the tiny gas swap. */
interface SwapChainConfig {
  router: string; // Uniswap SwapRouter02
  quoter: string; // Uniswap QuoterV2
  weth: string;
  feeTier: number; // 500 = 0.05%
}

const SWAP_CONFIG: Partial<Record<number, SwapChainConfig>> = {
  // Base mainnet.
  8453: {
    router: '0x2626664c2603336e57b271c5c0b26f421741e481',
    quoter: '0x3d4e44eb1374240ce5f1b871ab261cd16335b76a',
    weth: '0x4200000000000000000000000000000000000006',
    feeTier: 500,
  },
  // Base Sepolia testnet. Uniswap's testnet deployment; leave gas-swap disabled in policy if
  // your testnet fork lacks USDC/WETH liquidity.
  84532: {
    router: '0x94cc0aac535ccdb3c01d6787d6413c739ae12bc4',
    quoter: '0xc5290058841028f1614f3a6f0f5816cad0df5e27',
    weth: '0x4200000000000000000000000000000000000006',
    feeTier: 500,
  },
};

// Generous fixed gas budget for the (possible approve +) swap, used only to (a) sanity-check
// the wallet can afford the swap tx and (b) size the pre-swap gas headroom. Not the actual
// on-chain limit — ethers estimates that per tx.
const SWAP_GAS_UNITS = 300_000n;

const SWAP_ROUTER_ABI = [
  'function exactOutputSingle((address tokenIn,address tokenOut,uint24 fee,address recipient,uint256 amountOut,uint256 amountInMaximum,uint160 sqrtPriceLimitX96)) payable returns (uint256 amountIn)',
  'function unwrapWETH9(uint256 amountMinimum,address recipient) payable',
  'function multicall(uint256 deadline,bytes[] data) payable returns (bytes[])',
];

const QUOTER_ABI = [
  'function quoteExactOutputSingle((address tokenIn,address tokenOut,uint256 amount,uint24 fee,uint160 sqrtPriceLimitX96)) returns (uint256 amountIn,uint160 sqrtPriceX96After,uint32 initializedTicksCrossed,uint256 gasEstimate)',
];

const ERC20_MINIMAL_ABI = ['function approve(address spender,uint256 amount) returns (bool)'];

/** Thrown when a gas top-up is needed but cannot be performed safely. Distinct type so
 *  callers can surface the actionable message rather than a raw ethers revert. */
export class GasSwapError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GasSwapError';
  }
}

/** The chain-touching operations ensureGas needs. Injected so the policy/threshold logic is
 *  unit-testable without a live chain (mirrors the Broadcaster injection in the signer). */
export interface GasSwapExecutor {
  nativeBalanceWei(): Promise<bigint>;
  /** Approximate wei cost of performing the swap tx(s) themselves — the affordability guard. */
  estimateSwapCostWei(): Promise<bigint>;
  /** USDC base units required to obtain `ethWei` of ETH out (via the quoter). */
  quoteUsdcInForEthOut(ethWei: bigint): Promise<bigint>;
  /** Execute the swap for exactly `ethWei` out, spending at most `maxUsdcIn` USDC. */
  swapUsdcForExactEth(ethWei: bigint, maxUsdcIn: bigint): Promise<{ txHash: string }>;
}

export interface EnsureGasResult {
  swapped: boolean;
  /** why no swap happened (disabled | sufficient) or that one did (topped-up). */
  reason: 'disabled' | 'sufficient' | 'topped-up';
  txHash?: string;
  ethOutWei?: string;
  maxUsdcIn?: string;
}

/**
 * Ensure the wallet has enough native ETH for gas, swapping a bounded amount of USDC if not.
 * Pure policy/threshold logic; all chain I/O is delegated to `exec`. Throws GasSwapError when
 * a top-up is needed but unsafe (balance can't afford the swap tx, or the quote exceeds the
 * per-swap USDC cap).
 */
export async function ensureGas(
  policy: Pick<Policy, 'gasSwap'>,
  exec: GasSwapExecutor,
): Promise<EnsureGasResult> {
  const g = policy.gasSwap;
  if (!g || !g.enabled) return { swapped: false, reason: 'disabled' };

  const min = BigInt(g.minWei);
  const target = BigInt(g.targetWei);
  const maxUsdc = BigInt(g.maxUsdcPerSwap);

  const balance = await exec.nativeBalanceWei();
  if (balance >= min) return { swapped: false, reason: 'sufficient' };

  const deficit = target - balance;
  if (deficit <= 0n) return { swapped: false, reason: 'sufficient' }; // target already met

  // Affordability guard: an on-chain swap needs gas to run. If we can't even pay for the swap
  // tx, no self-swap can help — a human must send a little ETH to bootstrap.
  const swapCost = await exec.estimateSwapCostWei();
  if (balance < swapCost) {
    throw new GasSwapError(
      `native ETH balance (${balance} wei) is too low to even pay for the gas-swap transaction ` +
        `(~${swapCost} wei). Send a small amount of ETH to the agent wallet to bootstrap gas, ` +
        `then auto-swap keeps it topped up.`,
    );
  }

  const usdcIn = await exec.quoteUsdcInForEthOut(deficit);
  if (usdcIn > maxUsdc) {
    throw new GasSwapError(
      `gas swap would cost ${usdcIn} USDC base units to reach ${target} wei, exceeding the ` +
        `policy cap gasSwap.maxUsdcPerSwap=${maxUsdc}. Raise the cap or top up ETH manually.`,
    );
  }

  const { txHash } = await exec.swapUsdcForExactEth(deficit, maxUsdc);
  return {
    swapped: true,
    reason: 'topped-up',
    txHash,
    ethOutWei: deficit.toString(),
    maxUsdcIn: maxUsdc.toString(),
  };
}

/** Production executor: real Uniswap v3 calls with the agent hot-wallet. */
export function liveSwapExecutor(
  wallet: Wallet,
  provider: JsonRpcProvider,
  chainId: number,
  usdcToken: string,
  agentAddress: string,
): GasSwapExecutor {
  const cfg = SWAP_CONFIG[chainId];
  if (!cfg) {
    // Return an executor that fails loudly on first use rather than silently no-op'ing.
    const fail = (): never => {
      throw new GasSwapError(`gas swap is not configured for chainId ${chainId}`);
    };
    return {
      nativeBalanceWei: () => provider.getBalance(agentAddress).then((b) => BigInt(b)),
      estimateSwapCostWei: fail,
      quoteUsdcInForEthOut: fail,
      swapUsdcForExactEth: fail,
    };
  }

  const usdc = usdcToken.toLowerCase();
  const router = getAddress(cfg.router);

  return {
    async nativeBalanceWei() {
      return BigInt(await provider.getBalance(agentAddress));
    },

    async estimateSwapCostWei() {
      const fee = await provider.getFeeData();
      const gasPrice = fee.maxFeePerGas ?? fee.gasPrice ?? 0n;
      return gasPrice * SWAP_GAS_UNITS;
    },

    async quoteUsdcInForEthOut(ethWei) {
      const quoter = new Contract(cfg.quoter, QUOTER_ABI, provider);
      // QuoterV2 quote fns are non-view; call via staticCall so they don't try to send a tx.
      const [amountIn] = (await quoter.quoteExactOutputSingle!.staticCall({
        tokenIn: usdc,
        tokenOut: cfg.weth,
        amount: ethWei,
        fee: cfg.feeTier,
        sqrtPriceLimitX96: 0n,
      })) as [bigint, bigint, bigint, bigint];
      return amountIn;
    },

    async swapUsdcForExactEth(ethWei, maxUsdcIn) {
      // Ensure the router can pull the USDC. Approve up to the per-swap cap when short. This
      // approve costs gas too — covered by the affordability guard in ensureGas.
      const allowance = BigInt(await tokenAllowance(provider, usdc, agentAddress, router));
      if (allowance < maxUsdcIn) {
        const erc20 = new Contract(usdc, ERC20_MINIMAL_ABI, wallet);
        const approveTx = (await erc20.approve!(router, maxUsdcIn)) as { wait: () => Promise<unknown> };
        await approveTx.wait();
      }

      const routerC = new Contract(cfg.router, SWAP_ROUTER_ABI, wallet);
      // Buy exactly `ethWei` of WETH to the router itself (recipient = router), then unwrap it
      // to native ETH sent to the agent. Bundled in one multicall with a deadline.
      const exactOutputData = routerC.interface.encodeFunctionData('exactOutputSingle', [
        {
          tokenIn: usdc,
          tokenOut: cfg.weth,
          fee: cfg.feeTier,
          recipient: router, // keep WETH in the router so unwrapWETH9 can convert it
          amountOut: ethWei,
          amountInMaximum: maxUsdcIn,
          sqrtPriceLimitX96: 0n,
        },
      ]);
      const unwrapData = routerC.interface.encodeFunctionData('unwrapWETH9', [ethWei, agentAddress]);
      const deadline = BigInt(Math.floor(Date.now() / 1000) + 300);

      const tx = (await routerC.multicall!(deadline, [exactOutputData, unwrapData])) as {
        hash: string;
        wait: () => Promise<unknown>;
      };
      await tx.wait();
      return { txHash: tx.hash };
    },
  };
}
