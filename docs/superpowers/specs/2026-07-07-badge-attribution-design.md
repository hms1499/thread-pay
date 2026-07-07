# Badge + Per-Thread Attribution — Design

**Date:** 2026-07-07
**Status:** Approved, ready for planning
**Depends on:** `2026-06-26-backlink-instrumentation-design.md`, `2026-06-26-share-backlink-design.md`

## Goal

Close the backlink growth loop's measurement side: attribute each landing to the
specific shared thread that drove it, so we can see which threads pull traffic and,
later, which wallets to reward. This iteration is **measurement only** — no on-chain
referral reward.

## Context: what already exists

- `creditTweet()` (`lib/postToX.ts`) appends a "Made with ThreadGogh" tweet deep-linking
  to `/t/<slug>?ref=tg`.
- `BacklinkTracker` (root layout) fires one `sendBeacon` to `/api/track` when the URL
  carries `?ref=tg`, recording `{event, variant}` where `variant` ∈ `home|thread`.
- `/api/track` → `recordEvent(event, variant)` appends to the `events` table
  (service-role only, RLS-locked, no PII).

## The three gaps this closes

1. The beacon carries no slug → `events` cannot attribute a landing to a thread.
2. The on-page badge CTA on `/t/[slug]` links to bare `/`, so the thread→home
   click-through (intent) is never measured.
3. `/t/[slug]` only records a landing when `?ref=tg` is present; we want reach on the
   thread page recorded on every arrival.

## Decisions (from brainstorming)

- **Attribution granularity:** per shared thread (`source_slug`). Joins to
  `generations.share_slug → payer_address` when we later need per-wallet rollups.
- **Trigger:** measure both **reach** (any view of `/t/[slug]`) and **intent**
  (click-through from a thread to the homepage).
- **Scope:** badge + attribution + SQL read path. No referral reward, no anti-fraud.
- **Read path:** documented SQL in `.claude/docs/data-model.md`. No new API surface.

## Approach

Extend the existing single `events` table and single beacon (chosen over splitting
reach/intent into separate `event` names, and over server-side recording in the RSC
fetch). `BacklinkTracker` derives `(variant, source_slug)` from `window.location`:

- Path `/t/<slug>` → `(thread, slug from path)`, fired on **every** arrival (no
  `?ref=tg` requirement for reach).
- Any other path with `?ref=tg` → `(home, slug from ?src)`.

## Changes

### Data
`frontend/supabase/migrations/0011_events_source_slug.sql`
- `alter table events add column source_slug text;` (nullable — home landings without a
  `?src`, and pre-migration rows, stay NULL).
- `create index if not exists events_source_slug_idx on events (source_slug);`
- No RLS change — inherits the existing lockdown.

### `lib/events.ts` — `recordEvent(event, variant, sourceSlug?)`
- New optional third arg.
- Validate slug against `^[A-Za-z0-9_-]{1,64}$` (matches the base64url slug from
  `mintShareSlug`). An invalid/absent slug is stored as `NULL` — it does **not** drop
  the event.
- `event`/`variant` allowlist gating is unchanged.

### `app/api/track/route.ts`
- Parse `source_slug` from the JSON body (defensive, like `event`/`variant`), pass to
  `recordEvent`. Still always 204, still rate-limited.

### `lib/track.ts`
- Add pure `parseThreadSlug(pathname): string | null` returning the slug from
  `/t/<slug>` or `null`. `backlinkVariant` unchanged.

### `components/BacklinkTracker.tsx`
- Keep single-fire guard.
- If `parseThreadSlug(pathname)` is non-null → fire
  `{event:'backlink_land', variant:'thread', source_slug: slug}` regardless of `?ref`.
- Else if `?ref=tg` → fire `{variant:'home', source_slug: new URLSearchParams(...).get('src') ?? undefined}`.
- Else → no-op.

### `components/PublicThread.tsx`
- Change the bottom badge CTA link from `/` to `/?ref=tg&src=<slug>`. Style unchanged —
  that CTA is the on-page badge.

### `.claude/docs/data-model.md`
- Add an attribution SQL block: landings by thread, reach vs intent split, top threads,
  and the join to `generations.payer_address`.

## Testing
- `parseThreadSlug` — pure unit: `/t/abc` → `abc`; `/`, `/t/`, `/t/a/b` → `null`.
- `recordEvent` — valid slug recorded; junk slug → row written with `source_slug` NULL;
  event outside allowlist still rejected.
- `/api/track` — parses and forwards `source_slug`; malformed body still 204.

## Known limitations (accepted for the measurement phase)
- A creator viewing their own `/t/<slug>` page is counted as reach.
- No bot/prefetch filtering.

Both are deferred to the future referral-reward iteration, where they gate payouts.
