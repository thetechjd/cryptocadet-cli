import { describe, it, expect } from 'vitest';
import { discoverTokens } from '../src/revoke/sweep.js';
import { USDC, RANDOM_TOKEN } from './helpers/fixtures.js';

// 10. Sweep discovers a token by on-chain balance/log discovery, NOT from a config list.
// We fake the provider's log scan to include a random ERC-20 that is in no allowlist.
function fakeProvider(logsByAddress: string[]) {
  return {
    async getBlockNumber() {
      return 1000;
    },
    async getLogs() {
      return logsByAddress.map((address) => ({ address }));
    },
  } as unknown as import('ethers').JsonRpcProvider;
}

describe('sweep token discovery (case 10)', () => {
  it('discovers tokens from inbound Transfer logs, deduped, config-independent', async () => {
    const agent = '0x4444444444444444444444444444444444444444';
    // The agent received USDC and a totally random/forgotten token. Both must be found,
    // even though only USDC would ever appear in a config allowlist.
    const found = await discoverTokens(fakeProvider([USDC, RANDOM_TOKEN, USDC]), agent);
    expect(found).toContain(USDC);
    expect(found).toContain(RANDOM_TOKEN.toLowerCase());
    expect(found).toHaveLength(2); // deduped
  });
});
