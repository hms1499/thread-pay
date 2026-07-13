import { describe, it, expect, vi } from 'vitest';

// aggregateDelivered is pure; the mock only exists so importing the module does not
// demand server env. Same posture as events.test.ts / history.test.ts.
vi.mock('@/lib/supabase', () => ({ supabase: { from: vi.fn() } }));

import { aggregateDelivered } from '@/lib/stats';

describe('aggregateDelivered', () => {
  it('counts one thread per delivered generation and splits revenue by token', () => {
    expect(aggregateDelivered([
      { token: 'STX', amount: 100000 },
      { token: 'STX', amount: 300000 },
      { token: 'SBTC', amount: 100 },
    ])).toEqual({ threads: 3, stxRevenue: 400000, sbtcRevenue: 100 });
  });

  it('reports zeroes when nothing has been delivered', () => {
    expect(aggregateDelivered([])).toEqual({ threads: 0, stxRevenue: 0, sbtcRevenue: 0 });
  });

  // A delivered thread is a delivered thread — it still counts even if the amount is
  // missing or unparseable. Dropping the row would under-report the headline number.
  it('still counts a generation with a null amount', () => {
    expect(aggregateDelivered([{ token: 'STX', amount: null }])).toEqual({
      threads: 1, stxRevenue: 0, sbtcRevenue: 0,
    });
  });

  // The 692-vs-13 bug in one assertion: money that reached the contract without a
  // thread being delivered is NOT a sale. Only rows in `generations` reach this
  // function, so an unknown token must never inflate the revenue lines.
  it('ignores revenue for an unrecognised token but still counts the thread', () => {
    expect(aggregateDelivered([{ token: 'DOGE', amount: 999 }])).toEqual({
      threads: 1, stxRevenue: 0, sbtcRevenue: 0,
    });
  });
});
