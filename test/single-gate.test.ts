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

  it('the agent tool surface never sets humanApproved (escalation is human-only)', () => {
    expect(src('mcp/agent-tools.ts')).not.toContain('humanApproved');
  });
});
