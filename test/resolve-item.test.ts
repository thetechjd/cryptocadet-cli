import { describe, it, expect } from 'vitest';
import { resolveItem } from '../src/cli/seller.js';

const products = [
  { id: '11111111-1111-4111-8111-111111111111', name: 'Memo', token: '0x', unitPrice: '1', active: true, slug: 'memo' },
  { id: '22222222-2222-4222-8222-222222222222', name: 'Old', token: '0x', unitPrice: '1', active: true, slug: null },
];
const client = { listProducts: async () => products };

describe('resolveItem (share:* --item)', () => {
  it('passes an id through', async () => {
    expect(await resolveItem(client, '22222222-2222-4222-8222-222222222222')).toBe(products[1]!.id);
  });
  it('finds an item by its gateway slug', async () => {
    expect(await resolveItem(client, 'memo')).toBe(products[0]!.id);
  });
  it('explains an unknown slug', async () => {
    await expect(resolveItem(client, 'nope')).rejects.toThrow(/no item with slug "nope"/);
  });
});
