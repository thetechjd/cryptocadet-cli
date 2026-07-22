// Local-only enforcement policy. This file lives in the CLIENT package only and is
// the SOLE enforcement of spending limits — there is no on-chain caveat enforcer.
//
// All amounts are token base units as decimal strings (never JS numbers).
// USDC on Base has 6 decimals; "1000000" == 1.00 USDC.

export interface AllowedToken {
  symbol: string;
  decimals: number;
  /** If true, the recipient receives less than `amount` (transfer skims a fee).
   *  v4 default: reject fee-on-transfer tokens at allowlist time (see init/edit_allowlist). */
  feeOnTransfer: boolean;
}

/** Bounded auto-swap of USDC→native ETH to cover gas. This is a DELIBERATE, capped
 *  exception to the "no native-token spending" rule: an ERC-20-only wallet cannot pay its
 *  own gas, so with zero ETH every transfer/approve reverts. When enabled, a small USDC
 *  amount is swapped to ETH just-in-time before a signing op that would otherwise fail for
 *  lack of gas. All amounts are base units / wei as decimal strings (never JS numbers). */
export interface GasSwapPolicy {
  /** Master switch. When false, no swap ever happens and a missing gas balance surfaces as
   *  an ordinary broadcast failure. */
  enabled: boolean;
  /** Trigger threshold: if the native ETH balance is below this (wei), top up before signing. */
  minWei: string;
  /** Target the swap tops the native balance up to (wei). Must be >= minWei. */
  targetWei: string;
  /** Hard ceiling on USDC (base units) spendable in a SINGLE gas top-up swap. The swap is
   *  refused if reaching targetWei would cost more than this — a runaway-slippage backstop. */
  maxUsdcPerSwap: string;
}

export interface Policy {
  version: 1;
  /** Base mainnet 8453. Testnet build uses 84532. */
  chainId: 8453 | 84532;
  /** key: lowercased token contract address */
  allowlist: Record<string, AllowedToken>;
  /** lowercased payout addresses the agent may pay */
  recipients: string[];
  /** token addr -> max single payment, base units */
  perTxCap: Record<string, string>;
  /** token addr -> rolling 24h cap, base units */
  dailyCap: Record<string, string>;
  /** token addr -> reserved (untouchable by per-call spending), base units */
  subscriptionReserve: Record<string, string>;
  /** token addr -> threshold above which a payment requires out-of-band human confirm */
  requireHumanAboveTx: Record<string, string>;
  /** Optional bounded USDC→ETH gas top-up. Absent/disabled => never auto-swap. */
  gasSwap?: GasSwapPolicy;
}

/** A policy value OR a provider that returns the current one. A provider lets long-running
 *  consumers (the resident mcp:serve signer + agent tools) pick up edits made by human-only
 *  CLI verbs without a restart — see makePolicyProvider in config/policy-store. */
export type PolicyRef = Policy | (() => Policy);

/** Resolve a PolicyRef to the current Policy. */
export function resolvePolicy(ref: PolicyRef): Policy {
  return typeof ref === 'function' ? ref() : ref;
}

/** A freshly-initialized, deny-everything policy. Caller adds tokens/recipients via CLI. */
export function emptyPolicy(chainId: Policy['chainId']): Policy {
  return {
    version: 1,
    chainId,
    allowlist: {},
    recipients: [],
    perTxCap: {},
    dailyCap: {},
    subscriptionReserve: {},
    requireHumanAboveTx: {},
    gasSwap: { enabled: false, minWei: '0', targetWei: '0', maxUsdcPerSwap: '0' },
  };
}
