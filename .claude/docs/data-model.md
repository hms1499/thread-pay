# Data Model (Supabase / Postgres)

Server-only access via the service-role client in `frontend/src/lib/supabase.ts`. All
reads/writes go through `frontend/src/lib/invoices.ts`. Never touch these tables from a
client component.

## Tables

### `invoices`

| Column | Type | Notes |
|--------|------|-------|
| `invoice_id` | text PK | 32 random bytes, hex (64 chars); also the on-chain key |
| `topic`, `tone`, `length` | text/int | generation inputs, fixed at quote time |
| `price_stx`, `price_sbtc` | bigint | quoted price snapshot (µSTX / sats) |
| `status` | text | `pending` → `generating` → `consumed` (`paid` legacy/unused) |
| `expires_at` | timestamptz | quote TTL = `INVOICE_TTL_MINUTES` (15) |
| `generating_at` | timestamptz null | stamped on lock claim; powers stale-lock recovery |
| `preview_hook` | text null | free single-tweet hook shown pre-payment, reused as tweet #1 |
| `created_at` | timestamptz | default `now()` |

### `generations`

| Column | Type | Notes |
|--------|------|-------|
| `id` | bigint identity PK | |
| `invoice_id` | text **unique** FK → invoices | the unique constraint is the anti-double-spend guard |
| `payer_address`, `token`, `amount`, `tx_id` | | copied from the verified receipt |
| `thread_content` | jsonb | `string[]` of tweets |
| `regen_count` | int not null default 0 | free re-rolls used; capped at `MAX_FREE_REGENS` via CAS |
| `created_at` | timestamptz | indexed via `generations_payer_idx` for history |

## Invoice state machine

```
pending ──claimInvoice()──▶ generating ──saveGenerationAndConsume()──▶ consumed
   ▲                            │
   └────── releaseInvoice() ◀───┘   (LLM failed: free retry, receipt stays on-chain)
```

- **`claimInvoice(id)`** — one atomic UPDATE wins the slot if the row is `pending` **or**
  a **stale** `generating` (lock older than `GENERATING_STALE_MS` = 2 min). It stamps
  `generating_at`. Returns true if won. This is the only place generation is gated, so
  concurrent requests with the same invoice can't both call the LLM.
- **`releaseInvoice(id)`** — `generating → pending`, clears `generating_at`. Used when the
  LLM throws, so the user retries for free.
- **`saveGenerationAndConsume(gen)`** — inserts the generation; a `23505` unique violation
  means another request already saved it → returns the existing row. On success, sets the
  invoice `consumed`.

## Stale-lock recovery (why `generating_at` exists)

If a worker crashes **between** claiming (`status='generating'`) and saving, the invoice
would otherwise be stuck forever — every retry sees `generating` and gets 202 with no
result, stranding a user who already paid. `generating_at` lets `claimInvoice` reclaim a
lock older than the threshold. `route.ts` only returns 202 for a **fresh** lock
(`isGeneratingStale` false); a stale lock falls through to re-verify the receipt and
reclaim. Helper: `isGeneratingStale(invoice)` (treats a missing timestamp as fresh).

## Migrations

SQL lives in `frontend/supabase/migrations/`, applied manually in the Supabase SQL
editor (no automated runner). Current:

- `0001_invoices_generating_at.sql` — adds the nullable `generating_at` column.
- `0002_invoices_preview_hook.sql` — adds the nullable `preview_hook` column.
- `0003_generations_regen_count.sql` — adds `regen_count` (default 0).
- `0010_events.sql` — append-only `events(event, variant, created_at)` for backlink landing instrumentation; RLS-locked (service-role only).
- `0011_events_source_slug.sql` — adds nullable `events.source_slug` (+ index) so a landing can be attributed to the shared thread that drove it; joins to `generations.share_slug`.

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

When you change a table, add a numbered migration file here and note it in this doc.
