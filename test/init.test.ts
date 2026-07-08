import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

import { renderBanner, colorSupported, COMPACT_BANNER } from '../src/brand/banner.js';
import { scaffoldPolicy, USDC_BY_CHAIN } from '../src/init/policy-scaffold.js';
import { satisfiesMin, checkNode, detectExistingInstall } from '../src/init/preflight.js';
import { buildServerEntry, mergeMcpConfig, registerWithHost, manualSnippet } from '../src/init/mcp-host.js';
import { runInit, refuseMainWalletKey } from '../src/init/wizard.js';
import { silentIO } from '../src/init/prompts.js';
import { loadConfig } from '../src/config/config.js';
import { loadPolicy } from '../src/config/policy-store.js';

const PUBKEY = randomBytes(32).toString('base64');

describe('banner', () => {
  it('plain (no color) contains the Base-only tagline and NO ANSI', () => {
    const b = renderBanner({ color: false, columns: 100 });
    expect(b).toContain('USDC payment rails for agents');
    expect(b).not.toContain('\x1b[');
    // retired v3 taglines are never printed
    expect(b).not.toMatch(/multi-chain|SmartMoney/i);
  });
  it('emits truecolor ANSI when color is on', () => {
    expect(renderBanner({ color: true, columns: 100 })).toContain('\x1b[38;2;');
  });
  it('falls back to the compact one-liner under 54 columns', () => {
    expect(renderBanner({ color: false, columns: 40 })).toBe(COMPACT_BANNER);
  });
  it('colorSupported is false under NO_COLOR / CI', () => {
    const prev = process.env.NO_COLOR;
    process.env.NO_COLOR = '1';
    expect(colorSupported()).toBe(false);
    if (prev === undefined) delete process.env.NO_COLOR;
    else process.env.NO_COLOR = prev;
  });
});

describe('policy scaffold (fail-closed)', () => {
  it('allowlists USDC with low caps but NO recipients', () => {
    const p = scaffoldPolicy(84532);
    const usdc = USDC_BY_CHAIN[84532];
    expect(p.allowlist[usdc]).toEqual({ symbol: 'USDC', decimals: 6, feeOnTransfer: false });
    expect(p.perTxCap[usdc]).toBe('1000000');
    expect(p.dailyCap[usdc]).toBe('5000000');
    expect(p.subscriptionReserve[usdc]).toBe('0');
    expect(p.requireHumanAboveTx[usdc]).toBe('500000');
    expect(p.recipients).toEqual([]); // cannot pay until a payee is added
  });
});

describe('preflight', () => {
  it('semver-ish min comparison', () => {
    expect(satisfiesMin('22.19.0', '22.5.0')).toBe(true);
    expect(satisfiesMin('22.5.0', '22.5.0')).toBe(true);
    expect(satisfiesMin('20.0.0', '22.5.0')).toBe(false);
    expect(satisfiesMin('22.4.9', '22.5.0')).toBe(false);
  });
  it('checkNode reports the running version', () => {
    expect(checkNode().version).toBe(process.versions.node);
  });
});

describe('mcp host registration', () => {
  it('builds the server entry (exactly mcp:serve)', () => {
    expect(buildServerEntry()).toEqual({ command: 'cryptocadet', args: ['mcp:serve'] });
  });
  it('merges without clobbering other servers', () => {
    const merged = mergeMcpConfig({ mcpServers: { other: { command: 'x', args: [] } } }, buildServerEntry());
    expect((merged.mcpServers as Record<string, unknown>).other).toBeTruthy();
    expect((merged.mcpServers as Record<string, unknown>).cryptocadet).toEqual({ command: 'cryptocadet', args: ['mcp:serve'] });
  });
  it('manualSnippet is valid JSON naming the four-verb server', () => {
    const snippet = JSON.parse(manualSnippet());
    expect(snippet.mcpServers.cryptocadet.args).toEqual(['mcp:serve']);
  });
});

describe('init wizard (non-interactive)', () => {
  let home: string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'cc-init-'));
    process.env.CRYPTOCADET_HOME = home;
    process.env.CRYPTOCADET_INSECURE_KEYCHAIN = '1';
  });
  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
    delete process.env.CRYPTOCADET_HOME;
    delete process.env.CRYPTOCADET_INSECURE_KEYCHAIN;
  });

  const base = { yes: true as const, json: true as const, role: 'buyer' as const, network: 'base-sepolia' as const, serverBaseUrl: 'http://localhost:4000', serverQuotePubKey: PUBKEY };

  it('fresh buyer init: encrypted key + keychain entry + fail-closed policy + config', async () => {
    const s = await runInit(base, { io: silentIO() });
    expect(s.fresh).toBe(true);
    expect(s.agentAddress).toMatch(/^0x[0-9a-f]{40}$/);
    expect(existsSync(join(home, 'agent.key.enc'))).toBe(true);
    expect(existsSync(join(home, 'policy.json'))).toBe(true);

    const cfg = loadConfig();
    expect(cfg.serverQuotePubKey).toBe(PUBKEY);
    expect(cfg.keychainRef).not.toBe(cfg.serverAuthRef); // separate secrets
    expect(loadPolicy().recipients).toEqual([]); // fail closed

    // the on-disk key file must not contain a plaintext private key
    expect(readFileSync(join(home, 'agent.key.enc'), 'utf8')).toMatch(/aes-256-gcm/);
  });

  it('re-run does NOT regenerate the agent key', async () => {
    const first = await runInit(base, { io: silentIO() });
    const second = await runInit(base, { io: silentIO() });
    expect(second.fresh).toBe(false);
    expect(second.agentAddress).toBe(first.agentAddress); // same wallet, untouched
  });

  it('fetches the server quote pubkey when not provided', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ serverQuotePubKey: 'FETCHED_KEY' }), { status: 200 })) as unknown as typeof fetch;
    await runInit({ yes: true, json: true, role: 'buyer', network: 'base-sepolia', serverBaseUrl: 'http://localhost:4000' }, { io: silentIO(), fetchImpl });
    expect(loadConfig().serverQuotePubKey).toBe('FETCHED_KEY');
  });

  it('registers the MCP host when asked (exactly the cryptocadet server)', async () => {
    const hostConfigPath = join(home, 'claude_desktop_config.json');
    const s = await runInit({ ...base, registerHost: true }, { io: silentIO(), hostConfigPath });
    expect(s.mcpRegistered).toBe(true);
    const cfg = JSON.parse(readFileSync(hostConfigPath, 'utf8'));
    expect(cfg.mcpServers.cryptocadet).toEqual({ command: 'cryptocadet', args: ['mcp:serve'] });
  });

  it('refuses a main wallet key in any mode', () => {
    expect(() => refuseMainWalletKey(['node', 'cli', 'init', '--private-key', '0xdead'])).toThrow(/never takes your main wallet key/);
    expect(() => refuseMainWalletKey(['node', 'cli', 'init', '--mnemonic', 'a b c'])).toThrow();
    expect(() => refuseMainWalletKey(['node', 'cli', 'init', '--yes'])).not.toThrow();
  });

  it('existing-install detection reflects the fresh temp home', () => {
    expect(detectExistingInstall().hasConfig).toBe(false);
  });
});
