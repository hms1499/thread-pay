import { describe, it, expect } from 'vitest';
import { quotePrice } from '@/lib/price';

const svc = { priceStx: 100000, priceSbtc: 100 };

describe('quotePrice', () => {
  it('formats a single-tone STX price', () => {
    expect(quotePrice(svc, 'STX', false)).toEqual({ amount: 100000, label: '0.1 STX' });
  });

  it('formats a single-tone sBTC price in sats', () => {
    expect(quotePrice(svc, 'SBTC', false)).toEqual({ amount: 100, label: '100 sats' });
  });

  // The ×3 must match the server's multiplier exactly. If the two ever drift, the
  // button quotes one price and the invoice charges another — so both read it from
  // MULTI_TONE_MULTIPLIER in config rather than hardcoding a 3 on each side.
  it('applies the multi-tone multiplier to STX', () => {
    expect(quotePrice(svc, 'STX', true)).toEqual({ amount: 300000, label: '0.3 STX' });
  });

  it('applies the multi-tone multiplier to sBTC', () => {
    expect(quotePrice(svc, 'SBTC', true)).toEqual({ amount: 300, label: '300 sats' });
  });

  it('does not render trailing zeroes on a whole-number STX price', () => {
    expect(quotePrice({ priceStx: 2_000_000, priceSbtc: 1 }, 'STX', false).label).toBe('2 STX');
  });
});
