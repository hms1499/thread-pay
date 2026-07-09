import { NextRequest, NextResponse } from 'next/server';
import {
  createInvoice, getInvoice, getGeneration, claimInvoice, releaseInvoice,
  saveGenerationAndConsume, isExpired, isGeneratingStale,
} from '@/lib/invoices';
import { fetchReceipt } from '@/lib/receipt';
import { getService } from '@/lib/services/registry';
import { assertServerEnv } from '@/lib/env';
import { clientIp, checkRateLimit } from '@/lib/rate-limit';
import { log } from '@/lib/log';
import {
  CONTRACT, SBTC_CONTRACT,
  RATE_LIMIT_QUOTE_MAX, RATE_LIMIT_QUOTE_WINDOW_SEC, TONES,
} from '@/lib/config';

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
  if (!body) {
    return NextResponse.json({ error: 'invalid JSON body' }, { status: 400 });
  }

  try {
  // ── Branch 1: no proof yet → return a quote (HTTP 402) ──
  if (!body.invoiceId) {
    let def;
    try {
      def = getService(typeof body.service === 'string' ? body.service : 'x-thread');
    } catch {
      return NextResponse.json({ error: 'unknown service' }, { status: 400 });
    }
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
    if (!v.ok) return NextResponse.json({ error: v.error }, { status: 400 });

    // Cap this unauthenticated branch per IP — only valid requests reach here, so junk
    // never burns quota, and a bot can't run up the LLM bill + spam the invoices table.
    const rl = await checkRateLimit(`quote:${clientIp(req)}`, {
      max: RATE_LIMIT_QUOTE_MAX, windowSec: RATE_LIMIT_QUOTE_WINDOW_SEC,
    });
    if (!rl.allowed) {
      return NextResponse.json(
        { error: 'rate limit exceeded, slow down', retryAfterSec: rl.retryAfterSec },
        { status: 429, headers: { 'Retry-After': String(rl.retryAfterSec) } },
      );
    }
    // Generate the free preview hook+outline. If it fails, degrade gracefully: still quote.
    let previewHook: string | null = null;
    let previewOutline: string[] | null = null;
    try {
      const preview = await def.generatePreview(v.params);
      previewHook = preview.hook;
      previewOutline = preview.outline;
    } catch (e) {
      log.warn('generate.preview_hook_failed', { err: e });
    }
    const MULT = wantMulti ? 3 : 1;
    const invoice = await createInvoice({
      serviceId: def.id, params: v.params as Record<string, unknown>,
      priceStx: def.priceStx * MULT, priceSbtc: def.priceSbtc * MULT,
      previewHook, previewOutline,
      variantTones: wantMulti ? [...TONES] : null,
    });
    return NextResponse.json({
      invoiceId: invoice.invoice_id,
      service: def.id,
      priceStx: invoice.price_stx,
      priceSbtc: invoice.price_sbtc,
      contract: CONTRACT,
      sbtcContract: SBTC_CONTRACT,
      expiresAt: invoice.expires_at,
      previewHook,
      previewOutline,
    }, { status: 402 });
  }

  // ── Branch 2: has proof → verify on-chain receipt → generate ──
  const invoice = await getInvoice(body.invoiceId);
  if (!invoice) {
    return NextResponse.json({ error: 'invoice not found' }, { status: 404 });
  }
  if (invoice.status === 'consumed') {
    // Already generated → return the cached result (avoids lost result / double request)
    const existing = await getGeneration(invoice.invoice_id);
    if (existing) {
      return NextResponse.json({
        thread: existing.thread_content, invoiceId: invoice.invoice_id,
        variants: existing.variants ?? undefined, selectedTone: existing.selected_tone ?? undefined,
      });
    }
    return NextResponse.json({ error: 'invoice already consumed' }, { status: 409 });
  }
  if (invoice.status === 'generating') {
    // Another request is generating → return result if ready.
    const existing = await getGeneration(invoice.invoice_id);
    if (existing) {
      return NextResponse.json({
        thread: existing.thread_content, invoiceId: invoice.invoice_id,
        variants: existing.variants ?? undefined, selectedTone: existing.selected_tone ?? undefined,
      });
    }
    // Fresh lock → genuinely in progress, ask the client to retry shortly.
    // Stale lock → the previous worker crashed; fall through to re-verify the
    // on-chain receipt and reclaim the slot (claimInvoice matches stale locks).
    if (!isGeneratingStale(invoice)) {
      return NextResponse.json({ error: 'generation in progress, retry shortly' }, { status: 202 });
    }
    log.warn('generate.stale_lock_reclaimed', { invoiceId: invoice.invoice_id });
  }

  // Verify the on-chain payment BEFORE checking expiry: a late-confirmed payment
  // (invoice already past expires_at) must still be honored — otherwise the user loses funds.
  const receipt = await fetchReceipt(invoice.invoice_id);
  if (!receipt) {
    // No on-chain payment yet. If the invoice expired without payment, treat it as dead.
    if (isExpired(invoice)) {
      return NextResponse.json({ error: 'invoice expired, request a new quote' }, { status: 410 });
    }
    return NextResponse.json({ error: 'payment not found on-chain yet' }, { status: 402 });
  }
  const required = receipt.token === 'STX'
    ? BigInt(invoice.price_stx) : BigInt(invoice.price_sbtc);
  if (receipt.amount < required) {
    return NextResponse.json({ error: 'underpaid' }, { status: 402 });
  }

  // Atomic lock: only the request that wins pending → generating calls the LLM.
  // Prevents double-spend when concurrent requests share the same invoiceId.
  const claimed = await claimInvoice(invoice.invoice_id);
  if (!claimed) {
    const existing = await getGeneration(invoice.invoice_id);
    if (existing) {
      return NextResponse.json({
        thread: existing.thread_content, invoiceId: invoice.invoice_id,
        variants: existing.variants ?? undefined, selectedTone: existing.selected_tone ?? undefined,
      });
    }
    return NextResponse.json({ error: 'generation in progress, retry shortly' }, { status: 202 });
  }

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
    // LLM failed → release the lock so the user can retry for free (receipt stays on-chain).
    await releaseInvoice(invoice.invoice_id);
    const message = e instanceof Error ? e.message : 'generation failed';
    return NextResponse.json(
      { error: `generation failed, payment preserved, retry: ${message}` },
      { status: 500 },
    );
  }

  const gen = await saveGenerationAndConsume({ ...baseGen, thread_content: thread });
  return NextResponse.json({ thread: gen.thread_content, invoiceId: invoice.invoice_id });
  } catch (e) {
    // Unwrapped failures (DB, on-chain read, parsing) would otherwise surface as
    // an opaque 500 logged only server-side. Log with context and return the real
    // message so the client can show it.
    log.error('generate.unhandled_error', { invoiceId: body.invoiceId, err: e });
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'internal server error' },
      { status: 500 },
    );
  }
}
