import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { AGENT_TOOL_NAMES } from '../src/mcp/agent-tools.js';

const here = dirname(fileURLToPath(import.meta.url));
// Strip comments: we assert on CODE, not prose that explains what is deliberately absent.
const stripComments = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
const src = (p: string) => stripComments(readFileSync(join(here, '..', 'src', p), 'utf8'));

// The human-only verbs the CLI exposes. NONE may appear on the agent transport.
const HUMAN_ONLY_VERBS = [
  'wallet:show', 'policy:show', 'policy:set', 'allowlist:add', 'allowlist:remove',
  'topup:request', 'rotate', 'sweep', 'reserve:check',
  'login', 'logout', 'product:list', 'product:create', 'product:update', 'product:disable',
  'payout:set', 'subs:list', 'subs:create', 'subs:cancel', 'history',
];

describe('two-surface separation (instruction 02 acceptance)', () => {
  it('the agent transport exposes EXACTLY the four agent verbs', () => {
    expect([...AGENT_TOOL_NAMES].sort()).toEqual(['check_balance', 'dry_run', 'pay', 'quote_payment']);
  });

  it('no human-only verb is also an agent verb (disjoint surfaces)', () => {
    for (const v of HUMAN_ONLY_VERBS) expect(AGENT_TOOL_NAMES as readonly string[]).not.toContain(v);
  });

  it('the agent tool module never references key/limit/allowlist/rotate/sweep operations', () => {
    const agentSrc = src('mcp/agent-tools.ts');
    for (const banned of ['rotate', 'sweep', 'unlockAgentPrivateKey', 'setLimit', 'editAllowlist', 'export_key', 'export-key']) {
      expect(agentSrc).not.toContain(banned);
    }
  });

  it('the runtime registers tools ONLY via buildAgentTools (single registration path)', () => {
    const rt = src('runtime.ts');
    expect(rt).toContain('buildAgentTools(');
    // The runtime must not pull in the human-only verb implementations.
    expect(rt).not.toContain('human-verbs');
    expect(rt).not.toContain('revoke/sweep');
  });
});
