'use client';

import { useEffect, useRef } from 'react';
import { buildLanding } from '@/lib/track';

// Renders nothing. On a fresh landing, fire exactly one fire-and-forget beacon. A
// /t/<slug> page always records reach; any other path records intent only when it
// carries the ?ref=tg marker. The landing decision (and slug attribution) lives in
// buildLanding — this component is only the DOM glue. Reads window.location directly to
// avoid the useSearchParams Suspense requirement.
export function BacklinkTracker() {
  const fired = useRef(false);
  useEffect(() => {
    if (fired.current) return;
    fired.current = true;
    const landing = buildLanding(window.location.pathname, window.location.search);
    if (!landing) return;
    const body = JSON.stringify(landing);
    if (typeof navigator.sendBeacon === 'function') {
      navigator.sendBeacon('/api/track', new Blob([body], { type: 'application/json' }));
    } else {
      void fetch('/api/track', { method: 'POST', body, keepalive: true }).catch(() => {});
    }
  }, []);
  return null;
}
