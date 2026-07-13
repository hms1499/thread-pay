import { supabase } from './supabase';
import { log } from './log';

// Server-only. Allowlist for the instrumentation beacons. Anything outside this map is
// dropped so a hostile or malformed beacon can never pollute the table or crash the route.
//
// Variants are scoped PER EVENT rather than shared, because the two families of event
// have disjoint dimensions: a backlink is a page kind, a wallet event is a token. A flat
// variant list would happily record `backlink_land`/`stx`.
const ALLOWED: Record<string, readonly string[]> = {
  // Backlink loop — see the backlink instrumentation spec.
  backlink_land: ['home', 'thread'],
  // Payment funnel. The invoices and generations tables already tell us "was quoted" and
  // "got a thread"; what neither can tell us is whether a user who did not pay bailed
  // BEFORE the wallet opened (unconvinced by the offer) or AFTER seeing it (payment
  // friction). Those are different problems with different fixes, so they are measured.
  // `wallet_rejected` means the wallet returned no txid — user cancelled, or it errored.
  wallet_opened: ['stx', 'sbtc'],
  wallet_rejected: ['stx', 'sbtc'],
};

// Share slugs are crypto.randomBytes(16).base64url (22 chars). A slug outside this
// shape is dropped to NULL — the landing is still recorded, just unattributed.
const SLUG_RE = /^[A-Za-z0-9_-]{1,64}$/;

// Append one landing row. No-op on invalid event/variant; never throws (an insert
// failure is logged, not propagated — a tracking write must not break the request path).
export async function recordEvent(
  event: string,
  variant: string,
  sourceSlug?: string,
): Promise<void> {
  if (!ALLOWED[event]?.includes(variant)) return;
  const row: { event: string; variant: string; source_slug?: string } = { event, variant };
  if (sourceSlug && SLUG_RE.test(sourceSlug)) row.source_slug = sourceSlug;
  const { error } = await supabase.from('events').insert(row);
  if (error) log.warn('track.record_failed', { event, variant, err: error.message });
}
