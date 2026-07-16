import { describe, it, expect } from 'vitest';
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import { parseSignedQuote, resolveQuoteRaw } from '../src/cli/checkout.js';
import { PaymentSigner } from '../src/signer/signer.js';
import { Ledger } from '../src/ledger/ledger.js';
import { policyWithUsdc, USDC, SELLER, recordingBroadcaster } from './helpers/fixtures.js';
import { makeTestQuoteSigner, makeQuote } from './helpers/quote-signer.js';

const server = makeTestQuoteSigner();
const validQuoteJson = () => JSON.stringify(server.signQuote(makeQuote({ token: USDC, recipient: SELLER, amount: '1000000' })));

describe('parseSignedQuote', () => {
  it('parses a valid merchant SignedQuote', () => {
    const q = parseSignedQuote(validQuoteJson());
    expect(q).toMatchObject({ token: USDC, amount: '1000000', purpose: 'per_call' });
    expect(typeof q.serverSig).toBe('string');
    expect(q.recipient).toBe(SELLER); // EIP-55 checksummed, preserved
  });

  it('normalization is signature-preserving — a parsed quote still pays through the gated signer', async () => {
    // THE point of the verb: a merchant-supplied quote, once parsed, verifies + pays via
    // the EXACT same PaymentSigner.pay path (one broadcast), proving no re-fetch is needed.
    const rec = recordingBroadcaster();
    const signer = new PaymentSigner({
      policy: policyWithUsdc(),
      serverQuotePubKey: server.publicKeyB64,
      confirmations: 1,
      ledger: new Ledger({ path: ':memory:' }),
      readBalance: async () => '100000000',
      broadcast: rec.broadcast,
      finalize: async () => {},
    });
    const quote = parseSignedQuote(validQuoteJson());
    const r = await signer.pay(quote);
    expect(r.status).toBe('CONFIRMED');
    expect(rec.calls).toHaveLength(1);
  });

  it('rejects non-JSON', () => {
    expect(() => parseSignedQuote('not json')).toThrow(/valid JSON/);
  });

  it('rejects a JSON array (not an object)', () => {
    expect(() => parseSignedQuote('[]')).toThrow(/JSON object/);
  });

  it('rejects a missing required field', () => {
    const obj = JSON.parse(validQuoteJson());
    delete obj.serverSig;
    expect(() => parseSignedQuote(JSON.stringify(obj))).toThrow(/missing "serverSig"/);
  });

  it('rejects a non-integer amount', () => {
    const obj = JSON.parse(validQuoteJson());
    obj.amount = '1.5';
    expect(() => parseSignedQuote(JSON.stringify(obj))).toThrow(/base-unit integer/);
  });

  it('rejects a malformed recipient address', () => {
    const obj = JSON.parse(validQuoteJson());
    obj.recipient = '0xnothex';
    expect(() => parseSignedQuote(JSON.stringify(obj))).toThrow(/valid address/);
  });

  it('rejects a bad token address', () => {
    const obj = JSON.parse(validQuoteJson());
    obj.token = 'usdc';
    expect(() => parseSignedQuote(JSON.stringify(obj))).toThrow(/ERC-20 address/);
  });

  it('rejects an unknown purpose', () => {
    const obj = JSON.parse(validQuoteJson());
    obj.purpose = 'transfer';
    expect(() => parseSignedQuote(JSON.stringify(obj))).toThrow(/purpose/);
  });
});

describe('resolveQuoteRaw', () => {
  it('prefers --quote-json', () => {
    expect(resolveQuoteRaw({ json: '{"a":1}', file: '/nope' })).toBe('{"a":1}');
  });

  it('reads --quote-file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ccx-checkout-'));
    const path = join(dir, 'quote.json');
    writeFileSync(path, validQuoteJson());
    expect(resolveQuoteRaw({ file: path })).toBe(readFileSync(path, 'utf8'));
  });

  it('falls back to stdin when it has content', () => {
    expect(resolveQuoteRaw({ stdin: () => '{"from":"stdin"}' })).toBe('{"from":"stdin"}');
  });

  it('throws with a clear message when no source is given', () => {
    expect(() => resolveQuoteRaw({})).toThrow(/--quote-json|--quote-file/);
  });

  it('throws for an unreadable --quote-file', () => {
    expect(() => resolveQuoteRaw({ file: '/definitely/does/not/exist.json' })).toThrow(/cannot read/);
  });
});

describe('checkout verb wiring', () => {
  // The verb must reuse the gated signer, never a new broadcast/signing path.
  const here = dirname(fileURLToPath(import.meta.url));
  const indexSrc = readFileSync(join(here, '..', 'src', 'cli', 'index.ts'), 'utf8');

  it('routes payment through rt.signer.pay (the single gated path)', () => {
    expect(indexSrc).toContain('rt.signer.pay(');
  });

  it('introduces no direct broadcaster/key-signing call in the CLI', () => {
    expect(indexSrc).not.toContain('sendTransfer(');
    expect(indexSrc).not.toContain('liveBroadcaster(');
  });
});
