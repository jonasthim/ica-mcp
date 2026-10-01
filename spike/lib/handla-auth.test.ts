import { describe, expect, it } from 'vitest';
import { handlaCartQuantity } from './handla-auth.js';

describe('handlaCartQuantity', () => {
  it('returns the quantity when the product is present', () => {
    const cart = { data: { lines: [{ productId: 'xyz', quantity: 1 }, { productId: 'abc', quantity: 3 }] } };
    expect(handlaCartQuantity(cart, 'abc')).toBe(3);
  });

  it('matches on retailerProductId too', () => {
    const cart = { lines: [{ retailerProductId: 'abc', quantity: 2 }] };
    expect(handlaCartQuantity(cart, 'abc')).toBe(2);
  });

  it('returns 0 when cart lines are present but none match', () => {
    const cart = { lines: [{ productId: 'xyz', quantity: 1 }, { retailerProductId: 'zzz', quantity: 5 }] };
    expect(handlaCartQuantity(cart, 'abc')).toBe(0);
  });

  it("returns 'unknown' when no cart-line-shaped object is found anywhere", () => {
    expect(handlaCartQuantity({ status: 'ok', lines: [] }, 'abc')).toBe('unknown');
    expect(handlaCartQuantity({ message: 'Forbidden', code: 403 }, 'abc')).toBe('unknown');
    expect(handlaCartQuantity(null, 'abc')).toBe('unknown');
  });

  it("returns 'unknown' when the only candidate lines key the product id under some other name, even if the product is present under that key", () => {
    const cart = { lines: [{ itemProductId: 'abc', quantity: 1 }] };
    expect(handlaCartQuantity(cart, 'abc')).toBe('unknown');
  });
});
