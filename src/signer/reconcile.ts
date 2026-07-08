// Startup reconciliation of PENDING payments. On process start, every PENDING row is
// resolved against the chain by its tx_hash. NEVER re-broadcast blindly and never
// re-sign a new tx for a PENDING quote without proving the old one did not land — that
// is how you double-pay.

import type { JsonRpcProvider } from 'ethers';
import type { Ledger } from '../ledger/ledger.js';

export interface ReconcileReport {
  quoteId: string;
  outcome: 'confirmed' | 'failed' | 'still-pending' | 'no-txhash';
}

export async function reconcilePending(
  ledger: Pick<Ledger, 'pending' | 'markConfirmed' | 'markFailed'>,
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
        } catch {
          /* best-effort, idempotent server-side */
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
  return reports;
}
