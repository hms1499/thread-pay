import { supabase } from './supabase';

// Server-only. The public "Collection" counter.
//
// This deliberately counts DELIVERED THREADS — rows in `generations` — and not payments
// to the thread-pay contract. The two are wildly different numbers, and the difference
// is not academic: as of 2026-07-13 the contract had 692 successful pay-stx/pay-sbtc
// calls from 104 wallets, while only 13 threads had ever been delivered.
//
// Those 692 are not customers. Every one of them paid the exact global minimum, none of
// the 104 wallets paid only once (median 5, max 13), they all arrived inside a single
// month, and they called the contract directly with invoice ids this app never issued —
// the signature of wallets farming on-chain activity, not people who wanted a thread.
//
// Counting them as "threads sold" overstated the number ~50x, in the flattering
// direction, which is exactly why it went unnoticed. Anyone can check the chain in
// thirty seconds; a crypto product caught inflating its numbers does not recover.
// The headline must be a claim we can defend.

export type Stats = { threads: number; stxRevenue: number; sbtcRevenue: number };
export type DeliveredRow = { token: string | null; amount: number | null };

export function aggregateDelivered(rows: DeliveredRow[]): Stats {
  const stats: Stats = { threads: 0, stxRevenue: 0, sbtcRevenue: 0 };
  for (const row of rows) {
    // A delivered thread counts even if its amount is unreadable — the headline is a
    // count of threads, and dropping the row would under-report it.
    stats.threads += 1;
    const amount = Number(row.amount);
    if (!Number.isFinite(amount)) continue;
    if (row.token === 'STX') stats.stxRevenue += amount;
    else if (row.token === 'SBTC') stats.sbtcRevenue += amount;
  }
  return stats;
}

export async function fetchDeliveredStats(): Promise<Stats> {
  const { data, error } = await supabase.from('generations').select('token,amount');
  if (error) throw new Error(`fetchDeliveredStats: ${error.message}`);
  return aggregateDelivered(data ?? []);
}
