import { describe, it, expect, vi, beforeEach } from 'vitest';

const { insert, from } = vi.hoisted(() => {
  const insert = vi.fn().mockResolvedValue({ error: null });
  const from = vi.fn(() => ({ insert }));
  return { insert, from };
});
vi.mock('@/lib/supabase', () => ({ supabase: { from } }));

import { recordEvent } from '@/lib/events';

beforeEach(() => { vi.clearAllMocks(); });

describe('recordEvent', () => {
  it('inserts a valid event/variant pair', async () => {
    await recordEvent('backlink_land', 'thread');
    expect(from).toHaveBeenCalledWith('events');
    expect(insert).toHaveBeenCalledWith({ event: 'backlink_land', variant: 'thread' });
  });

  it('ignores an event outside the allowlist', async () => {
    await recordEvent('evil', 'home');
    expect(from).not.toHaveBeenCalled();
  });

  it('ignores a variant outside the allowlist', async () => {
    await recordEvent('backlink_land', 'sideways');
    expect(from).not.toHaveBeenCalled();
  });

  it('includes a valid source_slug in the inserted row', async () => {
    await recordEvent('backlink_land', 'thread', 'aB3-_xY');
    expect(insert).toHaveBeenCalledWith({
      event: 'backlink_land', variant: 'thread', source_slug: 'aB3-_xY',
    });
  });

  it('drops a malformed source_slug but still records the event', async () => {
    await recordEvent('backlink_land', 'home', 'bad slug!');
    expect(insert).toHaveBeenCalledWith({ event: 'backlink_land', variant: 'home' });
  });

  it('omits source_slug when none is given', async () => {
    await recordEvent('backlink_land', 'home');
    expect(insert).toHaveBeenCalledWith({ event: 'backlink_land', variant: 'home' });
  });
});
