# Badge + Per-Thread Attribution Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Attribute each backlink landing to the specific shared thread that drove it, recording reach (thread views) and intent (thread→home click-through) into the existing `events` table.

**Architecture:** Extend the single `events` table with a nullable `source_slug` column and the single `/api/track` beacon. `BacklinkTracker` derives `(variant, source_slug)` from `window.location` via a pure `buildLanding` helper — `/t/<slug>` fires reach on every arrival; any other path fires intent only when `?ref=tg` is present. Read path is documented SQL; no new API surface. Measurement only — no referral reward, no anti-fraud.

**Tech Stack:** Next.js 16 (App Router, webpack), React 19, TypeScript, Supabase (service-role, RLS-locked), Vitest.

## Global Constraints

- **Webpack only** — never add/remove the `--webpack` flag on `dev`/`build`.
- **`events` table is service-role only** — RLS force-locked (migration 0002/0004 posture); never grant anon/authenticated access.
- **Tracking must never break the request path** — `recordEvent` logs insert failures, never throws; `/api/track` always returns 204.
- **No PII in `events`** — `source_slug` is a random base64url share slug, not a wallet or IP.
- **Slug format** — share slugs are `crypto.randomBytes(16).toString('base64url')`; validate against `^[A-Za-z0-9_-]{1,64}$`.
- **Never commit secrets.** Run frontend commands from `frontend/`.

---

### Task 1: Add `source_slug` column migration

**Files:**
- Create: `frontend/supabase/migrations/0011_events_source_slug.sql`

**Interfaces:**
- Produces: `events.source_slug text` (nullable) + index `events_source_slug_idx`.

- [ ] **Step 1: Write the migration**

`frontend/supabase/migrations/0011_events_source_slug.sql`:

```sql
-- Per-thread attribution for the backlink loop. NULL for home landings without a
-- ?src marker and for all pre-migration rows. Not PII — a random base64url share slug.
alter table events add column if not exists source_slug text;

create index if not exists events_source_slug_idx on events (source_slug);
```

- [ ] **Step 2: Verify it is idempotent and syntactically consistent with 0010**

Run: `cat frontend/supabase/migrations/0010_events.sql frontend/supabase/migrations/0011_events_source_slug.sql`
Expected: 0011 uses `if not exists` on both statements and touches only the `events` table. No RLS statements (inherits 0010's lockdown).

- [ ] **Step 3: Commit**

```bash
git add frontend/supabase/migrations/0011_events_source_slug.sql
git commit -m "feat(track): events.source_slug column for per-thread attribution"
```

---

### Task 2: `recordEvent` accepts an optional `sourceSlug`

**Files:**
- Modify: `frontend/src/lib/events.ts`
- Test: `frontend/src/lib/__tests__/events.test.ts`

**Interfaces:**
- Produces: `recordEvent(event: string, variant: string, sourceSlug?: string): Promise<void>`. When `sourceSlug` matches `^[A-Za-z0-9_-]{1,64}$`, the inserted row includes `source_slug`; otherwise the key is omitted (stored NULL). `event`/`variant` allowlist gating is unchanged.

- [ ] **Step 1: Add the failing tests**

Append to `frontend/src/lib/__tests__/events.test.ts` inside the `describe('recordEvent', ...)` block:

```ts
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
```

- [ ] **Step 2: Run tests to verify the new ones fail**

Run (from `frontend/`): `npm test -- src/lib/__tests__/events.test.ts`
Expected: the three new tests FAIL (extra `source_slug` arg ignored / mismatched insert payload); the original three still PASS.

- [ ] **Step 3: Implement the change**

Replace the body of `frontend/src/lib/events.ts` with:

```ts
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
```

- [ ] **Step 4: Run tests to verify all pass**

Run (from `frontend/`): `npm test -- src/lib/__tests__/events.test.ts`
Expected: all six tests PASS.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/lib/events.ts frontend/src/lib/__tests__/events.test.ts
git commit -m "feat(track): recordEvent stores optional source_slug"
```

---

### Task 3: `parseThreadSlug` + `buildLanding` pure helpers

**Files:**
- Modify: `frontend/src/lib/track.ts`
- Test: `frontend/src/lib/__tests__/track.test.ts`

**Interfaces:**
- Consumes: `BacklinkVariant`, `backlinkVariant` (already in this file — leave unchanged).
- Produces:
  - `parseThreadSlug(pathname: string): string | null` — the slug from `/t/<slug>`, else `null`.
  - `type Landing = { event: 'backlink_land'; variant: BacklinkVariant; source_slug?: string }`
  - `buildLanding(pathname: string, search: string): Landing | null` — reach for any `/t/<slug>`; intent (`home`) only when `search` carries `ref=tg`; else `null`.

- [ ] **Step 1: Add the failing tests**

Append to `frontend/src/lib/__tests__/track.test.ts`:

```ts
import { parseThreadSlug, buildLanding } from '../track';

describe('parseThreadSlug', () => {
  it('extracts the slug from a /t/<slug> path', () => {
    expect(parseThreadSlug('/t/aB3-_xY')).toBe('aB3-_xY');
  });
  it('returns null for the homepage', () => {
    expect(parseThreadSlug('/')).toBeNull();
  });
  it('returns null for a bare /t/ with no slug', () => {
    expect(parseThreadSlug('/t/')).toBeNull();
  });
  it('returns null for a nested path under /t/', () => {
    expect(parseThreadSlug('/t/abc/extra')).toBeNull();
  });
});

describe('buildLanding', () => {
  it('records reach on a thread page regardless of ref marker', () => {
    expect(buildLanding('/t/abc', '')).toEqual({
      event: 'backlink_land', variant: 'thread', source_slug: 'abc',
    });
  });
  it('records intent with source_slug from ?src on a ref-marked home landing', () => {
    expect(buildLanding('/', '?ref=tg&src=abc')).toEqual({
      event: 'backlink_land', variant: 'home', source_slug: 'abc',
    });
  });
  it('records intent without source_slug when ?src is absent', () => {
    expect(buildLanding('/', '?ref=tg')).toEqual({
      event: 'backlink_land', variant: 'home',
    });
  });
  it('returns null on a home path with no ref marker', () => {
    expect(buildLanding('/', '')).toBeNull();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run (from `frontend/`): `npm test -- src/lib/__tests__/track.test.ts`
Expected: new tests FAIL with `parseThreadSlug is not a function` / `buildLanding is not a function`; the existing `backlinkVariant` tests still PASS.

- [ ] **Step 3: Implement the helpers**

Append to `frontend/src/lib/track.ts` (keep the existing `BacklinkVariant`/`backlinkVariant`):

```ts
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
```

- [ ] **Step 4: Run tests to verify all pass**

Run (from `frontend/`): `npm test -- src/lib/__tests__/track.test.ts`
Expected: all tests PASS.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/lib/track.ts frontend/src/lib/__tests__/track.test.ts
git commit -m "feat(track): parseThreadSlug + buildLanding landing decision helpers"
```

---

### Task 4: `/api/track` forwards `source_slug`

**Files:**
- Modify: `frontend/src/app/api/track/route.ts`
- Test: `frontend/src/app/api/track/__tests__/route.test.ts`

**Interfaces:**
- Consumes: `recordEvent(event, variant, sourceSlug?)` from Task 2.
- Produces: POST handler reads `source_slug` from the JSON body (string or undefined) and forwards it; still always 204.

- [ ] **Step 1: Update existing assertions + add the new test**

In `frontend/src/app/api/track/__tests__/route.test.ts`, the route now always passes a third argument. Update the two existing `toHaveBeenCalledWith` assertions to include the trailing `undefined`:

```ts
    expect(recordEvent).toHaveBeenCalledWith('backlink_land', 'thread', undefined);
```
```ts
    expect(recordEvent).toHaveBeenCalledWith('backlink_land', 'evil', undefined);
```

Then add a new test to the `describe('POST /api/track', ...)` block:

```ts
  it('forwards source_slug when present', async () => {
    const res = await POST(req(JSON.stringify({
      event: 'backlink_land', variant: 'thread', source_slug: 'abc123',
    })));
    expect(res.status).toBe(204);
    expect(recordEvent).toHaveBeenCalledWith('backlink_land', 'thread', 'abc123');
  });
```

- [ ] **Step 2: Run tests to verify the new/updated ones fail**

Run (from `frontend/`): `npm test -- src/app/api/track/__tests__/route.test.ts`
Expected: the two updated assertions and the new test FAIL (route currently calls `recordEvent` with two args).

- [ ] **Step 3: Implement the change**

In `frontend/src/app/api/track/route.ts`, inside the `if (rl.allowed)` block, after the `variant` line and before the `recordEvent` call, add the `source_slug` parse and pass it through:

```ts
      const event = typeof body?.event === 'string' ? body.event : '';
      const variant = typeof body?.variant === 'string' ? body.variant : '';
      const sourceSlug = typeof body?.source_slug === 'string' ? body.source_slug : undefined;
      await recordEvent(event, variant, sourceSlug);
```

Also widen the `body` type annotation on the line above to include the new field:

```ts
      let body: { event?: unknown; variant?: unknown; source_slug?: unknown };
```

- [ ] **Step 4: Run tests to verify all pass**

Run (from `frontend/`): `npm test -- src/app/api/track/__tests__/route.test.ts`
Expected: all tests PASS (including the malformed-JSON and rate-limited cases, unchanged).

- [ ] **Step 5: Commit**

```bash
git add frontend/src/app/api/track/route.ts frontend/src/app/api/track/__tests__/route.test.ts
git commit -m "feat(track): /api/track forwards source_slug to recordEvent"
```

---

### Task 5: `BacklinkTracker` uses `buildLanding`

**Files:**
- Modify: `frontend/src/components/BacklinkTracker.tsx`

**Interfaces:**
- Consumes: `buildLanding(pathname, search)` from Task 3.

- [ ] **Step 1: Rewrite the effect to delegate to `buildLanding`**

Replace the body of `frontend/src/components/BacklinkTracker.tsx` with:

```tsx
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
```

- [ ] **Step 2: Typecheck / build to verify wiring**

Run (from `frontend/`): `npm run lint && npx tsc --noEmit`
Expected: no errors. (The landing logic itself is covered by Task 3's `buildLanding` tests.)

- [ ] **Step 3: Commit**

```bash
git add frontend/src/components/BacklinkTracker.tsx
git commit -m "feat(track): BacklinkTracker records reach + attributed intent"
```

---

### Task 6: Attributed badge CTA on the public thread page

**Files:**
- Modify: `frontend/src/components/PublicThread.tsx:44-46`

**Interfaces:**
- Consumes: the existing `slug` prop already passed to `PublicThread`.

- [ ] **Step 1: Point the bottom CTA at the marked, attributed homepage link**

In `frontend/src/components/PublicThread.tsx`, change the footer CTA link from `/` to `/?ref=tg&src=<slug>` so the thread→home click-through is recorded as intent attributed to this thread:

```tsx
      <Flex justify="center" style={{ marginTop: 24 }}>
        <a href={`/?ref=tg&src=${encodeURIComponent(slug)}`}>
          <Title level={4} style={{ margin: 0 }}>✍️ Create your own thread →</Title>
        </a>
      </Flex>
```

- [ ] **Step 2: Typecheck / build to verify**

Run (from `frontend/`): `npm run lint && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add frontend/src/components/PublicThread.tsx
git commit -m "feat(share): badge CTA carries ?ref=tg&src for intent attribution"
```

---

### Task 7: Document the attribution read queries

**Files:**
- Modify: `.claude/docs/data-model.md`

- [ ] **Step 1: Append an attribution SQL section**

Add a subsection to `.claude/docs/data-model.md` (near the existing `events` description):

````markdown
### Backlink attribution queries

`events.source_slug` ties a landing to the shared thread that drove it (`variant`:
`thread` = reach, a view of `/t/<slug>`; `home` = intent, a thread→home click-through).
Run these in the Supabase SQL editor (service-role only).

Landings per thread, split by reach vs intent:

```sql
select source_slug, variant, count(*)
from events
where event = 'backlink_land' and source_slug is not null
group by source_slug, variant
order by count(*) desc;
```

Reach vs intent totals (a rough loop-conversion signal):

```sql
select variant, count(*)
from events
where event = 'backlink_land'
group by variant;
```

Top threads with the paying wallet behind each (join to generations):

```sql
select e.source_slug, count(*) as landings, g.payer_address
from events e
join generations g on g.share_slug = e.source_slug
where e.event = 'backlink_land'
group by e.source_slug, g.payer_address
order by landings desc;
```
````

- [ ] **Step 2: Commit**

```bash
git add .claude/docs/data-model.md
git commit -m "docs(data-model): backlink attribution read queries"
```

---

### Task 8: Full suite + build gate

**Files:** none (verification only)

- [ ] **Step 1: Run the full test suite**

Run (from `frontend/`): `npm test`
Expected: all suites PASS, including the modified `events`, `track`, and `route` tests.

- [ ] **Step 2: Production build**

Run (from `frontend/`): `npm run build`
Expected: build succeeds with `--webpack` (already wired in the `build` script — do not add flags).

- [ ] **Step 3: Confirm no uncommitted changes**

Run: `git status --short`
Expected: clean tree (all task commits landed).
