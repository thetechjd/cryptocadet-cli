// HUMAN-ONLY `checkout` verb helpers.
//
// A merchant (e.g. RetroDeck) issues a signed quote from ITS OWN cryptocadet server
// account — so the buyer CANNOT re-fetch it by id (`GET /v4/quotes/:id` is scoped to the
// issuing account). Instead the merchant hands the buyer the FULL SignedQuote, and this
// verb pays it: the signer re-verifies the serverSig against the pinned pubkey and
// re-validates every field against local policy before the single gated broadcast, so a
// tampered or forged quote is refused regardless of how it was transported.
//
// This module only PARSES/VALIDATES the quote shape. The actual payment goes through the
// same `PaymentSigner.pay()` the agent tools use — no new signing call site is added.

import { readFileSync } from 'node:fs';
import { getAddress } from 'ethers';
import type { SignedQuote } from '../types/quote.js';

const REQUIRED_KEYS = ['quoteId', 'chainId', 'token', 'recipient', 'amount', 'purpose', 'expiresAt', 'serverSig'] as const;

/** Parse a merchant-supplied SignedQuote from JSON and validate its shape. Cryptographic
 *  validity (serverSig, expiry) is NOT checked here — that is the signer's job. This only
 *  guarantees a well-formed object so we fail with a clear message instead of a cryptic
 *  one deep in the signer. Normalization is signature-preserving: `token` is lowercased
 *  (the canonical serialization lowercases it anyway) and `recipient` is run through the
 *  idempotent EIP-55 checksum (the server signed the checksummed form). */
export function parseSignedQuote(raw: string): SignedQuote {
  let obj: unknown;
  try {
    obj = JSON.parse(raw);
  } catch {
    throw new Error('checkout: quote is not valid JSON');
  }
  if (typeof obj !== 'object' || obj === null || Array.isArray(obj)) {
    throw new Error('checkout: quote must be a JSON object');
  }
  const q = obj as Record<string, unknown>;
  for (const k of REQUIRED_KEYS) {
    if (q[k] === undefined || q[k] === null) throw new Error(`checkout: quote missing "${k}"`);
  }
  if (typeof q.quoteId !== 'string' || q.quoteId.length === 0) throw new Error('checkout: quoteId must be a non-empty string');
  if (typeof q.chainId !== 'number' || !Number.isFinite(q.chainId)) throw new Error('checkout: chainId must be a number');
  if (typeof q.token !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(q.token)) throw new Error('checkout: token must be an ERC-20 address');
  if (typeof q.recipient !== 'string') throw new Error('checkout: recipient must be a string');
  if (typeof q.amount !== 'string' || !/^\d+$/.test(q.amount)) throw new Error('checkout: amount must be a base-unit integer string');
  if (typeof q.expiresAt !== 'number' || !Number.isFinite(q.expiresAt)) throw new Error('checkout: expiresAt must be a number');
  if (typeof q.serverSig !== 'string' || q.serverSig.length === 0) throw new Error('checkout: serverSig must be a string');
  if (q.purpose !== 'per_call' && q.purpose !== 'subscription_setup') {
    throw new Error("checkout: purpose must be 'per_call' or 'subscription_setup'");
  }

  let recipient: string;
  try {
    recipient = getAddress(q.recipient); // validates + EIP-55 checksums (idempotent)
  } catch {
    throw new Error('checkout: recipient is not a valid address');
  }

  return {
    quoteId: q.quoteId,
    chainId: q.chainId as SignedQuote['chainId'],
    token: q.token.toLowerCase(),
    recipient,
    amount: q.amount,
    purpose: q.purpose,
    expiresAt: q.expiresAt,
    serverSig: q.serverSig,
  };
}

/** Resolve the raw quote JSON from `--quote-json <json>`, `--quote-file <path>`, or stdin.
 *  Exactly one source is required; `--quote-json` wins, then `--quote-file`, then stdin. */
export function resolveQuoteRaw(opts: { json?: string; file?: string; stdin?: () => string }): string {
  if (opts.json !== undefined) return opts.json;
  if (opts.file !== undefined) {
    try {
      return readFileSync(opts.file, 'utf8');
    } catch (e) {
      throw new Error(`checkout: cannot read --quote-file ${opts.file}: ${(e as Error).message}`);
    }
  }
  if (opts.stdin) {
    const s = opts.stdin();
    if (s.trim().length > 0) return s;
  }
  throw new Error('checkout: provide the signed quote via --quote-json <json> or --quote-file <path>');
}
