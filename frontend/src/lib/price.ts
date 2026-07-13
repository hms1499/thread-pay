import { MULTI_TONE_MULTIPLIER } from './config';

// Shared client/server price maths. The price a visitor is shown BEFORE they commit
// must be the price the invoice actually charges, so the multi-tone ×3 is read from
// config here and in the generate route rather than hardcoded on each side.

export type PricedService = { priceStx: number; priceSbtc: number };
export type Quote = { amount: number; label: string };

export function quotePrice(
  service: PricedService,
  token: 'STX' | 'SBTC',
  multiTone: boolean,
): Quote {
  const mult = multiTone ? MULTI_TONE_MULTIPLIER : 1;
  if (token === 'STX') {
    const amount = service.priceStx * mult;
    // Trim trailing zeroes: "0.1 STX", not "0.100000 STX".
    const stx = amount / 1_000_000;
    return { amount, label: `${Number(stx.toFixed(6))} STX` };
  }
  const amount = service.priceSbtc * mult;
  return { amount, label: `${amount} sats` };
}
