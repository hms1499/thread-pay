import { supabase } from './supabase';
import { log } from './log';

// Server-only. Allowlist for the landing instrumentation — see the backlink
// instrumentation spec. Anything outside these is dropped so a hostile or malformed
// beacon can never pollute the table or crash the route.
const ALLOWED_EVENTS = ['backlink_land'];
const ALLOWED_VARIANTS = ['home', 'thread'];

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
  if (!ALLOWED_EVENTS.includes(event) || !ALLOWED_VARIANTS.includes(variant)) return;
  const row: { event: string; variant: string; source_slug?: string } = { event, variant };
  if (sourceSlug && SLUG_RE.test(sourceSlug)) row.source_slug = sourceSlug;
  const { error } = await supabase.from('events').insert(row);
  if (error) log.warn('track.record_failed', { event, variant, err: error.message });
}
