import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
// Strip comments: we assert on CODE, not prose that explains what is deliberately absent.
const stripComments = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
const src = (p: string) => stripComments(readFileSync(join(root, 'src', p), 'utf8'));

describe('command surface: plain CLI, no MCP', () => {
  it('ships no MCP server, tool registry or host registration', () => {
    expect(existsSync(join(root, 'src', 'mcp'))).toBe(false);
    expect(existsSync(join(root, 'src', 'init', 'mcp-host.ts'))).toBe(false);
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { dependencies?: Record<string, string> };
    expect(Object.keys(pkg.dependencies ?? {})).not.toContain('@modelcontextprotocol/sdk');
    expect(src('cli/index.ts')).not.toContain("'mcp:serve'");
  });

  it('`fetch` pays USDC only through the gated signer; credits only via the token', () => {
    const paid = src('x402/paid-fetch.ts');
    expect(paid).toContain('deps.signer.pay(');
    for (const banned of ['sendTransfer(', 'sendRoutedPayment(', 'broadcast(', 'unlockAgentPrivateKey']) {
      expect(paid).not.toContain(banned);
    }
  });

  it('the x402 client never reads, creates or clears the credits token itself', () => {
    // The runtime injects a reader; issuing tokens and card top-ups are separate commands.
    const paid = src('x402/paid-fetch.ts');
    for (const banned of ['agent-token', 'readAgentToken', 'storeAgentToken', 'createAgentToken', 'creditsCheckout', 'getKeychain']) {
      expect(paid).not.toContain(banned);
    }
  });

  it('the runtime does not pull in policy-editing or wallet-draining code', () => {
    const rt = src('runtime.ts');
    expect(rt).not.toContain('human-verbs');
    expect(rt).not.toContain('revoke/sweep');
  });
});
