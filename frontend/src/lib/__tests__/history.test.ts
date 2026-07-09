import { describe, it, expect, vi } from 'vitest';

// history.ts imports the service-role client, which validates server env at import
// time. The pure helpers under test never touch it, so a bare stub is enough.
vi.mock('@/lib/supabase', () => ({ supabase: {} }));

import { normalizeRow, deriveNextCursor, buildKeysetFilter, PAGE_SIZE } from '@/lib/history';

const rawRow = (over: Record<string, unknown> = {}) => ({
  id: 7,
  invoice_id: 'a'.repeat(64),
  service_id: 'hot-takes',
  token: 'STX',
  amount: 100000,
  tx_id: '0xtx',
  thread_content: ['hook', 'cta'],
  created_at: '2026-06-15T10:00:00.000+00:00',
  invoices: { topic: 'bitcoin layer 2' },
  ...over,
});

describe('normalizeRow', () => {
  it('flattens a to-one invoices object to a top-level topic', () => {
    const item = normalizeRow(rawRow());
    expect(item.topic).toBe('bitcoin layer 2');
    // id and the nested relation must not leak to the client
    expect('id' in item).toBe(false);
    expect('invoices' in item).toBe(false);
    expect(item.invoice_id).toBe('a'.repeat(64));
    expect(item.thread_content).toEqual(['hook', 'cta']);
  });

  it('defensively handles invoices arriving as an array', () => {
    const item = normalizeRow(rawRow({ invoices: [{ topic: 'arrayed' }] }));
    expect(item.topic).toBe('arrayed');
  });

  it('yields null topic when the relation is missing', () => {
    expect(normalizeRow(rawRow({ invoices: null })).topic).toBeNull();
    expect(normalizeRow(rawRow({ invoices: [] })).topic).toBeNull();
  });

  it('prefers params.topic over the legacy column for new invoices', () => {
    const item = normalizeRow(rawRow({
      invoices: { topic: null, params: { topic: 'from params', tone: 'witty' } },
    }));
    expect(item.topic).toBe('from params');
  });

  it('falls back to params.sourceText when there is no topic (repurpose-thread)', () => {
    const item = normalizeRow(rawRow({
      invoices: { topic: null, params: { sourceText: 'a long article to repurpose' } },
    }));
    expect(item.topic).toBe('a long article to repurpose');
  });

  it('falls back to the legacy topic column when params is absent (old rows)', () => {
    const item = normalizeRow(rawRow({ invoices: { topic: 'legacy topic' } }));
    expect(item.topic).toBe('legacy topic');
  });

  it('carries the service_id through, defaulting legacy rows to x-thread', () => {
    expect(normalizeRow(rawRow()).service_id).toBe('hot-takes');
    expect(normalizeRow(rawRow({ service_id: undefined })).service_id).toBe('x-thread');
  });

  it('normalizeRow surfaces selected_tone', () => {
    const item = normalizeRow({
      id: 1, invoice_id: 'x', service_id: 'x-thread', token: 'STX', amount: 1,
      tx_id: 't', thread_content: ['a'], created_at: '2026-07-09T00:00:00Z',
      invoices: { topic: 'hi', params: null }, selected_tone: 'funny',
    } as unknown as Parameters<typeof normalizeRow>[0]);
    expect(item.selected_tone).toBe('funny');
  });
});

describe('deriveNextCursor', () => {
  it('returns the last row cursor when a full page came back', () => {
    const rows = Array.from({ length: PAGE_SIZE }, (_, i) =>
      rawRow({ id: i + 1, created_at: `2026-06-15T10:00:${String(i).padStart(2, '0')}.000+00:00` }),
    );
    const cursor = deriveNextCursor(rows);
    expect(cursor).toEqual({ createdAt: rows[PAGE_SIZE - 1].created_at, id: PAGE_SIZE });
  });

  it('returns null when the page is not full (no more rows)', () => {
    expect(deriveNextCursor([rawRow(), rawRow()])).toBeNull();
  });

  it('returns null for an empty page', () => {
    expect(deriveNextCursor([])).toBeNull();
  });
});

describe('buildKeysetFilter', () => {
  it('builds a PostgREST or-filter for (created_at, id) < cursor', () => {
    const f = buildKeysetFilter({ createdAt: '2026-06-15T10:00:00.000+00:00', id: 7 });
    expect(f).toBe(
      'created_at.lt.2026-06-15T10:00:00.000+00:00,' +
        'and(created_at.eq.2026-06-15T10:00:00.000+00:00,id.lt.7)',
    );
  });
});
