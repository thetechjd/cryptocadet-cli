// MCP host registration (RDK-style). Detect a known agent host (Claude Desktop) and offer
// to add the CryptoCadet MCP server to its config. The registered command runs
// `cryptocadet mcp:serve`, which exposes EXACTLY the four agent verbs over stdio.

import { homedir } from 'node:os';
import { join } from 'node:path';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export const MCP_SERVER_NAME = 'cryptocadet';

export interface McpServerEntry {
  command: string;
  args: string[];
}

/** The entry a host needs to launch the agent surface. */
export function buildServerEntry(command = 'cryptocadet'): McpServerEntry {
  return { command, args: ['mcp:serve'] };
}

/** Claude Desktop's config path for the current platform (best-effort). */
export function claudeDesktopConfigPath(): string {
  if (process.platform === 'darwin') return join(homedir(), 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json');
  if (process.platform === 'win32') return join(process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'), 'Claude', 'claude_desktop_config.json');
  return join(homedir(), '.config', 'Claude', 'claude_desktop_config.json');
}

export interface DetectedHost {
  name: string;
  configPath: string;
  present: boolean; // config file already exists
}

export function detectMcpHosts(): DetectedHost[] {
  const claude = claudeDesktopConfigPath();
  return [{ name: 'Claude Desktop', configPath: claude, present: existsSync(claude) }];
}

/** Merge a cryptocadet MCP server entry into an existing host config object (pure). */
export function mergeMcpConfig(existing: unknown, entry: McpServerEntry, name = MCP_SERVER_NAME): Record<string, unknown> {
  const base = (existing && typeof existing === 'object' ? { ...(existing as Record<string, unknown>) } : {}) as Record<string, unknown>;
  const servers = (base.mcpServers && typeof base.mcpServers === 'object' ? { ...(base.mcpServers as Record<string, unknown>) } : {}) as Record<string, unknown>;
  servers[name] = entry;
  base.mcpServers = servers;
  return base;
}

export interface RegisterResult {
  registered: boolean;
  configPath: string;
  createdFile: boolean;
}

/** Write the merged config to the host's file (creating it if needed). */
export function registerWithHost(configPath: string, command = 'cryptocadet'): RegisterResult {
  let existing: unknown = {};
  const createdFile = !existsSync(configPath);
  if (!createdFile) {
    try {
      existing = JSON.parse(readFileSync(configPath, 'utf8'));
    } catch {
      existing = {}; // malformed/empty — start fresh but keep a backup-safe merge
    }
  }
  const merged = mergeMcpConfig(existing, buildServerEntry(command));
  mkdirSync(dirname(configPath), { recursive: true });
  writeFileSync(configPath, JSON.stringify(merged, null, 2));
  return { registered: true, configPath, createdFile };
}

/** The JSON snippet to print when a host can't be auto-registered. */
export function manualSnippet(command = 'cryptocadet'): string {
  return JSON.stringify({ mcpServers: { [MCP_SERVER_NAME]: buildServerEntry(command) } }, null, 2);
}
