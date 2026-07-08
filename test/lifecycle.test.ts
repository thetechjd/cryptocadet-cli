import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readPid, writePid, status, clearPid, stop } from '../src/mcp/lifecycle.js';

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'cc-life-'));
  process.env.CRYPTOCADET_HOME = home;
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  delete process.env.CRYPTOCADET_HOME;
});

describe('mcp:serve lifecycle', () => {
  it('writePid / readPid / status reflect a live process', () => {
    expect(status()).toEqual({ running: false });
    writePid(process.pid); // this test process is alive
    expect(readPid()).toBe(process.pid);
    expect(status()).toEqual({ running: true, pid: process.pid });
  });

  it('clearPid removes the pid file', () => {
    writePid(process.pid);
    expect(existsSync(join(home, 'mcp.pid'))).toBe(true);
    clearPid();
    expect(existsSync(join(home, 'mcp.pid'))).toBe(false);
    expect(status()).toEqual({ running: false });
  });

  it('a stale pid (dead process) is reported not-running and cleaned up', () => {
    writeFileSync(join(home, 'mcp.pid'), '2147483646'); // almost certainly not a live pid
    expect(status()).toEqual({ running: false });
    expect(existsSync(join(home, 'mcp.pid'))).toBe(false); // status cleaned the stale file
  });

  it('stop on a stale/dead pid returns stopped:false and removes the file', () => {
    writeFileSync(join(home, 'mcp.pid'), '2147483646');
    expect(stop()).toEqual({ stopped: false });
    expect(existsSync(join(home, 'mcp.pid'))).toBe(false);
  });
});
