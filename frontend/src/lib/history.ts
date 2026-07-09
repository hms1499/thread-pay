import { supabase } from './supabase';

// Server-only. Reads a wallet's thread history with keyset pagination. The route
// handles auth; this module owns the DB query and its shape. See
// docs/superpowers/specs/2026-06-15-history-pagination-design.md.

export const PAGE_SIZE = 20;

// Opaque to the client beyond round-tripping it back on the next request.
export type HistoryCursor = { createdAt: string; id: number };

export type HistoryItem = {
  invoice_id: string;
  service_id: string;
  token: string;
  amount: number;
  tx_id: string;
  thread_content: string[];
  created_at: string;
  topic: string | null;
  selected_tone: string | null;
};

// A raw generations row joined to its invoice. invoice_id is a unique FK, so
// PostgREST returns `invoices` as a single object — but we defensively accept an
// array too, so a future schema change can't silently blank out every topic.
type RawRow = {
  id: number;
  invoice_id: string;
  service_id: string;
  token: string;
  amount: number;
  tx_id: string;
  thread_content: string[];
  created_at: string;
  invoices: InvoiceRel | InvoiceRel[] | null;
  selected_tone: string | null;
};

export type InvoiceRel = { topic?: string | null; params?: Record<string, unknown> | null };

// A display label for the history row. New invoices store inputs in `params` (the
// `topic` column is null for them); rows predating migration 0006 only have the
// legacy column. Prefer params (topic, else the repurpose-thread source text), then
// fall back to the legacy column.
export function displayTopic(rel: InvoiceRel | undefined): string | null {
  const p = rel?.params;
  if (p) {
    if (typeof p.topic === 'string' && p.topic) return p.topic;
    if (typeof p.sourceText === 'string' && p.sourceText) return p.sourceText;
  }
  return rel?.topic ?? null;
}

export function normalizeRow(raw: RawRow): HistoryItem {
  const rel = Array.isArray(raw.invoices) ? raw.invoices[0] : raw.invoices;
  return {
    invoice_id: raw.invoice_id,
    // Rows predating the marketplace default to x-thread (matches migration 0006).
    service_id: raw.service_id ?? 'x-thread',
    token: raw.token,
    amount: raw.amount,
    tx_id: raw.tx_id,
    thread_content: raw.thread_content,
    created_at: raw.created_at,
    topic: displayTopic(rel ?? undefined),
    selected_tone: raw.selected_tone ?? null,
  };
}

// A full page implies there may be more; derive the cursor from the last raw row
// (which still carries `id`). A short page means we hit the end.
export function deriveNextCursor(rows: Pick<RawRow, 'id' | 'created_at'>[]): HistoryCursor | null {
  if (rows.length < PAGE_SIZE) return null;
  const last = rows[rows.length - 1];
  return { createdAt: last.created_at, id: last.id };
}

// PostgREST `or` filter expressing (created_at, id) < (cursor.createdAt, cursor.id)
// under the `created_at desc, id desc` ordering. ISO timestamps contain no commas
// or parens, so they are safe to inline here.
export function buildKeysetFilter(cursor: HistoryCursor): string {
  return (
    `created_at.lt.${cursor.createdAt},` +
    `and(created_at.eq.${cursor.createdAt},id.lt.${cursor.id})`
  );
}

const COLUMNS = 'id, invoice_id, service_id, token, amount, tx_id, thread_content, created_at, selected_tone, invoices(topic, params)';

export async function fetchHistoryPage(
  address: string,
  cursor: HistoryCursor | null,
): Promise<{ items: HistoryItem[]; nextCursor: HistoryCursor | null }> {
  let query = supabase
    .from('generations')
    .select(COLUMNS)
    .eq('payer_address', address);

  if (cursor) query = query.or(buildKeysetFilter(cursor));

  const { data, error } = await query
    .order('created_at', { ascending: false })
    .order('id', { ascending: false })
    .limit(PAGE_SIZE);

  if (error) throw new Error(error.message);

  const rows = (data ?? []) as unknown as RawRow[];
  return { items: rows.map(normalizeRow), nextCursor: deriveNextCursor(rows) };
}
