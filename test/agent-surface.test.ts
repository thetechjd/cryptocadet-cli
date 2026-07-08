import { describe, it, expect } from 'vitest';
import { AGENT_TOOL_NAMES, buildAgentTools } from '../src/mcp/agent-tools.js';
import { PaymentSigner } from '../src/signer/signer.js';
import { Ledger } from '../src/ledger/ledger.js';
import { policyWithUsdc } from './helpers/fixtures.js';
import { makeTestQuoteSigner } from './helpers/quote-signer.js';

// The human-only verbs that must NEVER appear on the agent transport.
const HUMAN_ONLY = ['add_wallet', 'set_limit', 'edit_allowlist', 'export_key', 'rotate', 'sweep', 'reserve:set'];

describe('agent MCP surface enforcement', () => {
  it('exposes EXACTLY the four agent-facing verbs', () => {
    expect([...AGENT_TOOL_NAMES].sort()).toEqual(['check_balance', 'dry_run', 'pay', 'quote_payment']);
  });

  it('contains no human-only verb', () => {
    for (const h of HUMAN_ONLY) expect(AGENT_TOOL_NAMES as readonly string[]).not.toContain(h);
  });

  it('the registry is frozen (cannot be mutated to smuggle a verb in)', () => {
    expect(Object.isFrozen(AGENT_TOOL_NAMES)).toBe(true);
  });

  it('buildAgentTools returns handlers only for the four verbs', () => {
    const server = makeTestQuoteSigner();
    const signer = new PaymentSigner({
      policy: policyWithUsdc(),
      serverQuotePubKey: server.publicKeyB64,
      confirmations: 1,
      ledger: new Ledger({ path: ':memory:' }),
      readBalance: async () => '0',
      broadcast: async () => ({ txHash: '0x', wait: async () => 'confirmed' }),
      finalize: async () => {},
    });
    const tools = buildAgentTools({
      policy: policyWithUsdc(),
      signer,
      server: {
        requestQuote: async () => {
          throw new Error('unused');
        },
        getQuoteById: async () => {
          throw new Error('unused');
        },
        finalize: async () => ({ status: 'recorded' }),
      },
      readBalance: async () => '0',
    });
    expect(Object.keys(tools).sort()).toEqual(['check_balance', 'dry_run', 'pay', 'quote_payment']);
  });
});
