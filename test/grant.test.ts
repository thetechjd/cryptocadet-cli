import { describe, it, expect, vi } from 'vitest';
import { validateGrant, grantSubscriptionApproval, revokeSubscriptionApproval } from '../src/subscription/grant.js';
import { policyWithUsdc, USDC } from './helpers/fixtures.js';

const COLLECTOR = '0x1111111111111111111111111111111111111111';

describe('subscription grant validation', () => {
  it('accepts an allowlisted token with a positive cap', () => {
    expect(() => validateGrant(policyWithUsdc(), USDC, '10000000')).not.toThrow();
  });
  it('rejects a non-allowlisted token', () => {
    expect(() => validateGrant(policyWithUsdc(), '0x9999999999999999999999999999999999999999', '1')).toThrow(/not allowlisted/);
  });
  it('rejects a zero / non-positive / non-integer cap', () => {
    expect(() => validateGrant(policyWithUsdc(), USDC, '0')).toThrow(/positive/);
    expect(() => validateGrant(policyWithUsdc(), USDC, '-5')).toThrow(/positive/);
    expect(() => validateGrant(policyWithUsdc(), USDC, '1.5')).toThrow(/positive/);
  });
  it('rejects a fee-on-transfer token', () => {
    const p = policyWithUsdc({ allowlist: { [USDC]: { symbol: 'USDC', decimals: 6, feeOnTransfer: true } } });
    expect(() => validateGrant(p, USDC, '1')).toThrow(/fee-on-transfer/);
  });
});

describe('grant / revoke subscription approval', () => {
  it('signs approve(collector, cap) for a valid grant', async () => {
    const approve = vi.fn(async () => ({ txHash: '0xgrant' }));
    const r = await grantSubscriptionApproval({ policy: policyWithUsdc(), approve }, { token: USDC, collector: COLLECTOR, cap: '10000000' });
    expect(approve).toHaveBeenCalledWith(USDC, expect.any(String), '10000000');
    expect(r).toMatchObject({ token: USDC, cap: '10000000', txHash: '0xgrant' });
  });

  it('never signs when validation fails (bad cap)', async () => {
    const approve = vi.fn(async () => ({ txHash: '0x' }));
    await expect(
      grantSubscriptionApproval({ policy: policyWithUsdc(), approve }, { token: USDC, collector: COLLECTOR, cap: '0' }),
    ).rejects.toThrow(/positive/);
    expect(approve).not.toHaveBeenCalled();
  });

  it('rejects a malformed collector address', async () => {
    const approve = vi.fn(async () => ({ txHash: '0x' }));
    await expect(
      grantSubscriptionApproval({ policy: policyWithUsdc(), approve }, { token: USDC, collector: 'not-an-address', cap: '1' }),
    ).rejects.toThrow(/collector/);
    expect(approve).not.toHaveBeenCalled();
  });

  it('revoke signs approve(collector, 0)', async () => {
    const approve = vi.fn(async () => ({ txHash: '0xrevoke' }));
    const r = await revokeSubscriptionApproval({ approve }, { token: USDC, collector: COLLECTOR });
    expect(approve).toHaveBeenCalledWith(USDC, expect.any(String), '0');
    expect(r.cap).toBe('0');
  });
});
