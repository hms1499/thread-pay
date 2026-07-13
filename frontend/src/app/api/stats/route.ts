import { NextResponse } from 'next/server';
import { fetchDeliveredStats } from '@/lib/stats';

// Stats count threads we actually DELIVERED, not payments that reached the contract.
// Those are different numbers by ~50x — see the note in lib/stats.ts. The headline on a
// crypto product has to be a claim the chain cannot contradict.
export async function GET() {
  try {
    const stats = await fetchDeliveredStats();
    return NextResponse.json(stats);
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'failed to read stats' },
      { status: 500 },
    );
  }
}
