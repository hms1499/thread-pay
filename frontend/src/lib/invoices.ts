import crypto from 'crypto';
import { supabase } from './supabase';
import { INVOICE_TTL_MINUTES, GENERATING_STALE_MS } from './config';

export type Invoice = {
  invoice_id: string;
  service_id: string;
  params: Record<string, unknown> | null;
  topic?: string;
  tone?: string;
  length?: number;
  price_stx: number;
  price_sbtc: number;
  status: 'pending' | 'paid' | 'generating' | 'consumed';
  expires_at: string;
  generating_at?: string | null;
  preview_hook?: string | null;
  preview_outline?: string[] | null;
  language?: string | null;
  variant_tones?: string[] | null;
};

export function isExpired(invoice: Pick<Invoice, 'expires_at'>): boolean {
  return new Date(invoice.expires_at).getTime() < Date.now();
}

// A 'generating' invoice whose lock is older than the threshold is stale: the
// request that claimed it likely died before saving. Such a lock may be reclaimed.
// A missing timestamp is treated as fresh (conservative — never reclaim blindly).
export function isGeneratingStale(invoice: Pick<Invoice, 'generating_at'>): boolean {
  if (!invoice.generating_at) return false;
  return new Date(invoice.generating_at).getTime() < Date.now() - GENERATING_STALE_MS;
}

export async function createInvoice(args: {
  serviceId: string;
  params: Record<string, unknown>;
  priceStx: number;
  priceSbtc: number;
  previewHook?: string | null;
  previewOutline?: string[] | null;
  variantTones?: string[] | null;
}): Promise<Invoice> {
  const invoice: Invoice = {
    invoice_id: crypto.randomBytes(32).toString('hex'),
    service_id: args.serviceId,
    params: args.params,
    price_stx: args.priceStx,
    price_sbtc: args.priceSbtc,
    status: 'pending',
    expires_at: new Date(Date.now() + INVOICE_TTL_MINUTES * 60_000).toISOString(),
    preview_hook: args.previewHook ?? null,
    preview_outline: args.previewOutline ?? null,
    variant_tones: args.variantTones ?? null,
  };
  const { error } = await supabase.from('invoices').insert(invoice);
  if (error) throw new Error(`createInvoice: ${error.message}`);
  return invoice;
}

export async function getInvoice(invoiceId: string): Promise<Invoice | null> {
  const { data, error } = await supabase
    .from('invoices').select('*').eq('invoice_id', invoiceId).maybeSingle();
  if (error) throw new Error(`getInvoice: ${error.message}`);
  return data;
}

// Atomic generation lock. The DB makes the transition race-safe: a single UPDATE
// claims the slot only if the row is either still 'pending' OR a STALE 'generating'
// (lock older than GENERATING_STALE_MS — its owner crashed). Stamping generating_at
// lets a future request reclaim this slot if WE crash too, so a paid user is never
// stuck forever. Returns true if this request won the slot.
export async function claimInvoice(invoiceId: string): Promise<boolean> {
  const staleBefore = new Date(Date.now() - GENERATING_STALE_MS).toISOString();
  const { data, error } = await supabase
    .from('invoices')
    .update({ status: 'generating', generating_at: new Date().toISOString() })
    .eq('invoice_id', invoiceId)
    .or(`status.eq.pending,and(status.eq.generating,generating_at.lt.${staleBefore})`)
    .select('invoice_id');
  if (error) throw new Error(`claimInvoice: ${error.message}`);
  return (data?.length ?? 0) > 0;
}

// Release the lock when generation fails: generating -> pending, allowing a free retry
// (the receipt stays on-chain, so the next attempt can still verify it).
export async function releaseInvoice(invoiceId: string): Promise<void> {
  const { error } = await supabase
    .from('invoices').update({ status: 'pending', generating_at: null })
    .eq('invoice_id', invoiceId).eq('status', 'generating');
  if (error) throw new Error(`releaseInvoice: ${error.message}`);
}

export type Variant = { tone: string; thread: string[] };

export type Generation = {
  invoice_id: string;
  service_id: string;
  payer_address: string;
  token: string;
  amount: number;
  tx_id: string;
  thread_content: string[];
  regen_count?: number;
  share_slug?: string | null;
  variants?: Variant[] | null;
  selected_tone?: string | null;
};

export async function getGeneration(invoiceId: string): Promise<Generation | null> {
  const { data, error } = await supabase
    .from('generations').select('*').eq('invoice_id', invoiceId).maybeSingle();
  if (error) throw new Error(`getGeneration: ${error.message}`);
  return data;
}

// Atomic consume: the unique constraint on invoice_id is the anti-double-spend guard.
// Insert succeeds → we're the first → set consumed.
// Insert hits a unique violation (23505) → a generation already exists → return it.
export async function saveGenerationAndConsume(gen: Generation): Promise<Generation> {
  const { error } = await supabase.from('generations').insert(gen);
  if (error) {
    if (error.code === '23505') {
      const existing = await getGeneration(gen.invoice_id);
      if (existing) return existing;
    }
    throw new Error(`saveGeneration: ${error.message}`);
  }
  await supabase.from('invoices')
    .update({ status: 'consumed' }).eq('invoice_id', gen.invoice_id);
  return gen;
}

// Compare-and-swap re-roll: overwrite the thread and bump regen_count only if the
// row still has the regen_count we read (expectedCount). A concurrent re-roll that
// already bumped the counter makes this match zero rows -> returns null (caller treats
// it as "in progress / retry"), so two clicks can never over-count or clobber.
export async function regenerateGeneration(
  invoiceId: string, newThread: string[], expectedCount: number,
): Promise<Generation | null> {
  const { data, error } = await supabase
    .from('generations')
    .update({ thread_content: newThread, regen_count: expectedCount + 1 })
    .eq('invoice_id', invoiceId)
    .eq('regen_count', expectedCount)
    .select('*')
    .maybeSingle();
  if (error) throw new Error(`regenerateGeneration: ${error.message}`);
  return data;
}

// Swap the winning tone: point thread_content at the chosen variant's thread and
// record it as selected_tone. The route has already verified ownership + that the
// tone exists in variants, so this is a straight UPDATE. Returns the updated row,
// or null if the invoice_id no longer matches.
export async function selectVariant(
  invoiceId: string, tone: string, thread: string[],
): Promise<Generation | null> {
  const { data, error } = await supabase
    .from('generations')
    .update({ selected_tone: tone, thread_content: thread })
    .eq('invoice_id', invoiceId)
    .select('*')
    .maybeSingle();
  if (error) throw new Error(`selectVariant: ${error.message}`);
  return data;
}
