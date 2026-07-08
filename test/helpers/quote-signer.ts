// Test-only stand-in for the SERVER's quote-signing role. The real signing key lives in
// the server, never the client; this helper exists so the client is testable before the
// server exists (per the architecture's three-field contract).

import { generateKeyPairSync, sign as cryptoSign, type KeyObject } from 'node:crypto';
import { getAddress } from 'ethers';
import type { SignedQuote, UnsignedQuote, QuotePurpose } from '../../src/types/quote.js';
import { canonicalQuoteBytes } from '../../src/quote/canonical.js';

export interface TestQuoteSigner {
  publicKeyB64: string; // raw 32-byte ed25519 pubkey, base64 — goes in config.serverQuotePubKey
  privateKey: KeyObject;
  signQuote: (q: UnsignedQuote) => SignedQuote;
}

const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

function rawPublicKeyB64(pub: KeyObject): string {
  const spki = pub.export({ format: 'der', type: 'spki' }) as Buffer;
  // strip the 12-byte SPKI header to get the raw 32-byte key
  return spki.subarray(ED25519_SPKI_PREFIX.length).toString('base64');
}

export function makeTestQuoteSigner(): TestQuoteSigner {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  return {
    publicKeyB64: rawPublicKeyB64(publicKey),
    privateKey,
    signQuote(q) {
      const sig = cryptoSign(null, canonicalQuoteBytes(q), privateKey);
      return { ...q, serverSig: sig.toString('base64') };
    },
  };
}

let counter = 0;
export function makeQuote(opts: {
  token: string;
  recipient: string;
  amount: string;
  chainId?: 8453 | 84532;
  purpose?: QuotePurpose;
  expiresAt?: number;
  quoteId?: string;
}): UnsignedQuote {
  counter += 1;
  return {
    quoteId: opts.quoteId ?? `quote-${counter}-${opts.amount}`,
    chainId: opts.chainId ?? 8453,
    token: opts.token.toLowerCase(),
    recipient: getAddress(opts.recipient),
    amount: opts.amount,
    purpose: opts.purpose ?? 'per_call',
    expiresAt: opts.expiresAt ?? Math.floor(Date.now() / 1000) + 300,
  };
}
