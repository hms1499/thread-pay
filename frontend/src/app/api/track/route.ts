import { NextRequest, NextResponse } from 'next/server';
import { recordEvent } from '@/lib/events';
import { clientIp, checkRateLimit } from '@/lib/rate-limit';
import { log } from '@/lib/log';
import { RATE_LIMIT_TRACK_MAX, RATE_LIMIT_TRACK_WINDOW_SEC } from '@/lib/config';

// Fire-and-forget landing beacon for the backlink loop. Always 204 — a tracking beacon
// must never visibly fail or make the client retry. The body is sent via sendBeacon, so
// read it as raw text and parse defensively. recordEvent owns allowlist validation.
export async function POST(req: NextRequest) {
  try {
    const rl = await checkRateLimit(`track:${clientIp(req)}`, {
      max: RATE_LIMIT_TRACK_MAX, windowSec: RATE_LIMIT_TRACK_WINDOW_SEC,
    });
    if (rl.allowed) {
      let body: { event?: unknown; variant?: unknown; source_slug?: unknown };
      try {
        body = JSON.parse(await req.text());
      } catch {
        return new NextResponse(null, { status: 204 });
      }
      const event = typeof body?.event === 'string' ? body.event : '';
      const variant = typeof body?.variant === 'string' ? body.variant : '';
      const sourceSlug = typeof body?.source_slug === 'string' ? body.source_slug : undefined;
      await recordEvent(event, variant, sourceSlug);
    }
  } catch (e) {
    log.warn('track.unhandled_error', { err: e });
  }
  return new NextResponse(null, { status: 204 });
}
