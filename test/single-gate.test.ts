import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// THE acceptance criterion for this component: exactly one signing call site for the
// agent payment path, gated on the policy engine's allow. This test proves it by
// inspection of the source — if a second signing path is ever added to the payment flow,
// this fails.

const here = dirname(fileURLToPath(import.meta.url));
// Strip comments so the structural proof counts CODE, not prose that mentions the calls.
const stripComments = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
const src = (p: string) => stripComments(readFileSync(join(here, '..', 'src', p), 'utf8'));
const count = (hay: string, needle: string) => hay.split(needle).length - 1;

describe('single gated signer call site', () => {
  it('signer.ts invokes the broadcaster exactly once', () => {
    const signer = src('signer/signer.ts');
    expect(count(signer, 'deps.broadcast(')).toBe(0); // it is destructured as `d`
    expect(count(signer, 'd.broadcast(')).toBe(1);
  });

  it('the single broadcast is preceded by a gate.allow !== true bail-out', () => {
    const signer = src('signer/signer.ts');
    const gateIdx = signer.indexOf('gate.allow !== true');
    const broadcastIdx = signer.indexOf('d.broadcast(');
    expect(gateIdx).toBeGreaterThan(0);
    expect(broadcastIdx).toBeGreaterThan(gateIdx); // gate check comes BEFORE the signature
  });

  it('the real key-signing primitive (sendTransfer) is wired in exactly one place', () => {
    // sendTransfer is defined in chain/erc20.ts and must be CALLED from only the live
    // broadcaster — the production tail of the single gated path.
    const liveB = src('signer/live-broadcaster.ts');
    expect(count(liveB, 'sendTransfer(')).toBe(1);
    // It must not be called anywhere in the agent tool surface or signer directly.
    expect(src('mcp/agent-tools.ts')).not.toContain('sendTransfer(');
    expect(src('signer/signer.ts')).not.toContain('sendTransfer(');
  });

  it('the routed (fee-split) payment is the same tail, not a second path', () => {
    // A routed quote is paid by approve(router, exact) + router.payWithToken inside ONE
    // primitive, called from the live broadcaster alongside sendTransfer — still behind the
    // single d.broadcast( call site and its gate.
    const liveB = src('signer/live-broadcaster.ts');
    expect(count(liveB, 'sendRoutedPayment(')).toBe(1);
    expect(src('mcp/agent-tools.ts')).not.toContain('sendRoutedPayment(');
    expect(src('signer/signer.ts')).not.toContain('sendRoutedPayment(');
    expect(src('signer/signer.ts')).not.toContain('chain/router');
    // The router primitive never transfers to an arbitrary address and never uses the
    // human-only collector approve primitive.
    const router = src('chain/router.ts');
    expect(router).not.toContain('sendTransfer(');
    expect(router).not.toContain('approveToken(');
    expect(count(router, '.approve!(')).toBe(1);
  });

  it('the agent tool surface never sets humanApproved (escalation is human-only)', () => {
    expect(src('mcp/agent-tools.ts')).not.toContain('humanApproved');
  });

  it('the gas-swap is a self-custody op confined to chain/swap.ts, not a merchant-pay site', () => {
    // The USDC->ETH gas top-up signs its own swap tx (a deliberate, policy-capped exception to
    // no-native-spending). Keep that signing OUT of the merchant-payment path: the swap must
    // not call the ERC-20 transfer primitive, and the signer must not import the swap module.
    const swap = src('chain/swap.ts');
    expect(count(swap, 'sendTransfer(')).toBe(0); // gas swap never signs a merchant transfer
    expect(src('signer/signer.ts')).not.toContain('swap.js'); // the gate stays swap-agnostic
    // The broadcaster invokes the top-up via an injected hook, not by importing swap directly,
    // so there is still exactly one sendTransfer call site in the payment tail (asserted above).
    expect(src('signer/live-broadcaster.ts')).not.toContain('swap.js');
  });

  it('the operator treasury signs with its own primitive and is unreachable from the agent path', () => {
    const serve = src('treasury/serve.ts');
    const executor = src('treasury/executor.ts');
    expect(count(serve, 'sendPayoutTransfer(')).toBe(1); // exactly one treasury signing site
    expect(serve).not.toContain('sendTransfer(');         // never the agent payment primitive
    expect(executor).not.toContain('sendPayoutTransfer('); // the executor stays key-free
    for (const f of ['mcp/agent-tools.ts', 'signer/signer.ts', 'signer/live-broadcaster.ts', 'runtime.ts']) {
      expect(src(f)).not.toContain('treasury');
    }
    expect(count(src('chain/erc20.ts'), 'sendPayoutTransfer(')).toBe(1); // defined once, called only from treasury
  });
});
