// Idempotency + pending-tx ledger (ledger.sqlite). Uses Node's built-in sqlite — no
// native build step. Amounts are stored as base-unit decimal strings and summed with
// BigInt in JS (never floats, never SQL SUM over text).

import type { DatabaseSync } from 'node:sqlite';
import { createRequire } from 'node:module';
import { paths } from '../config/paths.js';

// Load node:sqlite via createRequire rather than a static import: node:sqlite is still
// experimental and some bundlers/test transformers (vite) fail to externalize it. A
// runtime require sidesteps static analysis without changing behavior.
const nodeRequire = createRequire(import.meta.url);
const { DatabaseSync: SqliteDatabase } = nodeRequire('node:sqlite') as typeof import('node:sqlite');
import { ensureRoot } from '../config/config.js';

export type PaymentStatus = 'PENDING' | 'CONFIRMED' | 'FAILED';

export interface PaymentRow {
  quote_id: string;
  token: string;
  recipient: string;
  amount: string;
  tx_hash: string | null;
  status: PaymentStatus;
  created_at: number;
  confirmed_at: number | null;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS payments (
  quote_id     TEXT PRIMARY KEY,
  token        TEXT NOT NULL,
  recipient    TEXT NOT NULL,
  amount       TEXT NOT NULL,
  tx_hash      TEXT,
  status       TEXT NOT NULL,
  created_at   INTEGER NOT NULL,
  confirmed_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_payments_token_time ON payments(token, confirmed_at);
`;

const DAY_MS = 24 * 60 * 60 * 1000;

export class Ledger {
  private db: DatabaseSync;
  private now: () => number;

  constructor(opts?: { path?: string; now?: () => number }) {
    if (!opts?.path) ensureRoot();
    this.db = new SqliteDatabase(opts?.path ?? paths.ledger());
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec(SCHEMA);
    this.now = opts?.now ?? Date.now;
  }

  close(): void {
    this.db.close();
  }

  /** Idempotency: true if a row exists in ANY status. */
  isQuoteSeen(quoteId: string): boolean {
    const row = this.db.prepare('SELECT 1 FROM payments WHERE quote_id = ?').get(quoteId);
    return row !== undefined;
  }

  get(quoteId: string): PaymentRow | undefined {
    return this.db.prepare('SELECT * FROM payments WHERE quote_id = ?').get(quoteId) as
      | unknown as PaymentRow | undefined;
  }

  /** Insert a PENDING row BEFORE broadcast. Throws on duplicate quote_id (caller must
   *  have checked isQuoteSeen first; the PK constraint is the last-line guard). */
  markPending(p: { quoteId: string; token: string; recipient: string; amount: string }): void {
    this.db
      .prepare(
        'INSERT INTO payments (quote_id, token, recipient, amount, tx_hash, status, created_at, confirmed_at) VALUES (?, ?, ?, ?, NULL, ?, ?, NULL)',
      )
      .run(p.quoteId, p.token.toLowerCase(), p.recipient.toLowerCase(), p.amount, 'PENDING', this.now());
  }

  /** Record the broadcast tx hash on an existing PENDING row. */
  attachTxHash(quoteId: string, txHash: string): void {
    this.db.prepare('UPDATE payments SET tx_hash = ? WHERE quote_id = ?').run(txHash, quoteId);
  }

  markConfirmed(quoteId: string, txHash: string): void {
    this.db
      .prepare('UPDATE payments SET status = ?, tx_hash = ?, confirmed_at = ? WHERE quote_id = ?')
      .run('CONFIRMED', txHash, this.now(), quoteId);
  }

  markFailed(quoteId: string): void {
    this.db.prepare('UPDATE payments SET status = ? WHERE quote_id = ?').run('FAILED', quoteId);
  }

  /** Sum of CONFIRMED amounts for a token in the trailing 24h, as a base-unit string. */
  spentLast24h(token: string): string {
    const since = this.now() - DAY_MS;
    const rows = this.db
      .prepare("SELECT amount FROM payments WHERE token = ? AND status = 'CONFIRMED' AND confirmed_at >= ?")
      .all(token.toLowerCase(), since) as unknown as Array<{ amount: string }>;
    let sum = 0n;
    for (const r of rows) sum += BigInt(r.amount);
    return sum.toString();
  }

  /** Every PENDING row — reconciled against the chain on process start. */
  pending(): PaymentRow[] {
    return this.db.prepare("SELECT * FROM payments WHERE status = 'PENDING'").all() as unknown as PaymentRow[];
  }
}
