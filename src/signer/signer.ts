// THE SIGNER — and the single, gated signing call site for the agent payment path.
//
// Acceptance criterion for this whole component: there is EXACTLY ONE place where an
// agent-initiated payment is signed/broadcast, and it is gated on the policy engine's
// `allow === true`. That place is `#broadcast(...)` below, called once, immediately
// after the `gate.allow === true` check. Grep for `deps.broadcast(` — it appears once.
//
// (The only OTHER transaction-signing path in this package is `sweep`, the human-only
//  revocation drain. Sweep is never registered on the agent transport and deliberately
//  empties the wallet; it is not a payment and does not — must not — go through here.)

import { getAddress } from 'ethers';
import { evaluate, type Decision, type PolicyContext } from '../policy/evaluate.js';
import { resolvePolicy, type PolicyRef } from '../types/policy.js';
import type { SignedQuote, QuoteForPolicy } from '../types/quote.js';
import { verifyQuote } from '../quote/verify.js';
import type { Ledger, PaymentRow } from '../ledger/ledger.js';

export interface BroadcastResult {
  txHash: string;
  /** Resolves 'confirmed' or 'failed' once `confirmations` blocks deep; may reject on timeout. */
  wait: (confirmations: number) => Promise<'confirmed' | 'failed'>;
}

/** The actual key-signing operation. Injected so the engine is testable without a chain,
 *  and so the one call site is unambiguous. The real impl signs an ERC-20 transfer with
 *  the agent hot-wallet key. */
export type Broadcaster = (token: string, recipient: string, amount: string) => Promise<BroadcastResult>;

export interface SignerDeps {
  /** The policy, or a provider returning the current one. Pass a provider (see
   *  makePolicyProvider) in a long-running server so cap edits take effect without restart. */
  policy: PolicyRef;
  serverQuotePubKey: string;
  confirmations: number;
  ledger: Pick<
    Ledger,
    | 'isQuoteSeen'
    | 'get'
    | 'markPending'
    | 'attachTxHash'
    | 'markConfirmed'
    | 'markFinalized'
    | 'markFailed'
    | 'spentLast24h'
  >;
  /** on-chain token balance read, base-unit string */
  readBalance: (token: string) => Promise<string>;
  /** Pre-flight that must succeed before the quote is CLAIMED (e.g. the USDC→ETH gas
   *  top-up). Runs after the policy gate but BEFORE markPending: a failure here means
   *  nothing was signed and the quote stays unclaimed and payable — previously a gas
   *  failure inside broadcast() burned the quote as FAILED though no tx ever existed. */
  prepare?: () => Promise<void>;
  broadcast: Broadcaster;
  /** server finalize call, idempotent on quoteId. Best-effort; failure does not undo a confirmed tx. */
  finalize: (quoteId: string, txHash: string) => Promise<void>;
  /** unix seconds, for expiry checks */
  nowSeconds?: () => number;
}

export type PayResult =
  | { status: 'CONFIRMED'; quoteId: string; txHash: string }
  | { status: 'PENDING'; quoteId: string; txHash: string } // broadcast, not yet confirmed
  | { status: 'REFUSED'; quoteId: string; reason: string }
  | { status: 'ESCALATE'; quoteId: string; reason: string } // awaiting out-of-band human confirm
  | { status: 'DUPLICATE'; quoteId: string; row: PaymentRow }
  | { status: 'FAILED'; quoteId: string; reason: string };

export interface PayOptions {
  /** Set ONLY by the human-only confirm verb, never reachable from the agent transport.
   *  Flips an otherwise-passing ESCALATE decision into an allow. Cannot rescue any other
   *  denial — every non-escalation check must already have passed. */
  humanApproved?: boolean;
}

function rowResult(quoteId: string, row: PaymentRow): PayResult {
  if (row.status === 'CONFIRMED' && row.tx_hash) return { status: 'CONFIRMED', quoteId, txHash: row.tx_hash };
  if (row.status === 'FAILED') return { status: 'FAILED', quoteId, reason: 'prior attempt failed' };
  return { status: 'PENDING', quoteId, txHash: row.tx_hash ?? '' };
}

export class PaymentSigner {
  constructor(private readonly deps: SignerDeps) {}

  /** Run the full pay flow for a server-issued quote. The agent passes ONLY a quote it
   *  already obtained; it cannot synthesize recipient/amount. */
  async pay(quote: SignedQuote, opts: PayOptions = {}): Promise<PayResult> {
    const d = this.deps;
    const quoteId = quote.quoteId;

    // Idempotency: a quote already acted on returns its existing result; never re-sign.
    if (d.ledger.isQuoteSeen(quoteId)) {
      const existing = d.ledger.get(quoteId);
      if (existing) return { status: 'DUPLICATE', quoteId, row: existing };
    }

    // Provenance: verify serverSig + expiry BEFORE policy even runs.
    const v = verifyQuote(quote, {
      serverQuotePubKey: d.serverQuotePubKey,
      ...(d.nowSeconds ? { now: d.nowSeconds() } : {}),
    });
    if (!v.ok) return { status: 'REFUSED', quoteId, reason: `quote rejected: ${v.reason}` };

    // Build the policy quote + context. All I/O happens HERE, before evaluate().
    const q: QuoteForPolicy = {
      quoteId,
      token: quote.token,
      recipient: quote.recipient,
      amount: quote.amount,
      chainId: quote.chainId,
    };

    let balance: string;
    try {
      balance = await d.readBalance(quote.token.toLowerCase());
    } catch (e) {
      return { status: 'REFUSED', quoteId, reason: `balance read failed: ${(e as Error).message}` };
    }

    const ctx: PolicyContext = {
      policy: resolvePolicy(d.policy), // resolve fresh so a live cap edit is honored
      walletBalance: () => balance,
      spentLast24h: (token) => d.ledger.spentLast24h(token),
      isQuoteSeen: (id) => d.ledger.isQuoteSeen(id),
    };

    const decision: Decision = evaluate(q, ctx);

    // Resolve the gate. The ONLY way an allow:false becomes signable is an escalation
    // that a human has explicitly confirmed out-of-band — every other check having passed.
    let gate: Decision = decision;
    if (!decision.allow && 'escalate' in decision && decision.escalate && opts.humanApproved) {
      gate = { allow: true };
    }

    if (gate.allow !== true) {
      if (!decision.allow && 'escalate' in decision && decision.escalate) {
        return { status: 'ESCALATE', quoteId, reason: decision.reason };
      }
      return { status: 'REFUSED', quoteId, reason: (decision as { reason: string }).reason };
    }

    // Pre-flight (gas top-up etc.) BEFORE the quote is claimed in the ledger. A failure
    // here has signed nothing: return FAILED with the reason but leave the quote
    // unclaimed, so the same quote can be retried once the underlying issue (e.g. the
    // USDC→ETH swap, ETH bootstrap) is resolved — instead of being burned forever.
    if (d.prepare) {
      try {
        await d.prepare();
      } catch (e) {
        return { status: 'FAILED', quoteId, reason: `pre-flight failed (nothing signed; quote still payable): ${(e as Error).message}` };
      }
    }

    // Record PENDING in the ledger BEFORE broadcast, so a crash mid-payment is
    // reconcilable from chain and never silently re-paid.
    try {
      d.ledger.markPending({ quoteId, token: quote.token, recipient: quote.recipient, amount: quote.amount });
    } catch {
      // PK collision => a concurrent attempt already claimed this quote. Return its state.
      const existing = d.ledger.get(quoteId);
      if (existing) return { status: 'DUPLICATE', quoteId, row: existing };
      return { status: 'REFUSED', quoteId, reason: 'ledger conflict' };
    }

    // ===================================================================================
    // THE SINGLE GATED SIGNING CALL SITE. Reached only when gate.allow === true.
    // ===================================================================================
    const recipient = getAddress(quote.recipient); // checksummed for the actual transfer
    let bc: BroadcastResult;
    try {
      bc = await d.broadcast(quote.token.toLowerCase(), recipient, quote.amount);
    } catch (e) {
      // Sign/broadcast failed outright — nothing landed. Mark FAILED so the quote is
      // not retried as a silent double-pay; a fresh quote is required.
      d.ledger.markFailed(quoteId);
      return { status: 'FAILED', quoteId, reason: `broadcast failed: ${(e as Error).message}` };
    }
    // ===================================================================================

    d.ledger.attachTxHash(quoteId, bc.txHash);

    // Wait for confirmation depth. On timeout/uncertainty, LEAVE it PENDING with the
    // txHash for restart reconciliation — do NOT re-broadcast and do NOT mark FAILED.
    let outcome: 'confirmed' | 'failed';
    try {
      outcome = await bc.wait(d.confirmations);
    } catch {
      return { status: 'PENDING', quoteId, txHash: bc.txHash };
    }

    if (outcome === 'failed') {
      d.ledger.markFailed(quoteId);
      return { status: 'FAILED', quoteId, reason: 'transaction reverted' };
    }

    d.ledger.markConfirmed(quoteId, bc.txHash);
    try {
      await d.finalize(quoteId, bc.txHash);
      // Only NOW is crediting guaranteed: the server accepted the payment. Record it so
      // reconcile does not re-drive an already-finalized row.
      d.ledger.markFinalized(quoteId);
    } catch {
      // Finalize is idempotent but NOT guaranteed here: the server may reject a tx that is
      // on-chain confirmed but not yet at the server's confirmation depth. Leave
      // finalized_at NULL so startup reconciliation retries it once the chain is deep
      // enough — that retry is what actually credits the balance.
    }
    return { status: 'CONFIRMED', quoteId, txHash: bc.txHash };
  }

  /** dry_run: run the full evaluation and report the decision + the tx that WOULD be
   *  signed. Broadcasts NOTHING. */
  async dryRun(quote: SignedQuote): Promise<{
    decision: Decision | { allow: false; reason: string };
    wouldSign?: { token: string; recipient: string; amount: string };
  }> {
    const d = this.deps;
    const v = verifyQuote(quote, {
      serverQuotePubKey: d.serverQuotePubKey,
      ...(d.nowSeconds ? { now: d.nowSeconds() } : {}),
    });
    if (!v.ok) return { decision: { allow: false, reason: `quote rejected: ${v.reason}` } };

    let balance: string;
    try {
      balance = await d.readBalance(quote.token.toLowerCase());
    } catch (e) {
      return { decision: { allow: false, reason: `balance read failed: ${(e as Error).message}` } };
    }
    const q: QuoteForPolicy = {
      quoteId: quote.quoteId,
      token: quote.token,
      recipient: quote.recipient,
      amount: quote.amount,
      chainId: quote.chainId,
    };
    const decision = evaluate(q, {
      policy: resolvePolicy(d.policy),
      walletBalance: () => balance,
      spentLast24h: (token) => d.ledger.spentLast24h(token),
      isQuoteSeen: (id) => d.ledger.isQuoteSeen(id),
    });
    const result: {
      decision: Decision;
      wouldSign?: { token: string; recipient: string; amount: string };
    } = { decision };
    if (decision.allow || ('escalate' in decision && decision.escalate)) {
      result.wouldSign = { token: quote.token.toLowerCase(), recipient: getAddress(quote.recipient), amount: quote.amount };
    }
    return result;
  }
}
