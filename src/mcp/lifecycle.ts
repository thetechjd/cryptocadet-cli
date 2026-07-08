// mcp:serve process lifecycle (the RDK detach pattern): a PID file under ~/.cryptocadet,
// keychain unlock on detached start, and clean stop/status. The detached signer holds
// the decrypted agent key in memory for the session; stopping it drops that memory.

import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { rootDir } from '../config/paths.js';

function pidFile(): string {
  return join(rootDir(), 'mcp.pid');
}

export interface ServeStatus {
  running: boolean;
  pid?: number;
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0); // signal 0 = liveness probe, does not kill
    return true;
  } catch {
    return false;
  }
}

export function readPid(): number | null {
  const f = pidFile();
  if (!existsSync(f)) return null;
  const pid = Number(readFileSync(f, 'utf8').trim());
  return Number.isInteger(pid) && pid > 0 ? pid : null;
}

export function writePid(pid: number): void {
  writeFileSync(pidFile(), String(pid), { mode: 0o600 });
}

export function status(): ServeStatus {
  const pid = readPid();
  if (pid && isAlive(pid)) return { running: true, pid };
  // stale pid file => clean it up
  if (pid && existsSync(pidFile())) rmSync(pidFile(), { force: true });
  return { running: false };
}

export function stop(): { stopped: boolean; pid?: number } {
  const pid = readPid();
  if (!pid || !isAlive(pid)) {
    if (pid) rmSync(pidFile(), { force: true });
    return { stopped: false };
  }
  process.kill(pid, 'SIGTERM');
  rmSync(pidFile(), { force: true });
  return { stopped: true, pid };
}

/** Spawn a detached `mcp:serve` child that re-execs this binary in foreground mode.
 *  Records its PID. The child performs the keychain unlock at boot (one OS auth). */
export function startDetached(binPath: string, extraArgs: string[] = []): number {
  const existing = status();
  if (existing.running) throw new Error(`mcp already running (pid ${existing.pid})`);
  const child = spawn(process.execPath, [binPath, 'mcp:serve', '--foreground', ...extraArgs], {
    detached: true,
    stdio: 'ignore',
  });
  child.unref();
  if (!child.pid) throw new Error('failed to spawn detached mcp process');
  writePid(child.pid);
  return child.pid;
}

export function clearPid(): void {
  const f = pidFile();
  if (existsSync(f)) rmSync(f, { force: true });
}
