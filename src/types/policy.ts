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
  };
}
