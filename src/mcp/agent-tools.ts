// The AGENT-FACING MCP surface. EXACTLY four verbs, and only these are ever registered
// on the agent transport:
//
//   check_balance   — read-only per-token agent-wallet balance and spendable
//   quote_payment   — proxies to the server to obtain a signed quote id (no pricing/signing here)
//   pay             — takes a quoteId, runs the full gated flow; returns confirm/refusal/escalation
//   dry_run         — takes a quoteId, runs evaluate() and prints the tx that WOULD be signed
//
// Key, limit, allowlist, rotate, and sweep operations are HUMAN-ONLY and are NOT in this
// registry (see ../revoke and ../cli). A human-only verb reachable from the agent
// transport is a critical defect — the enforcement is that they are not registered at all.

import type { PaymentSigner, PayResult } from '../signer/signer.js';
import type { QuoteClient, QuoteRequest } from '../server/client.js';
import type { Policy } from '../types/policy.js';

/** The complete, closed set of agent-facing verb names. Frozen so it cannot be mutated
 *  at runtime to smuggle in a human-only verb. Tests assert this set exactly. */
export const AGENT_TOOL_NAMES = Object.freeze(['check_balance', 'quote_payment', 'pay', 'dry_run'] as const);
export type AgentToolName = (typeof AGENT_TOOL_NAMES)[number];

export interface AgentToolDeps {
  policy: Policy;
  signer: PaymentSigner;
  /** Only the narrow money-path contract is reachable from the agent surface. */
  server: QuoteClient;
  /** on-chain balance read, base-unit string */
  readBalance: (token: string) => Promise<string>;
}

export interface AgentTool {
  name: AgentToolName;
  description: string;
  handler: (args: Record<string, unknown>) => Promise<unknown>;
}

const big = (s: string) => BigInt(s);

export function buildAgentTools(deps: AgentToolDeps): Record<AgentToolName, AgentTool> {
  const spendableFor = (token: string, balance: string): string => {
    const reserve = deps.policy.subscriptionReserve[token] ?? '0';
    const s = big(balance) - big(reserve);
    return (s < 0n ? 0n : s).toString();
  };

  const tools: Record<AgentToolName, AgentTool> = {
    check_balance: {
      name: 'check_balance',
      description: 'Read-only agent-wallet balance and spendable (balance minus subscription reserve) per token.',
      handler: async (args) => {
        const token = String(args['token'] ?? '').toLowerCase();
        if (!token) throw new Error('check_balance requires a token address');
        const balance = await deps.readBalance(token);
        return { token, balance, spendable: spendableFor(token, balance), reserve: deps.policy.subscriptionReserve[token] ?? '0' };
      },
    },
    quote_payment: {
      name: 'quote_payment',
      description: 'Ask the server to compute and sign a quote. Returns a quoteId; does NOT price or sign locally.',
      handler: async (args) => {
        const req: QuoteRequest = {
          token: String(args['token'] ?? '').toLowerCase(),
          recipient: String(args['recipient'] ?? ''),
          purpose: (args['purpose'] as QuoteRequest['purpose']) ?? 'per_call',
          ...(args['amount'] !== undefined ? { amount: String(args['amount']) } : {}),
        };
        const quote = await deps.server.requestQuote(req);
        return { quoteId: quote.quoteId, expiresAt: quote.expiresAt };
      },
    },
    pay: {
      name: 'pay',
      description: 'Execute a server-issued quote by id. Re-validated against local policy before any signature.',
      handler: async (args): Promise<PayResult> => {
        const quoteId = String(args['quoteId'] ?? '');
        if (!quoteId) throw new Error('pay requires a quoteId');
        // The agent supplies ONLY a quoteId; recipient/amount come from the signed quote.
        const quote = await deps.server.getQuoteById(quoteId);
        // NOTE: humanApproved is intentionally NOT plumbed from agent args — escalation
        // confirmation is a human-only out-of-band action.
        return deps.signer.pay(quote);
      },
    },
    dry_run: {
      name: 'dry_run',
      description: 'Evaluate a quote and report the tx that WOULD be signed. Broadcasts nothing.',
      handler: async (args) => {
        const quoteId = String(args['quoteId'] ?? '');
        if (!quoteId) throw new Error('dry_run requires a quoteId');
        const quote = await deps.server.getQuoteById(quoteId);
        return deps.signer.dryRun(quote);
      },
    },
  };
  return tools;
}
