# Multi-Tone Variations (A/B tones) — Design

**Date:** 2026-07-09
**Status:** Approved (design), pending implementation plan

## Problem

Today a user pays once and receives **exactly one** thread, in **one tone** and
**one length** they must choose *before* seeing any output. Two pains compound:

1. **Blind bet** — the user guesses which tone fits their topic. A wrong guess
   yields an unusable thread they already paid for.
2. **No comparison + destructive overwrite** *(the primary driver)* — to see a
   different tone they must re-roll, and `regenerateGeneration` **overwrites** the
   existing thread. They cannot place two versions side by side, and a worse
   re-roll destroys the good one. Classic single-output AI-tool frustration.

The value delivered per payment is therefore low and feels like a coin flip — a
direct cause of one-and-done usage (retention).

This feature flips the flow from **choose-then-see** to **see-then-choose**: one
payment generates the same topic in **all three tones in parallel**, the user
compares them side by side and picks a winner, and the losing variants are kept
(not discarded).

## Decisions (locked)

- **Mechanism:** parallel generation — one payment produces all variants at once
  (not non-destructive re-rolls).
- **Variation axis:** by **tone** — `educational`, `funny`, `threadboi` (fixed set
  of all three; user does not pick a subset).
- **Mode:** opt-in, alongside the existing single-tone flow — does not replace it.
  Length is still user-chosen; only tone is fanned out.
- **Pricing:** higher price, **×3** the base price (matches the ~3× LLM cost).
- **Lifecycle:** keep all three; mark a **winner**. The winner is the default
  (shown, shared, regenerated); the other two remain viewable and re-selectable.
  No paid data is discarded.

## Why this is low-risk (grounded in current code)

- **Pricing is already per-invoice.** `invoices.price_stx` / `price_sbtc` are stored
  per invoice, and the on-chain check is `receipt.amount >= required` where
  `required` is the invoice price. Charging ×3 = storing a larger number at quote
  time. **No contract change, no post-condition change.**
- **`generations.thread_content` is the single read path.** History, share, the
  OG-image route, and regenerate all read `thread_content`. If we keep
  `thread_content` = the *winner's* thread, those paths work unchanged.

## Architecture & Flow

A new opt-in mode toggled on `ThreadForm` ("So sánh cả 3 tone (×3 giá)"). When on,
the tone selector is hidden; the user picks only topic + length.

1. **Quote (HTTP 402)** — `POST /api/generate` with `params.multiTone: true` (no
   `tone`). Server:
   - validates via the service (length still required),
   - computes price = `def.priceStx × 3` and `def.priceSbtc × 3`,
   - records the invoice as multi-tone (see Data Model),
   - returns 402 with the ×3 price, exactly like the single-tone quote.
2. **Pay** — unchanged. Wallet signs `pay-stx` / `pay-sbtc` with post-conditions;
   the on-chain receipt's `amount >= required` enforces the ×3 price automatically.
3. **Redeem** — `POST /api/generate` with `{invoiceId, txId}`. After the existing
   receipt verification + atomic `pending → generating` lock, the server generates
   **all three tones in parallel** (`Promise.all`), persists all variants, sets the
   default winner = `educational`, and returns all three to the client.

## Data Model (additive migration, no column rewrites)

New migration `0012_generations_variants.sql` (next after `0011_events_source_slug.sql`):

```sql
alter table generations add column if not exists variants jsonb;      -- [{tone, thread:[...]}], NULL for normal generations
alter table generations add column if not exists selected_tone text;  -- current winner tone, NULL for normal generations
```

- `thread_content` **always** holds the winner's thread → history / share /
  OG-image / regenerate read it unchanged.
- `variants = NULL` ⇒ ordinary single-tone generation (100% backward compatible).

Invoice side — the redeem branch must know which tones to fan out. `invoices.tone`
is `NOT NULL`, so rather than overloading it we add an explicit small column:

```sql
alter table invoices add column if not exists variant_tones jsonb;    -- e.g. ["educational","funny","threadboi"]; NULL for single-tone
```

The single-tone flow leaves `variant_tones` NULL and behaves exactly as today.
`invoices.tone` for a multi-tone invoice is set to a sentinel (`'multi'`) so the
existing NOT NULL check passes; the redeem branch reads `variant_tones`, not `tone`.

## Generation

No new prompts. Call `def.generate(params, hooks)` three times with
`params.tone` set to each of the three tones, in parallel. Reuse the existing
`TONE_GUIDE`.

Partial-failure policy (protect the paying user):
- **≥1 tone succeeds** → persist and return the successful variants; note which
  tones failed. The user still gets value for their payment.
- **All three fail** → release the lock and return an error so the client can
  retry (mirrors the current single-tone failure path — never consume on failure).

The default winner is the first successful tone in canonical order
(`educational` → `funny` → `threadboi`).

## Selecting a Winner (new endpoint)

`POST /api/select-tone` `{invoiceId, tone}`, gated by a wallet signature via the
shared `authenticateAddress` helper (same pattern as `/api/regenerate`):

- Reject junk `invoiceId` (64-hex) before any DB read.
- Load invoice + generation; require `invoice.status === 'consumed'` and
  `generation.payer_address === auth.address` (ownership from the verified receipt).
- Require the generation to have `variants` and the requested `tone` to be present.
- UPDATE: set `selected_tone = tone` and copy `variants[tone].thread` into
  `thread_content`.
- Issue/refresh the session cookie like `/api/regenerate` so repeat selections
  don't re-prompt the wallet.

The two non-winning variants stay in `variants` — viewable and re-selectable
anytime.

## UI

- **`ThreadForm`** — add a toggle "So sánh cả 3 tone (×3 giá)". When on, hide the
  tone selector; keep topic + length.
- **Result view** — three side-by-side columns/tabs of `TweetCard`, one per tone,
  each with a "Chọn bản này" (select) action. The winner gets a highlighted frame,
  consistent with the Van Gogh framed-painting theme.
- **History / share** — render the winner as an ordinary thread; add a "3 tones"
  badge and allow switching the winner (calls `/api/select-tone`).

## Error Handling

- Quote with both `tone` and `multiTone` set → treat as multi-tone (ignore `tone`)
  or 400; pick 400 for clarity.
- Redeem on a multi-tone invoice reuses the existing lock/consume machinery;
  partial success persists variants under the same atomic consume.
- `/api/select-tone` on a non-multi-tone generation (`variants = NULL`) → 409
  "nothing to select".
- Unknown/absent requested tone → 400.

## Testing

Route + unit tests:
- Quote in multi-tone mode prices at exactly ×3 (STX and sBTC).
- Redeem generates and persists all three variants; `thread_content` = default
  winner; `selected_tone` set.
- One tone fails, two succeed → the two are persisted/returned, invoice consumed.
- All three fail → lock released, invoice not consumed, error returned.
- `/api/select-tone` swaps `thread_content` to the chosen tone and blocks
  non-owners (403) and non-multi generations (409).
- Backward compatibility: a normal (`variants = NULL`) generation leaves history /
  share behavior unchanged.

## Out of Scope (YAGNI)

- Per-tweet re-rolls *within* a variant (existing regenerate already covers this on
  the winner).
- Varying by hook or length (tone-only for this iteration).
- User-selectable subset of tones (always all three).
