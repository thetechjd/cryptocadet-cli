// First-run environment checks: Node version, OS keychain backend (the detached signer
// depends on it), and whether ~/.cryptocadet/ already exists (so re-init never clobbers).

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { paths, rootDir } from '../config/paths.js';

export function parseVersion(v: string): [number, number, number] {
  const parts = v.replace(/^v/, '').split('.').map((n) => Number.parseInt(n, 10) || 0);
  return [parts[0] ?? 0, parts[1] ?? 0, parts[2] ?? 0];
}

/** current >= min ? (semver-ish, major.minor.patch) */
export function satisfiesMin(current: string, min: string): boolean {
  const c = parseVersion(current);
  const m = parseVersion(min);
  for (let i = 0; i < 3; i++) {
    if (c[i]! > m[i]!) return true;
    if (c[i]! < m[i]!) return false;
  }
  return true;
}

export interface NodeCheck {
  ok: boolean;
  version: string;
  required: string;
}
export function checkNode(min = '22.5.0'): NodeCheck {
  return { ok: satisfiesMin(process.versions.node, min), version: process.versions.node, required: min };
}

export type KeychainBackend = 'memory' | 'keytar' | 'secret-tool' | 'security' | 'wincred' | 'none';
export interface KeychainCheck {
  backend: KeychainBackend;
  available: boolean;
  note: string;
}

function cliExists(cmd: string): boolean {
  return spawnSync('which', [cmd], { stdio: 'ignore' }).status === 0;
}

/** Detect the OS secret store the detached signer will unlock through. */
export async function detectKeychainBackend(): Promise<KeychainCheck> {
  if (process.env.CRYPTOCADET_INSECURE_KEYCHAIN === '1') {
    return { backend: 'memory', available: true, note: 'in-memory keychain (INSECURE — testing only)' };
  }
  try {
    await import(/* @vite-ignore */ 'keytar' as string);
    return { backend: 'keytar', available: true, note: 'native keytar' };
  } catch {
    /* not installed; fall back to platform CLI */
  }
  if (process.platform === 'darwin') {
    const ok = cliExists('security');
    return { backend: 'security', available: ok, note: ok ? 'macOS Keychain (security CLI)' : 'security CLI not found' };
  }
  if (process.platform === 'linux') {
    const ok = cliExists('secret-tool');
    return {
      backend: 'secret-tool',
      available: ok,
      note: ok ? 'libsecret (secret-tool)' : 'install libsecret-tools (secret-tool) or `npm i keytar`',
    };
  }
  if (process.platform === 'win32') {
    return { backend: 'wincred', available: false, note: 'install `keytar` for Windows Credential Manager' };
  }
  return { backend: 'none', available: false, note: `no keychain backend for platform ${process.platform}` };
}

export interface InstallState {
  root: string;
  exists: boolean;
  hasConfig: boolean;
  hasKey: boolean;
  hasPolicy: boolean;
}

/** Inspect ~/.cryptocadet/ to drive fresh-install vs re-run behavior. */
export function detectExistingInstall(): InstallState {
  return {
    root: rootDir(),
    exists: existsSync(rootDir()),
    hasConfig: existsSync(paths.config()),
    hasKey: existsSync(paths.keyEnc()),
    hasPolicy: existsSync(paths.policy()),
  };
}
