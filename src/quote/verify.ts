// Verify the server's Ed25519 signature over a quote, and its expiry.
//
// Provenance verification is DEFENSE-IN-DEPTH. The real backstop is the local policy
// re-check (evaluate()): a compromised server could sign a malicious-but-valid quote,
// and policy would still refuse it. But an invalid/expired signature is refused BEFORE
// policy even runs — cheap, and it stops MITM'd or replayed quotes early.

import { createPublicKey, verify as cryptoVerify } from 'node:crypto';
import type { SignedQuote } from '../types/quote.js';
import { canonicalQuoteBytes, stripSig } from './canonical.js';

// DER SPKI prefix for a raw 32-byte Ed25519 public key.
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

function publicKeyFromRawB64(rawB64: string) {
  const raw = Buffer.from(rawB64, 'base64');
  if (raw.length !== 32) throw new Error('serverQuotePubKey must be a 32-byte Ed25519 key (base64)');
  return createPublicKey({ key: Buffer.concat([ED25519_SPKI_PREFIX, raw]), format: 'der', type: 'spki' });
}

export type QuoteVerifyResult =
  | { ok: true }
  | { ok: false; reason: string };

export interface VerifyOpts {
  /** base64 raw Ed25519 public key, pinned in config.json */
  serverQuotePubKey: string;
  /** unix seconds; defaults to wall clock */
  now?: number;
}

export function verifyQuote(q: SignedQuote, opts: VerifyOpts): QuoteVerifyResult {
  const now = opts.now ?? Math.floor(Date.now() / 1000);

  // Expiry first — a perfectly-signed but stale quote is still refused.
  if (typeof q.expiresAt !== 'number' || !Number.isFinite(q.expiresAt))
    return { ok: false, reason: 'missing or invalid expiresAt' };
  if (q.expiresAt <= now) return { ok: false, reason: 'quote expired' };

  let sig: Buffer;
  try {
    sig = Buffer.from(q.serverSig, 'base64');
  } catch {
    return { ok: false, reason: 'malformed serverSig' };
  }
  if (sig.length !== 64) return { ok: false, reason: 'serverSig wrong length' };

  let pub;
  try {
    pub = publicKeyFromRawB64(opts.serverQuotePubKey);
  } catch (e) {
    return { ok: false, reason: `bad pinned pubkey: ${(e as Error).message}` };
  }

  const msg = canonicalQuoteBytes(stripSig(q));
  let ok = false;
  try {
    ok = cryptoVerify(null, msg, pub, sig);
  } catch {
    return { ok: false, reason: 'signature verification threw' };
  }
  return ok ? { ok: true } : { ok: false, reason: 'invalid serverSig' };
}
