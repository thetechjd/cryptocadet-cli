// Startup reconciliation of PENDING payments. On process start, every PENDING row is
// resolved against the chain by its tx_hash. NEVER re-broadcast blindly and never
// re-sign a new tx for a PENDING quote without proving the old one did not land — that
// is how you double-pay.

import type { JsonRpcProvider } from 'ethers';
import type { Ledger } from '../ledger/ledger.js';

export interface ReconcileReport {
  quoteId: string;
  outcome: 'confirmed' | 'failed' | 'still-pending' | 'no-txhash' | 'finalized' | 'finalize-retry-failed';
}

export async function reconcilePending(
  ledger: Pick<Ledger, 'pending' | 'awaitingFinalize' | 'markConfirmed' | 'markFinalized' | 'markFailed'>,
  provider: JsonRpcProvider,
  confirmations: number,
  finalize?: (quoteId: string, txHash: string) => Promise<void>,
): Promise<ReconcileReport[]> {
  const reports: ReconcileReport[] = [];
  for (const row of ledger.pending()) {
    if (!row.tx_hash) {
      // Broadcast never recorded a hash => it almost certainly never went out. A row with
      // no hash cannot be proven to have landed, so we mark it FAILED; a new quote is
      // required to retry. (Marking FAILED, not deleting, preserves idempotency history.)
      ledger.markFailed(row.quote_id);
      reports.push({ quoteId: row.quote_id, outcome: 'no-txhash' });
      continue;
    }
    const receipt = await provider.getTransactionReceipt(row.tx_hash);
    if (!receipt) {
      // Tx unknown to the node: either still in mempool or dropped. Leave PENDING; do
      // NOT re-sign. A later run reconciles again.
      reports.push({ quoteId: row.quote_id, outcome: 'still-pending' });
      continue;
    }
    const confs = await receipt.confirmations();
    if (receipt.status === 1 && confs >= confirmations) {
      ledger.markConfirmed(row.quote_id, row.tx_hash);
      if (finalize) {
        try {
          await finalize(row.quote_id, row.tx_hash);
          ledger.markFinalized(row.quote_id); // server accepted → crediting done
        } catch {
          /* leave finalized_at NULL; the awaitingFinalize sweep below retries it */
        }
      }
      reports.push({ quoteId: row.quote_id, outcome: 'confirmed' });
    } else if (receipt.status === 0) {
      ledger.markFailed(row.quote_id);
      reports.push({ quoteId: row.quote_id, outcome: 'failed' });
    } else {
      reports.push({ quoteId: row.quote_id, outcome: 'still-pending' });
    }
  }

  // Second pass: rows that are CONFIRMED on-chain but whose server finalize never
  // succeeded (e.g. finalize was fired at a shallower depth than the server accepts, then
  // its error was swallowed). Retry finalize now — the chain has had more time to deepen —
  // so the payment is finally recorded server-side and the balance gets credited. Re-paying
  // is impossible here: we only call finalize, never broadcast.
  if (finalize) {
    for (const row of ledger.awaitingFinalize()) {
      if (!row.tx_hash) continue; // cannot finalize without a tx to point at
      try {
        await finalize(row.quote_id, row.tx_hash);
        ledger.markFinalized(row.quote_id);
        reports.push({ quoteId: row.quote_id, outcome: 'finalized' });
      } catch {
        // Still not accepted (likely still too shallow); leave NULL for the next run.
        reports.push({ quoteId: row.quote_id, outcome: 'finalize-retry-failed' });
      }
    }
  }

  return reports;
}
