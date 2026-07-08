// Real MCP server surface. Wires the four agent-facing verbs (and ONLY those) onto an
// McpServer so an agent can call them over a transport. The human-only verbs are never
// registered here — the registry is built from AGENT_TOOL_NAMES, so there is no path by
// which key/limit/allowlist/rotate/sweep could be exposed to the agent.

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { AGENT_TOOL_NAMES, type AgentTool, type AgentToolName } from './agent-tools.js';

// Input schemas per verb. `pay`/`dry_run` take ONLY a quoteId — the agent can never
// supply a recipient/amount to `pay` (that rides on the server-issued quote).
const SCHEMAS: Record<AgentToolName, z.ZodRawShape> = {
  check_balance: {
    token: z.string().describe('ERC-20 token contract address (lowercased)'),
  },
  quote_payment: {
    token: z.string().describe('ERC-20 token contract address'),
    recipient: z.string().optional().describe('payout address (server re-resolves authoritatively)'),
    amount: z.string().optional().describe('amount in token base units, decimal string'),
    purpose: z.enum(['per_call', 'subscription_setup']).optional(),
  },
  pay: {
    quoteId: z.string().describe('a server-issued quote id to execute (re-checked against local policy)'),
  },
  dry_run: {
    quoteId: z.string().describe('a server-issued quote id to evaluate without broadcasting'),
  },
};

export interface McpServerInfo {
  name: string;
  version: string;
}

/** Build an McpServer exposing exactly the four agent verbs, backed by the runtime tools. */
export function buildMcpServer(tools: Record<AgentToolName, AgentTool>, info: McpServerInfo): McpServer {
  const server = new McpServer({ name: info.name, version: info.version });

  for (const name of AGENT_TOOL_NAMES) {
    const tool: AgentTool = tools[name];
    server.registerTool(
      name,
      { description: tool.description, inputSchema: SCHEMAS[name] },
      async (args: Record<string, unknown>) => {
        try {
          const result = await tool.handler(args ?? {});
          return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] };
        } catch (e) {
          // Surface refusals/errors as an MCP tool error rather than crashing the transport.
          return {
            isError: true,
            content: [{ type: 'text' as const, text: JSON.stringify({ error: (e as Error).message }) }],
          };
        }
      },
    );
  }

  return server;
}

/** Connect the server to a stdio transport (the default agent transport). stdout is the
 *  JSON-RPC channel — callers MUST keep all logging on stderr. */
export async function connectStdio(server: McpServer): Promise<() => Promise<void>> {
  const { StdioServerTransport } = await import('@modelcontextprotocol/sdk/server/stdio.js');
  const transport = new StdioServerTransport();
  await server.connect(transport);
  return () => server.close();
}
