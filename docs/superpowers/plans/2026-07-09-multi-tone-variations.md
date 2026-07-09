# Multi-Tone Variations (A/B tones) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a user pay once (at ×3 price) to generate the same topic in all three tones in parallel, compare them, and pick a winner — without losing the other two variants.

**Architecture:** An opt-in mode on the existing x402 flow. The quote branch of `POST /api/generate` detects `params.multiTone`, prices ×3, and tags the invoice with `variant_tones`. The redeem branch fans out `def.generate` across the three tones in parallel, stores all variants on the `generations` row, and sets `thread_content` = the winner (default `educational`) so every existing read path (history, share, OG-image, regenerate) keeps working unchanged. A new `POST /api/select-tone` swaps the winner. The client gets a toggle plus a tone-tab switcher.

**Tech Stack:** Next.js 16 (App Router, webpack), React 19, TypeScript 5, Ant Design 6, Supabase (Postgres), Vitest. LLM via the pluggable provider (Groq default).

## Global Constraints

- **Webpack only** — `dev`/`build` run `--webpack`; never remove the flag.
- **Wallet contract-calls carry post-conditions** — unchanged here; pricing is enforced by the existing on-chain `amount >= required` check, so **no contract or post-condition change**.
- **On-chain receipt is the source of truth for payment** — never mark paid/consumed from client input.
- **`SUPABASE_SERVICE_ROLE_KEY` is server-only** — `lib/supabase.ts` must never reach a client component.
- **LLM is pluggable, not Claude** — reuse `def.generate`; do not hardwire a provider.
- **`tone` on `invoices` is nullable** (migration 0007) — a multi-tone invoice sets `variant_tones` and leaves `tone` NULL. No sentinel value.
- **Fixed tone set:** `TONES = ['educational', 'funny', 'threadboi']` from `lib/config.ts`. Multi-tone always uses all three.
- **Price multiplier:** `MULT = 3` applied to both `priceStx` and `priceSbtc`.
- **Winner default:** first *successful* tone in `TONES` order.
- All commits use the repo convention: no `Co-Authored-By` trailer, commit directly on `main`.

---

## File Structure

- `frontend/supabase/migrations/0012_multi_tone_variations.sql` — **create**. Adds `invoices.variant_tones`, `generations.variants`, `generations.selected_tone`.
- `frontend/src/lib/invoices.ts` — **modify**. Extend `Invoice`/`Generation` types; add `variantTones` to `createInvoice`; add `selectVariant`.
- `frontend/src/app/api/generate/route.ts` — **modify**. Quote branch (×3 pricing + tag invoice); redeem branch (parallel fan-out + partial-failure).
- `frontend/src/app/api/select-tone/route.ts` — **create**. Ownership-gated winner swap.
- `frontend/src/app/api/select-tone/__tests__/route.test.ts` — **create**.
- `frontend/src/components/ThreadForm.tsx` — **modify**. Multi-tone toggle; strip `tone` field when on; pass `multiTone` + `variantCount` up.
- `frontend/src/app/page.tsx` — **modify**. Store `variants`/`selectedTone`; render tone tabs; wire `/api/select-tone`; ×N price label.
- `frontend/src/lib/history.ts` — **modify** (Task 7). Surface `variants`/`selected_tone` for the badge.
- `frontend/src/components/HistoryPanel.tsx` — **modify** (Task 7). Show a "3 tones" badge.

Run all `npm` commands from `frontend/`.

---

### Task 1: Data model — migration, types, `createInvoice`, `selectVariant`

**Files:**
- Create: `frontend/supabase/migrations/0012_multi_tone_variations.sql`
- Modify: `frontend/src/lib/invoices.ts`

**Interfaces:**
- Produces:
  - `type Variant = { tone: string; thread: string[] }`
  - `Invoice.variant_tones?: string[] | null`
  - `Generation.variants?: Variant[] | null`, `Generation.selected_tone?: string | null`
  - `createInvoice(args: { …; variantTones?: string[] | null }): Promise<Invoice>`
  - `selectVariant(invoiceId: string, tone: string, thread: string[]): Promise<Generation | null>`

- [ ] **Step 1: Write the migration**

Create `frontend/supabase/migrations/0012_multi_tone_variations.sql`:

```sql
-- Migration: multi-tone variations (A/B tones)
--
-- One payment (×3 price) generates the same topic in all three tones. The invoice
-- is tagged with variant_tones so the redeem branch knows to fan out. The
-- generations row keeps every variant; thread_content stays = the winner's thread
-- so history/share/regenerate read paths are unchanged. selected_tone names the
-- current winner. All columns are nullable → existing single-tone rows are untouched.
--
-- Run this in the Supabase SQL editor.

alter table invoices    add column if not exists variant_tones jsonb;   -- e.g. ["educational","funny","threadboi"]; NULL for single-tone
alter table generations add column if not exists variants      jsonb;   -- [{"tone":"educational","thread":["..."]}]; NULL for single-tone
alter table generations add column if not exists selected_tone text;    -- winner tone; NULL for single-tone
```

- [ ] **Step 2: Extend the types in `lib/invoices.ts`**

Add near the top, after the existing `Invoice` type, extend it and `Generation`. Add `variant_tones` to `Invoice`:

```ts
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
```

Add a `Variant` type just above `Generation`, and extend `Generation`:

```ts
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
```

- [ ] **Step 3: Add `variantTones` to `createInvoice`**

Change the `createInvoice` args and the inserted object:

```ts
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
```

`saveGenerationAndConsume` needs **no change** — it inserts the whole `gen` object, so passing a `Generation` that already carries `variants` + `selected_tone` persists them.

- [ ] **Step 4: Add `selectVariant`**

Append to `lib/invoices.ts`:

```ts
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
```

- [ ] **Step 5: Typecheck + existing suite stay green**

Run: `npm run lint && npm test`
Expected: lint passes; all existing tests PASS (this task adds optional fields + one unused-yet function, so nothing regresses).

- [ ] **Step 6: Commit**

```bash
git add frontend/supabase/migrations/0012_multi_tone_variations.sql frontend/src/lib/invoices.ts
git commit -m "feat(variants): data model + selectVariant for multi-tone"
```

---

### Task 2: Quote branch — ×3 pricing + tag invoice

**Files:**
- Modify: `frontend/src/app/api/generate/route.ts` (Branch 1, the `if (!body.invoiceId)` block)
- Test: `frontend/src/app/api/generate/__tests__/route.test.ts`

**Interfaces:**
- Consumes: `createInvoice({ …, variantTones })` (Task 1), `TONES` from `@/lib/config`.
- Produces: a multi-tone quote — when `body.params.multiTone === true` and the service has a `tone` field, the returned invoice has `price_stx = def.priceStx * 3`, `price_sbtc = def.priceSbtc * 3`, and `variant_tones = ['educational','funny','threadboi']`.

- [ ] **Step 1: Write the failing test**

Add to `frontend/src/app/api/generate/__tests__/route.test.ts` (reuse the file's existing mocks for `createInvoice`, `checkRateLimit`, `assertServerEnv`; the registry is the real one). Match the file's existing `req()` / mock style:

```ts
it('multi-tone quote prices ×3 and tags variant_tones', async () => {
  m(checkRateLimit).mockResolvedValue({ allowed: true, retryAfterSec: 0 });
  m(createInvoice).mockImplementation(async (a) => ({
    invoice_id: 'b'.repeat(64), service_id: a.serviceId, params: a.params,
    price_stx: a.priceStx, price_sbtc: a.priceSbtc, status: 'pending',
    expires_at: new Date(Date.now() + 60000).toISOString(),
    preview_hook: null, preview_outline: null, variant_tones: a.variantTones ?? null,
  }));

  const res = await POST(req({
    service: 'x-thread',
    params: { topic: 'bitcoin layer 2', length: 5, language: 'auto', multiTone: true },
  }));

  expect(res.status).toBe(402);
  const arg = m(createInvoice).mock.calls[0][0];
  expect(arg.priceStx).toBe(100000 * 3);
  expect(arg.priceSbtc).toBe(100 * 3);
  expect(arg.variantTones).toEqual(['educational', 'funny', 'threadboi']);
  const body = await res.json();
  expect(body.priceStx).toBe(300000);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- generate`
Expected: FAIL — quote currently prices at `def.priceStx` (100000) and passes no `variantTones`.

- [ ] **Step 3: Implement the quote branch change**

In `route.ts` Branch 1, after `const v = def.validate(body.params);` currently returns 400 for a missing tone. Replace the validate + createInvoice region with multi-tone awareness. Insert this logic right after `def` is resolved and **before** `def.validate`:

```ts
    // Multi-tone mode: one payment (×3) generates all three tones in parallel.
    // Only services that actually expose a `tone` field support it.
    const wantMulti = !!(body.params && (body.params as Record<string, unknown>).multiTone);
    const hasTone = def.fields.some((f) => f.name === 'tone');
    if (wantMulti && !hasTone) {
      return NextResponse.json({ error: 'this service does not support tone variations' }, { status: 400 });
    }
    // Validate the base params. In multi-tone mode there is no chosen tone, so
    // inject the canonical first tone purely to satisfy the service validator;
    // the actual fan-out uses variant_tones at redeem time.
    const rawParams = wantMulti
      ? { ...(body.params as Record<string, unknown>), tone: TONES[0] }
      : body.params;
    const v = def.validate(rawParams);
```

Then change the price + `createInvoice` call:

```ts
    const MULT = wantMulti ? 3 : 1;
    const invoice = await createInvoice({
      serviceId: def.id, params: v.params as Record<string, unknown>,
      priceStx: def.priceStx * MULT, priceSbtc: def.priceSbtc * MULT,
      previewHook, previewOutline,
      variantTones: wantMulti ? [...TONES] : null,
    });
```

Add `TONES` to the config import at the top of the file:

```ts
import {
  CONTRACT, SBTC_CONTRACT,
  RATE_LIMIT_QUOTE_MAX, RATE_LIMIT_QUOTE_WINDOW_SEC, TONES,
} from '@/lib/config';
```

(The existing preview generation stays as-is; in multi-tone mode it previews the injected `TONES[0]` tone, which is fine.)

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- generate`
Expected: PASS (new test + all existing generate tests still green).

- [ ] **Step 5: Commit**

```bash
git add frontend/src/app/api/generate/route.ts frontend/src/app/api/generate/__tests__/route.test.ts
git commit -m "feat(variants): multi-tone quote prices x3 and tags invoice"
```

---

### Task 3: Redeem branch — parallel fan-out + partial-failure

**Files:**
- Modify: `frontend/src/app/api/generate/route.ts` (Branch 2, after the atomic claim)
- Test: `frontend/src/app/api/generate/__tests__/route.test.ts`

**Interfaces:**
- Consumes: `invoice.variant_tones` (Task 1), `def.generate`, `saveGenerationAndConsume` (persists `variants` + `selected_tone`).
- Produces: redeem response `{ thread, invoiceId, variants?, selectedTone? }`. For a multi-tone invoice, `thread` = winner thread, `variants` = all successful `{tone, thread}`, `selectedTone` = winner tone.

- [ ] **Step 1: Write the failing test**

Add to the generate route test. Assume the file already mocks `getInvoice`, `claimInvoice`, `saveGenerationAndConsume`, `releaseInvoice`, `fetchReceipt`, and uses the real registry with `generateThread` mocked. Model on the existing single-tone redeem test:

```ts
it('multi-tone redeem generates all tones in parallel and stores variants', async () => {
  m(getInvoice).mockResolvedValue({
    invoice_id: INVOICE_ID, service_id: 'x-thread',
    params: { topic: 'bitcoin', length: 5, language: 'auto' },
    price_stx: 300000, price_sbtc: 300, status: 'pending',
    expires_at: new Date(Date.now() + 60000).toISOString(),
    preview_hook: null, preview_outline: null,
    variant_tones: ['educational', 'funny', 'threadboi'],
  });
  m(fetchReceipt).mockResolvedValue({ payer: PAYER, token: 'STX', amount: 300000n });
  m(claimInvoice).mockResolvedValue(true);
  // Real x-thread.generate calls generateThread; return a tone-tagged thread.
  m(generateThread).mockImplementation(async (topic, tone) => [`${tone}-1`, `${tone}-2`]);
  m(saveGenerationAndConsume).mockImplementation(async (g) => g);

  const res = await POST(req({ invoiceId: INVOICE_ID, txId: 'tx' }));

  expect(res.status).toBe(200);
  expect(generateThread).toHaveBeenCalledTimes(3);
  const saved = m(saveGenerationAndConsume).mock.calls[0][0];
  expect(saved.variants).toHaveLength(3);
  expect(saved.selected_tone).toBe('educational');
  expect(saved.thread_content).toEqual(['educational-1', 'educational-2']);
  const body = await res.json();
  expect(body.selectedTone).toBe('educational');
  expect(body.variants).toHaveLength(3);
});

it('multi-tone redeem tolerates one failed tone', async () => {
  m(getInvoice).mockResolvedValue({
    invoice_id: INVOICE_ID, service_id: 'x-thread',
    params: { topic: 'bitcoin', length: 5, language: 'auto' },
    price_stx: 300000, price_sbtc: 300, status: 'pending',
    expires_at: new Date(Date.now() + 60000).toISOString(),
    preview_hook: null, preview_outline: null,
    variant_tones: ['educational', 'funny', 'threadboi'],
  });
  m(fetchReceipt).mockResolvedValue({ payer: PAYER, token: 'STX', amount: 300000n });
  m(claimInvoice).mockResolvedValue(true);
  m(generateThread).mockImplementation(async (topic, tone) => {
    if (tone === 'funny') throw new Error('llm blip');
    return [`${tone}-1`];
  });
  m(saveGenerationAndConsume).mockImplementation(async (g) => g);

  const res = await POST(req({ invoiceId: INVOICE_ID, txId: 'tx' }));

  expect(res.status).toBe(200);
  const saved = m(saveGenerationAndConsume).mock.calls[0][0];
  expect(saved.variants.map((x) => x.tone)).toEqual(['educational', 'threadboi']);
  expect(releaseInvoice).not.toHaveBeenCalled();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- generate`
Expected: FAIL — redeem currently calls `def.generate` once and saves a single-tone generation.

- [ ] **Step 3: Implement the redeem fan-out**

In `route.ts` Branch 2, the current block after the claim is:

```ts
  let thread: string[];
  try {
    const def = getService(invoice.service_id);
    thread = await def.generate(invoice.params ?? {}, { previewHook: invoice.preview_hook ?? null, previewOutline: invoice.preview_outline ?? null });
  } catch (e) {
    await releaseInvoice(invoice.invoice_id);
    const message = e instanceof Error ? e.message : 'generation failed';
    return NextResponse.json(
      { error: `generation failed, payment preserved, retry: ${message}` },
      { status: 500 },
    );
  }

  const gen = await saveGenerationAndConsume({
    invoice_id: invoice.invoice_id,
    service_id: invoice.service_id,
    payer_address: receipt.payer,
    token: receipt.token,
    amount: Number(receipt.amount),
    tx_id: typeof body.txId === 'string' ? body.txId : '',
    thread_content: thread,
  });

  return NextResponse.json({ thread: gen.thread_content, invoiceId: invoice.invoice_id });
```

Replace it with a branch on `variant_tones`:

```ts
  const def = getService(invoice.service_id);
  const baseGen = {
    invoice_id: invoice.invoice_id,
    service_id: invoice.service_id,
    payer_address: receipt.payer,
    token: receipt.token,
    amount: Number(receipt.amount),
    tx_id: typeof body.txId === 'string' ? body.txId : '',
  };

  const tones = Array.isArray(invoice.variant_tones) ? invoice.variant_tones : null;

  if (tones && tones.length > 0) {
    // Multi-tone: fan out one generate per tone in parallel. Each tone writes its
    // own hook (previewHook is tone-specific, so we don't reuse it here). One tone
    // failing must not sink the whole request — the user paid for choice.
    const settled = await Promise.allSettled(
      tones.map((t) =>
        def.generate({ ...(invoice.params ?? {}), tone: t }, { previewHook: null, previewOutline: null })),
    );
    const variants = settled
      .map((r, i) => (r.status === 'fulfilled' ? { tone: tones[i], thread: r.value } : null))
      .filter((x): x is { tone: string; thread: string[] } => x !== null);

    if (variants.length === 0) {
      await releaseInvoice(invoice.invoice_id);
      return NextResponse.json(
        { error: 'generation failed, payment preserved, retry: all tones failed' },
        { status: 500 },
      );
    }

    const winner = variants[0];
    const gen = await saveGenerationAndConsume({
      ...baseGen,
      thread_content: winner.thread,
      variants,
      selected_tone: winner.tone,
    });
    return NextResponse.json({
      thread: gen.thread_content, invoiceId: invoice.invoice_id,
      variants: gen.variants, selectedTone: gen.selected_tone,
    });
  }

  // Single-tone (unchanged behavior).
  let thread: string[];
  try {
    thread = await def.generate(invoice.params ?? {}, { previewHook: invoice.preview_hook ?? null, previewOutline: invoice.preview_outline ?? null });
  } catch (e) {
    await releaseInvoice(invoice.invoice_id);
    const message = e instanceof Error ? e.message : 'generation failed';
    return NextResponse.json(
      { error: `generation failed, payment preserved, retry: ${message}` },
      { status: 500 },
    );
  }

  const gen = await saveGenerationAndConsume({ ...baseGen, thread_content: thread });
  return NextResponse.json({ thread: gen.thread_content, invoiceId: invoice.invoice_id });
```

Also update the three early "return cached result" branches (`status === 'consumed'`, `status === 'generating'`, and the post-claim `if (!claimed)` path) to include variants when present, so a re-request of a multi-tone invoice still returns them. For each `NextResponse.json({ thread: existing.thread_content, invoiceId: invoice.invoice_id })`, change to:

```ts
      return NextResponse.json({
        thread: existing.thread_content, invoiceId: invoice.invoice_id,
        variants: existing.variants ?? undefined, selectedTone: existing.selected_tone ?? undefined,
      });
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- generate`
Expected: PASS (both new tests + all existing generate tests green).

- [ ] **Step 5: Commit**

```bash
git add frontend/src/app/api/generate/route.ts frontend/src/app/api/generate/__tests__/route.test.ts
git commit -m "feat(variants): multi-tone redeem fans out tones with partial-failure tolerance"
```

---

### Task 4: `POST /api/select-tone` — winner swap

**Files:**
- Create: `frontend/src/app/api/select-tone/route.ts`
- Test: `frontend/src/app/api/select-tone/__tests__/route.test.ts`

**Interfaces:**
- Consumes: `getInvoice`, `getGeneration`, `selectVariant` (Task 1); `authenticateAddress`, `applySessionCookie` from `@/lib/request-auth`.
- Produces: `POST /api/select-tone` `{ invoiceId, tone }` → `{ thread, selectedTone }`. 400 bad input / unknown tone; 401 unauth; 403 not payer; 404 no generation; 409 not a multi-tone generation.

- [ ] **Step 1: Write the failing test**

Create `frontend/src/app/api/select-tone/__tests__/route.test.ts` (model on the regenerate test's mocks):

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/invoices', () => ({
  getInvoice: vi.fn(), getGeneration: vi.fn(), selectVariant: vi.fn(),
}));
vi.mock('@/lib/env', () => ({ assertServerEnv: vi.fn() }));
vi.mock('@/lib/auth', () => ({ verifyHistoryAuth: vi.fn() }));
vi.mock('@/lib/session', () => ({
  SESSION_COOKIE: 'tg_session',
  verifySessionToken: vi.fn(),
  createSessionToken: vi.fn(() => 'minted-token'),
  sessionCookieOptions: vi.fn(() => ({ path: '/' })),
}));

import { POST } from '../route';
import * as invoices from '@/lib/invoices';
import { verifyHistoryAuth } from '@/lib/auth';
import { verifySessionToken } from '@/lib/session';

const m = vi.mocked;
const INVOICE_ID = 'a'.repeat(64);
const PAYER = 'ST1PAYER';

function req(body: unknown, cookie?: string) {
  return {
    json: async () => body,
    cookies: { get: () => (cookie ? { value: cookie } : undefined) },
  } as unknown as Parameters<typeof POST>[0];
}

function consumed(overrides = {}) {
  return {
    invoice_id: INVOICE_ID, service_id: 'x-thread', params: {},
    price_stx: 300000, price_sbtc: 300, status: 'consumed',
    expires_at: new Date().toISOString(), variant_tones: ['educational', 'funny', 'threadboi'],
    ...overrides,
  } as invoices.Invoice;
}
function multiGen(overrides = {}) {
  return {
    invoice_id: INVOICE_ID, service_id: 'x-thread', payer_address: PAYER,
    token: 'STX', amount: 300000, tx_id: 'tx', thread_content: ['edu-1'],
    selected_tone: 'educational',
    variants: [
      { tone: 'educational', thread: ['edu-1'] },
      { tone: 'funny', thread: ['fun-1'] },
      { tone: 'threadboi', thread: ['boi-1'] },
    ],
    ...overrides,
  } as invoices.Generation;
}

beforeEach(() => {
  vi.clearAllMocks();
  m(verifySessionToken).mockReturnValue({ address: PAYER });
  m(verifyHistoryAuth).mockReturnValue({ ok: true });
});

describe('POST /api/select-tone', () => {
  it('400 when invoiceId is malformed', async () => {
    const res = await POST(req({ invoiceId: 'nope', tone: 'funny' }));
    expect(res.status).toBe(400);
  });

  it('403 when the caller is not the payer', async () => {
    m(verifySessionToken).mockReturnValue({ address: 'ST1OTHER' });
    m(invoices.getInvoice).mockResolvedValue(consumed());
    m(invoices.getGeneration).mockResolvedValue(multiGen());
    const res = await POST(req({ invoiceId: INVOICE_ID, tone: 'funny' }));
    expect(res.status).toBe(403);
    expect(invoices.selectVariant).not.toHaveBeenCalled();
  });

  it('409 when the generation has no variants', async () => {
    m(invoices.getInvoice).mockResolvedValue(consumed());
    m(invoices.getGeneration).mockResolvedValue(multiGen({ variants: null }));
    const res = await POST(req({ invoiceId: INVOICE_ID, tone: 'funny' }));
    expect(res.status).toBe(409);
  });

  it('400 when the tone is not among the variants', async () => {
    m(invoices.getInvoice).mockResolvedValue(consumed());
    m(invoices.getGeneration).mockResolvedValue(multiGen());
    const res = await POST(req({ invoiceId: INVOICE_ID, tone: 'bogus' }));
    expect(res.status).toBe(400);
  });

  it('swaps thread_content to the chosen tone', async () => {
    m(invoices.getInvoice).mockResolvedValue(consumed());
    m(invoices.getGeneration).mockResolvedValue(multiGen());
    m(invoices.selectVariant).mockResolvedValue(multiGen({ selected_tone: 'funny', thread_content: ['fun-1'] }));
    const res = await POST(req({ invoiceId: INVOICE_ID, tone: 'funny' }));
    expect(res.status).toBe(200);
    expect(invoices.selectVariant).toHaveBeenCalledWith(INVOICE_ID, 'funny', ['fun-1']);
    const body = await res.json();
    expect(body.thread).toEqual(['fun-1']);
    expect(body.selectedTone).toBe('funny');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- select-tone`
Expected: FAIL — the route file does not exist yet.

- [ ] **Step 3: Implement the route**

Create `frontend/src/app/api/select-tone/route.ts`:

```ts
import { NextRequest, NextResponse } from 'next/server';
import { getInvoice, getGeneration, selectVariant } from '@/lib/invoices';
import { assertServerEnv } from '@/lib/env';
import { authenticateAddress, applySessionCookie } from '@/lib/request-auth';
import { log } from '@/lib/log';

export async function POST(req: NextRequest) {
  try {
    assertServerEnv();
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'server misconfigured' },
      { status: 500 },
    );
  }

  const body = await req.json().catch(() => null);
  const invoiceId = body && typeof body.invoiceId === 'string' ? body.invoiceId : '';
  if (!/^[0-9a-f]{64}$/.test(invoiceId)) {
    return NextResponse.json({ error: 'invoiceId is required' }, { status: 400 });
  }
  const tone = body && typeof body.tone === 'string' ? body.tone : '';
  if (!tone) {
    return NextResponse.json({ error: 'tone is required' }, { status: 400 });
  }

  // Switching the winner overwrites a paid thread's canonical content, so gate on
  // ownership (not the invoiceId alone), mirroring /api/regenerate.
  const auth = authenticateAddress(req, body);
  if (!auth.ok) return NextResponse.json({ error: `unauthorized: ${auth.reason}` }, { status: 401 });

  try {
    const [invoice, generation] = await Promise.all([
      getInvoice(invoiceId),
      getGeneration(invoiceId),
    ]);
    if (!invoice || !generation) {
      return NextResponse.json({ error: 'nothing to select' }, { status: 404 });
    }
    if (generation.payer_address !== auth.address) {
      return NextResponse.json({ error: 'forbidden: not your thread' }, { status: 403 });
    }
    const variants = generation.variants;
    if (!Array.isArray(variants) || variants.length === 0) {
      return NextResponse.json({ error: 'this thread has no tone variants' }, { status: 409 });
    }
    const chosen = variants.find((v) => v.tone === tone);
    if (!chosen) {
      return NextResponse.json({ error: 'unknown tone' }, { status: 400 });
    }

    const updated = await selectVariant(invoiceId, tone, chosen.thread);
    if (!updated) {
      return NextResponse.json({ error: 'select failed, retry' }, { status: 409 });
    }

    const res = NextResponse.json({ thread: updated.thread_content, selectedTone: updated.selected_tone });
    if (auth.mintCookie) applySessionCookie(res, auth.address);
    return res;
  } catch (e) {
    log.error('select_tone.unhandled_error', { invoiceId, err: e });
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'internal server error' },
      { status: 500 },
    );
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- select-tone`
Expected: PASS (all 5 cases).

- [ ] **Step 5: Commit**

```bash
git add frontend/src/app/api/select-tone/
git commit -m "feat(variants): /api/select-tone winner swap (ownership-gated)"
```

---

### Task 5: ThreadForm — multi-tone toggle

**Files:**
- Modify: `frontend/src/components/ThreadForm.tsx`

**Interfaces:**
- Produces: `FormValues` gains `multiTone: boolean`. When `multiTone` is on, the `tone` field is hidden and `params.multiTone: true` is included; the submit passes `multiTone` up.

- [ ] **Step 1: Extend `FormValues` and add the toggle**

Change the type:

```ts
export type FormValues = { service: string; params: Record<string, unknown>; token: 'STX' | 'SBTC'; multiTone: boolean };
```

Add state inside the component, after the `token` state:

```ts
  const [multiTone, setMultiTone] = useState(false);
```

The multi-tone toggle only makes sense for a service that has a `tone` field. Compute it from `selected.fields`:

```ts
  const hasTone = selected.fields.some((f) => f.name === 'tone');
```

- [ ] **Step 2: Hide the tone field and render the toggle**

Filter the fields passed to `ServiceForm` so the tone selector disappears in multi-tone mode:

```tsx
        <ServiceForm
          fields={multiTone ? selected.fields.filter((f) => f.name !== 'tone') : selected.fields}
          params={params}
          onChange={(name, value) => setParams((p) => ({ ...p, [name]: value }))}
          disabled={disabled}
        />

        {hasTone && (
          <Flex vertical gap={8}>
            <FieldLabel>Tones</FieldLabel>
            <Segmented
              block
              value={multiTone ? 'all' : 'one'}
              onChange={(v) => setMultiTone(v === 'all')}
              disabled={disabled}
              options={[
                { label: 'One tone', value: 'one' },
                { label: 'Compare all 3 (×3 price)', value: 'all' },
              ]}
            />
          </Flex>
        )}
```

Reset `multiTone` when the service changes (add to the existing `useEffect` that seeds params, or a small effect):

```ts
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (selected) { setParams(defaultParams(selected.fields)); setMultiTone(false); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected?.id]);
```

- [ ] **Step 3: Include `multiTone` on submit**

```ts
  function submit() {
    if (clientValidate(selected.fields, params)) return;
    const params2 = multiTone ? { ...params, multiTone: true } : params;
    onSubmit({ service: selected.id, params: params2, token, multiTone });
  }
```

Note: when `multiTone` is on, `clientValidate` still runs against `selected.fields` including `tone`; `tone` has a default (`'educational'`) so it validates fine even though hidden. No change needed.

- [ ] **Step 4: Verify build + lint**

Run: `npm run lint`
Expected: PASS. (ThreadForm has no unit test; the callsite in `page.tsx` is updated in Task 6, so a temporary type mismatch on `onSubmit` is expected until Task 6 — run the full `npm run build` at the end of Task 6.)

- [ ] **Step 5: Commit**

```bash
git add frontend/src/components/ThreadForm.tsx
git commit -m "feat(variants): ThreadForm multi-tone toggle"
```

---

### Task 6: page.tsx — variant tabs + winner switch + ×N price

**Files:**
- Modify: `frontend/src/app/page.tsx`

**Interfaces:**
- Consumes: redeem response `{ thread, variants?, selectedTone? }` (Task 3); `POST /api/select-tone` (Task 4); `FormValues.multiTone` (Task 5).
- Produces: end-to-end multi-tone UX — a tone switcher above the thread that swaps the displayed thread and persists the winner.

- [ ] **Step 1: Add variant state**

Near the other `useState` calls, add:

```ts
  const [variants, setVariants] = useState<{ tone: string; thread: string[] }[] | null>(null);
  const [selectedTone, setSelectedTone] = useState<string | null>(null);
```

- [ ] **Step 2: Capture variants in `redeem`**

In `redeem`, where it currently does `setThread(data.thread)`, add variant handling right after:

```ts
      setThread(data.thread);
      setVariants(Array.isArray(data.variants) ? data.variants : null);
      setSelectedTone(typeof data.selectedTone === 'string' ? data.selectedTone : null);
```

And clear them on a fresh generate — in `handleGenerate`'s reset line at the top, add `setVariants(null); setSelectedTone(null);`.

- [ ] **Step 3: Thread the price label for multi-tone (×3)**

`handleGenerate` receives `values: FormValues`. The quote already returns the ×3 price from Task 2, so `previewPriceLabel` is already correct (it reads `quote.priceStx`). No math change needed — just confirm the label uses the quoted price (it does). No code change in this step; it is here to make the dependency explicit.

- [ ] **Step 4: Render the tone switcher**

In the "Generated thread" block, just under the `Your thread` title row and above the `TweetCard` list, add a switcher shown only when variants exist:

```tsx
      {variants && variants.length > 1 && (
        <Segmented
          block
          value={selectedTone ?? variants[0].tone}
          onChange={(v) => selectTone(String(v))}
          options={variants.map((x) => ({ label: x.tone, value: x.tone }))}
          style={{ marginBottom: 4 }}
        />
      )}
```

Import `Segmented` from `antd` at the top (add to the existing `antd` import list).

- [ ] **Step 5: Implement `selectTone`**

Add alongside the other authed actions (near `regenerate`):

```ts
  async function selectTone(tone: string) {
    if (!displayedInvoiceId || tone === selectedTone) return;
    // Optimistic: show the chosen variant immediately, then persist the winner.
    const local = variants?.find((v) => v.tone === tone);
    if (local) { setThread(local.thread); setSelectedTone(tone); }
    try {
      const res = await authedFetch('/api/select-tone', 'POST', { invoiceId: displayedInvoiceId, tone });
      if (res.status === 403) throw new Error('This thread was paid by a different wallet. Switch to the paying account and try again.');
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? `Error ${res.status}`);
      setThread(data.thread);
      setSelectedTone(data.selectedTone);
    } catch (e) {
      message.error(e instanceof Error ? e.message : 'Could not switch tone');
    }
  }
```

- [ ] **Step 6: Full build + test**

Run: `npm run build && npm test`
Expected: build succeeds (webpack); all tests PASS. This confirms the Task 5 `onSubmit` type now matches (`handleGenerate` accepts `FormValues` with `multiTone`).

- [ ] **Step 7: Manual smoke (testnet env for free E2E)**

With `frontend/.env.local` pointed at testnet values, run `npm run dev`, connect a testnet wallet, toggle "Compare all 3 (×3 price)", generate, pay, and confirm: three tone tabs appear, switching tabs swaps the thread, and the price shown is ×3. Reload history — the winner renders as an ordinary thread.

- [ ] **Step 8: Commit**

```bash
git add frontend/src/app/page.tsx
git commit -m "feat(variants): tone tabs + winner switch on the result view"
```

---

### Task 7: History badge — "3 tones"

**Files:**
- Modify: `frontend/src/lib/history.ts`
- Modify: `frontend/src/components/HistoryPanel.tsx`
- Test: `frontend/src/lib/__tests__/history.test.ts`

**Interfaces:**
- Consumes: `generations.selected_tone` (Task 1).
- Produces: `HistoryItem.selected_tone: string | null`; HistoryPanel shows a badge for multi-tone rows.

- [ ] **Step 1: Write the failing test**

Add to `frontend/src/lib/__tests__/history.test.ts` (it already tests `normalizeRow`):

```ts
it('normalizeRow surfaces selected_tone', () => {
  const item = normalizeRow({
    id: 1, invoice_id: 'x', service_id: 'x-thread', token: 'STX', amount: 1,
    tx_id: 't', thread_content: ['a'], created_at: '2026-07-09T00:00:00Z',
    invoices: { topic: 'hi', params: null }, selected_tone: 'funny',
  } as unknown as Parameters<typeof normalizeRow>[0]);
  expect(item.selected_tone).toBe('funny');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- history`
Expected: FAIL — `HistoryItem` has no `selected_tone`.

- [ ] **Step 3: Implement**

In `lib/history.ts`: add `selected_tone: string | null` to `HistoryItem`; add `selected_tone` to `RawRow`; add it to the `COLUMNS` string; set it in `normalizeRow`:

```ts
export type HistoryItem = {
  invoice_id: string;
  service_id: string;
  token: string;
  amount: number;
  tx_id: string;
  thread_content: string[];
  created_at: string;
  topic: string | null;
  selected_tone: string | null;
};
```

Add `selected_tone: string | null;` to the `RawRow` type. Change:

```ts
const COLUMNS = 'id, invoice_id, service_id, token, amount, tx_id, thread_content, created_at, selected_tone, invoices(topic, params)';
```

In `normalizeRow`, add to the returned object:

```ts
    selected_tone: raw.selected_tone ?? null,
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- history`
Expected: PASS.

- [ ] **Step 5: Add the badge in HistoryPanel**

In `frontend/src/components/HistoryPanel.tsx`, where each row renders its topic/label, add a small tag when `item.selected_tone` is set. Use the existing antd `Tag` (import it if not already):

```tsx
{item.selected_tone && (
  <Tag color="purple" style={{ marginLeft: 6 }}>3 tones</Tag>
)}
```

(Place it next to the row's title text; match the surrounding markup in the file.)

- [ ] **Step 6: Build + lint**

Run: `npm run build && npm run lint`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add frontend/src/lib/history.ts frontend/src/components/HistoryPanel.tsx frontend/src/lib/__tests__/history.test.ts
git commit -m "feat(variants): 3-tones badge in history"
```

---

## Verification Checklist (after all tasks)

- [ ] `cd frontend && npm run build && npm test && npm run lint` all green.
- [ ] Migration `0012` applied in Supabase (Supabase SQL editor) before deploying.
- [ ] Manual E2E on testnet: single-tone flow still works unchanged; multi-tone flow prices ×3, shows three tabs, switches winner, persists across reload.
- [ ] Backward compatibility: an existing single-tone generation (`variants = NULL`) renders in history/share exactly as before.

## Notes / Deviations from spec

- The spec proposed a `tone = 'multi'` sentinel on `invoices`. Migration 0007 already made `invoices.tone` nullable, so **no sentinel is needed** — a multi-tone invoice simply has `variant_tones` set and `tone` NULL.
- The spec's "three side-by-side columns/tabs" is implemented as an antd `Segmented` tone switcher (the "tabs" option) — one thread visible at a time, mobile-friendly, minimal new markup.
- `saveGenerationAndConsume` needed no change: it inserts the full `Generation` object, so `variants`/`selected_tone` persist by simply being present.
- Spec suggested returning 400 when a quote carries both `tone` and `multiTone`. The plan instead **ignores** a stray `tone` in multi-tone mode (all three tones are always used), which is simpler and harmless — no separate rejection path.
