// Pure client/server-safe helper for the backlink loop. Classifies a landing
// path into the backlink variant we record: a deep-link thread page vs anything
// else (the homepage fallback). No DOM, no env.
export type BacklinkVariant = 'home' | 'thread';

export function backlinkVariant(pathname: string): BacklinkVariant {
  return pathname.startsWith('/t/') ? 'thread' : 'home';
}

// The slug of a /t/<slug> deep link, or null for any other path. A trailing segment
// after the slug (or an empty slug) is not a thread page.
export function parseThreadSlug(pathname: string): string | null {
  const m = pathname.match(/^\/t\/([^/]+)\/?$/);
  return m ? m[1] : null;
}

export type Landing = {
  event: 'backlink_land';
  variant: BacklinkVariant;
  source_slug?: string;
};

// Decide what landing (if any) a location represents. A thread page always counts as
// reach (attributed to its own slug). Any other path counts as intent only when it
// carries the ?ref=tg marker, attributed to ?src when present.
export function buildLanding(pathname: string, search: string): Landing | null {
  const slug = parseThreadSlug(pathname);
  if (slug) return { event: 'backlink_land', variant: 'thread', source_slug: slug };
  const params = new URLSearchParams(search);
  if (params.get('ref') !== 'tg') return null;
  const src = params.get('src');
  return src
    ? { event: 'backlink_land', variant: 'home', source_slug: src }
    : { event: 'backlink_land', variant: 'home' };
}
