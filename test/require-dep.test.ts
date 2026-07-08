import { describe, it, expect } from 'vitest';
import { requireDep } from '../src/util/require-dep.js';

describe('requireDep (on-demand dependency, probe mode)', () => {
  it('loads an already-installed dependency', async () => {
    const ethers = await requireDep<typeof import('ethers')>('ethers', { autoInstall: false });
    expect(ethers).not.toBeNull();
    expect(typeof ethers!.getAddress).toBe('function');
  });

  it('returns null for an absent dependency when autoInstall is false (no install attempt)', async () => {
    const missing = await requireDep('this-package-does-not-exist-xyz', { autoInstall: false });
    expect(missing).toBeNull();
  });
});
