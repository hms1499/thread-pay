import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/events', () => ({ recordEvent: vi.fn().mockResolvedValue(undefined) }));
vi.mock('@/lib/rate-limit', () => ({
  clientIp: vi.fn(() => '1.2.3.4'),
  checkRateLimit: vi.fn().mockResolvedValue({ allowed: true, retryAfterSec: 0 }),
}));

import { POST } from '../route';
import { recordEvent } from '@/lib/events';
import { checkRateLimit } from '@/lib/rate-limit';

const m = vi.mocked;

function req(rawBody: string) {
  return {
    text: async () => rawBody,
    headers: { get: () => null },
  } as unknown as Parameters<typeof POST>[0];
}

beforeEach(() => { vi.clearAllMocks(); });

describe('POST /api/track', () => {
  it('records a valid beacon and returns 204', async () => {
    const res = await POST(req(JSON.stringify({ event: 'backlink_land', variant: 'thread' })));
    expect(res.status).toBe(204);
    expect(recordEvent).toHaveBeenCalledWith('backlink_land', 'thread', undefined);
  });

  it('returns 204 and still calls recordEvent (which drops it) for an unknown variant', async () => {
    const res = await POST(req(JSON.stringify({ event: 'backlink_land', variant: 'evil' })));
    expect(res.status).toBe(204);
    // The route forwards raw strings; the allowlist lives in recordEvent.
    expect(recordEvent).toHaveBeenCalledWith('backlink_land', 'evil', undefined);
  });

  it('forwards source_slug when present', async () => {
    const res = await POST(req(JSON.stringify({
      event: 'backlink_land', variant: 'thread', source_slug: 'abc123',
    })));
    expect(res.status).toBe(204);
    expect(recordEvent).toHaveBeenCalledWith('backlink_land', 'thread', 'abc123');
  });

  it('returns 204 and does not record when rate-limited', async () => {
    m(checkRateLimit).mockResolvedValueOnce({ allowed: false, retryAfterSec: 60 });
    const res = await POST(req(JSON.stringify({ event: 'backlink_land', variant: 'home' })));
    expect(res.status).toBe(204);
    expect(recordEvent).not.toHaveBeenCalled();
  });

  it('returns 204 and does not record on malformed JSON', async () => {
    const res = await POST(req('not json'));
    expect(res.status).toBe(204);
    expect(recordEvent).not.toHaveBeenCalled();
  });
});
