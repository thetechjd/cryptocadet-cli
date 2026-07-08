import { describe, it, expect } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { buildMcpServer } from '../src/mcp/mcp-server.js';
import { buildAgentTools } from '../src/mcp/agent-tools.js';
import { PaymentSigner } from '../src/signer/signer.js';
import { Ledger } from '../src/ledger/ledger.js';
import { policyWithUsdc, USDC } from './helpers/fixtures.js';
import { makeTestQuoteSigner } from './helpers/quote-signer.js';

const server = makeTestQuoteSigner();

function buildTools(readBalance: () => Promise<string>) {
  const signer = new PaymentSigner({
    policy: policyWithUsdc(),
    serverQuotePubKey: server.publicKeyB64,
    confirmations: 1,
    ledger: new Ledger({ path: ':memory:' }),
    readBalance,
    broadcast: async () => ({ txHash: '0x', wait: async () => 'confirmed' }),
    finalize: async () => {},
  });
  return buildAgentTools({
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
    readBalance,
  });
}

async function connectedClient(readBalance: () => Promise<string> = async () => '0') {
  const mcp = buildMcpServer(buildTools(readBalance), { name: 'cryptocadet', version: '0.0.0-test' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await mcp.connect(serverTransport);
  const client = new Client({ name: 'test-agent', version: '1.0.0' });
  await client.connect(clientTransport);
  return { client, mcp };
}

const HUMAN_ONLY = ['rotate', 'sweep', 'set_limit', 'edit_allowlist', 'export_key', 'reserve:set', 'add_wallet'];

describe('MCP agent transport', () => {
  it('exposes EXACTLY the four agent verbs — and no human-only verb', async () => {
    const { client } = await connectedClient();
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual(['check_balance', 'dry_run', 'pay', 'quote_payment']);
    for (const h of HUMAN_ONLY) expect(names).not.toContain(h);
  });

  it('each tool advertises an input schema', async () => {
    const { client } = await connectedClient();
    const { tools } = await client.listTools();
    const pay = tools.find((t) => t.name === 'pay');
    expect(pay?.inputSchema?.properties?.quoteId).toBeTruthy();
  });

  it('check_balance returns balance + spendable (balance minus reserve)', async () => {
    const { client } = await connectedClient(async () => '30000000'); // 30 USDC, reserve 20
    const res = await client.callTool({ name: 'check_balance', arguments: { token: USDC } });
    const content = res.content as Array<{ type: string; text: string }>;
    const payload = JSON.parse(content[0]!.text) as { token: string; balance: string; spendable: string };
    expect(payload).toMatchObject({ token: USDC, balance: '30000000', spendable: '10000000' });
  });

  // Both invalid cases surface as an error — the SDK may either reject or resolve with
  // isError:true depending on the failure; accept either.
  const isErrorOutcome = (p: Promise<unknown>) =>
    p.then((r) => Boolean((r as { isError?: boolean }).isError)).catch(() => true);

  it('a call missing a required argument (pay without quoteId) errors', async () => {
    const { client } = await connectedClient();
    expect(await isErrorOutcome(client.callTool({ name: 'pay', arguments: {} }))).toBe(true);
  });

  it('an unknown tool name errors (human verbs are simply not there)', async () => {
    const { client } = await connectedClient();
    expect(await isErrorOutcome(client.callTool({ name: 'rotate', arguments: {} }))).toBe(true);
  });
});
