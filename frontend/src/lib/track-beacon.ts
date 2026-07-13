'use client';

// Fire-and-forget beacon to /api/track. Never throws and never returns a promise the
// caller has to handle: instrumentation must not be able to break, slow, or fail the flow
// it is measuring. The server validates the event/variant against its allowlist — this is
// only the transport.
//
// sendBeacon survives the page being closed mid-flight, which matters for wallet events:
// a user who rejects the wallet popup often closes the tab straight after.
export function trackEvent(event: string, variant: string, sourceSlug?: string): void {
  const payload: Record<string, string> = { event, variant };
  if (sourceSlug) payload.source_slug = sourceSlug;
  const body = JSON.stringify(payload);
  try {
    if (typeof navigator?.sendBeacon === 'function') {
      navigator.sendBeacon('/api/track', new Blob([body], { type: 'application/json' }));
    } else {
      void fetch('/api/track', { method: 'POST', body, keepalive: true }).catch(() => {});
    }
  } catch {
    // A blocked beacon (extension, private mode) is not an error worth surfacing.
  }
}
