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

// The payment funnel. `wallet_opened` vs `wallet_rejected` is the one thing the invoice
// and generation tables cannot tell us: whether a user bailed BEFORE opening the wallet
// (unconvinced) or AFTER seeing it (payment friction). Those are different problems.
describe('recordEvent — wallet funnel', () => {
  it('records wallet_opened for an STX payment', async () => {
    await recordEvent('wallet_opened', 'stx');
    expect(insert).toHaveBeenCalledWith({ event: 'wallet_opened', variant: 'stx' });
  });

  it('records wallet_rejected for an sBTC payment', async () => {
    await recordEvent('wallet_rejected', 'sbtc');
    expect(insert).toHaveBeenCalledWith({ event: 'wallet_rejected', variant: 'sbtc' });
  });

  // Variants are scoped per event, not a shared flat list — otherwise adding the token
  // variants would silently let `backlink_land` be recorded with variant 'stx'.
  it('rejects a wallet variant on a backlink event', async () => {
    await recordEvent('backlink_land', 'stx');
    expect(from).not.toHaveBeenCalled();
  });

  it('rejects a backlink variant on a wallet event', async () => {
    await recordEvent('wallet_opened', 'home');
    expect(from).not.toHaveBeenCalled();
  });
});
