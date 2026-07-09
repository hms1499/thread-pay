import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock the route's I/O boundaries (DB, on-chain, LLM).
vi.mock('@/lib/invoices', () => ({
  createInvoice: vi.fn(),
  getInvoice: vi.fn(),
  getGeneration: vi.fn(),
  claimInvoice: vi.fn(),
  releaseInvoice: vi.fn(),
  saveGenerationAndConsume: vi.fn(),
  isExpired: vi.fn(),
  isGeneratingStale: vi.fn(),
}));
vi.mock('@/lib/receipt', () => ({ fetchReceipt: vi.fn() }));
vi.mock('@/lib/generate-thread', () => ({ generateThread: vi.fn(), generateHook: vi.fn(), generateHookAndOutline: vi.fn() }));
vi.mock('@/lib/env', () => ({ assertServerEnv: vi.fn() }));
vi.mock('@/lib/rate-limit', () => ({ clientIp: vi.fn(), checkRateLimit: vi.fn() }));
// Use the real registry (so x-thread validate/generatePreview run for real, driving
// the mocked generate-thread helpers), but keep it spy-able for Branch 2 dispatch tests.
vi.mock('@/lib/services/registry', async (orig) => {
  const actual = await orig<typeof import('@/lib/services/registry')>();
  return { ...actual };
});

import { POST } from '../route';
import * as invoices from '@/lib/invoices';
import * as registry from '@/lib/services/registry';
import { fetchReceipt } from '@/lib/receipt';
import { generateThread, generateHook, generateHookAndOutline } from '@/lib/generate-thread';
import { clientIp, checkRateLimit } from '@/lib/rate-limit';

const m = vi.mocked;

// Fake NextRequest: the route only calls req.json()
function req(body: unknown) {
  return { json: async () => body } as unknown as Parameters<typeof POST>[0];
}

const INVOICE_ID = 'a'.repeat(64);

function baseInvoice(overrides: Partial<invoices.Invoice> = {}): invoices.Invoice {
  return {
    invoice_id: INVOICE_ID,
    service_id: 'x-thread',
    params: { topic: 'bitcoin layer 2', tone: 'educational', length: 5, language: 'auto' },
    topic: 'bitcoin layer 2',
    tone: 'educational',
    length: 5,
    price_stx: 100000,
    price_sbtc: 100,
    status: 'pending',
    expires_at: new Date(Date.now() + 60_000).toISOString(),
    ...overrides,
  };
}

const stxReceipt = { payer: 'ST1PAYER', amount: 100000n, token: 'STX' as const, paidAt: 1n };

beforeEach(() => {
  vi.clearAllMocks();
  // Default: caller is under the rate limit.
  m(clientIp).mockReturnValue('1.2.3.4');
  m(checkRateLimit).mockResolvedValue({ allowed: true, retryAfterSec: 0 });
});

// Some tests spy on the real registry; restore so the spy never leaks into others.
afterEach(() => {
  vi.restoreAllMocks();
});

describe('POST /api/generate — quote (branch 1)', () => {
  it('returns 402 + a new invoice when no invoiceId', async () => {
    m(invoices.createInvoice).mockResolvedValue(baseInvoice());
    const res = await POST(req({ service: 'x-thread', params: { topic: 'bitcoin layer 2', tone: 'educational', length: 5 } }));
    expect(res.status).toBe(402);
    const json = await res.json();
    expect(json.invoiceId).toBe(INVOICE_ID);
    expect(json.priceStx).toBe(100000);
  });

  it('unknown service -> 400, no rate-limit slot spent', async () => {
    const res = await POST(req({ service: 'nope', params: {} }));
    expect(res.status).toBe(400);
    expect(invoices.createInvoice).not.toHaveBeenCalled();
    expect(checkRateLimit).not.toHaveBeenCalled();
  });

  it('missing service defaults to x-thread and quotes 402 with the service id', async () => {
    m(invoices.createInvoice).mockResolvedValue(baseInvoice());
    const res = await POST(req({ params: { topic: 'AI', tone: 'funny', length: 5, language: 'en' } }));
    expect(res.status).toBe(402);
    expect((await res.json()).service).toBe('x-thread');
  });

  it('invalid params -> 400, without spending a rate-limit slot', async () => {
    const res = await POST(req({ service: 'x-thread', params: { topic: '', tone: 'funny', length: 5 } }));
    expect(res.status).toBe(400);
    expect(invoices.createInvoice).not.toHaveBeenCalled();
  });

  it('returns 400 for invalid tone/length, without spending a rate-limit slot', async () => {
    const res = await POST(req({ service: 'x-thread', params: { topic: 'x', tone: 'nope', length: 99 } }));
    expect(res.status).toBe(400);
    expect(invoices.createInvoice).not.toHaveBeenCalled();
    // Junk is rejected before the limiter, so it never burns quota.
    expect(checkRateLimit).not.toHaveBeenCalled();
  });

  it('rate-limited quote -> 429 with Retry-After, no LLM call, no invoice created', async () => {
    m(checkRateLimit).mockResolvedValue({ allowed: false, retryAfterSec: 42 });
    const res = await POST(req({ service: 'x-thread', params: { topic: 'bitcoin layer 2', tone: 'educational', length: 5 } }));
    expect(res.status).toBe(429);
    expect(res.headers.get('Retry-After')).toBe('42');
    expect((await res.json()).retryAfterSec).toBe(42);
    expect(generateHookAndOutline).not.toHaveBeenCalled();
    expect(invoices.createInvoice).not.toHaveBeenCalled();
  });

  it('checks the rate limit before quoting, keyed by client IP', async () => {
    m(invoices.createInvoice).mockResolvedValue(baseInvoice());
    await POST(req({ service: 'x-thread', params: { topic: 'bitcoin layer 2', tone: 'educational', length: 5 } }));
    expect(checkRateLimit).toHaveBeenCalledWith('quote:1.2.3.4', { max: 10, windowSec: 60 });
  });

  it('returns previewHook in the 402 when the hook generates', async () => {
    m(generateHookAndOutline).mockResolvedValue({ hook: 'a strong hook', outline: ['intro', 'body', 'cta', 'p4', 'p5'] });
    m(invoices.createInvoice).mockResolvedValue(baseInvoice({ preview_hook: 'a strong hook' }));
    const res = await POST(req({ service: 'x-thread', params: { topic: 'bitcoin layer 2', tone: 'educational', length: 5 } }));
    expect(res.status).toBe(402);
    expect((await res.json()).previewHook).toBe('a strong hook');
    expect(invoices.createInvoice).toHaveBeenCalledWith(expect.objectContaining({
      serviceId: 'x-thread',
      params: { topic: 'bitcoin layer 2', tone: 'educational', length: 5, language: 'auto' },
      previewHook: 'a strong hook',
    }));
  });

  it('still returns a 402 quote when the hook generation fails', async () => {
    m(generateHookAndOutline).mockRejectedValue(new Error('llm down'));
    m(invoices.createInvoice).mockResolvedValue(baseInvoice({ preview_hook: null, preview_outline: null }));
    const res = await POST(req({ service: 'x-thread', params: { topic: 'bitcoin layer 2', tone: 'educational', length: 5 } }));
    expect(res.status).toBe(402);
    const json = await res.json();
    expect(json.invoiceId).toBe(INVOICE_ID);
    expect(json.previewHook ?? null).toBeNull();
    expect(json.previewOutline ?? null).toBeNull();
    expect(invoices.createInvoice).toHaveBeenCalledWith(expect.objectContaining({
      serviceId: 'x-thread',
      params: { topic: 'bitcoin layer 2', tone: 'educational', length: 5, language: 'auto' },
      previewHook: null,
      previewOutline: null,
    }));
  });

  it('persists and returns previewOutline in the 402 body', async () => {
    m(generateHookAndOutline).mockResolvedValue({ hook: 'a strong hook', outline: ['a', 'b', 'c', 'd', 'e'] });
    m(invoices.createInvoice).mockResolvedValue(baseInvoice({ preview_hook: 'a strong hook', preview_outline: ['a', 'b', 'c', 'd', 'e'] }));
    const res = await POST(req({ service: 'x-thread', params: { topic: 'AI', tone: 'educational', length: 5 } }));
    expect(res.status).toBe(402);
    const json = await res.json();
    expect(json.previewOutline).toEqual(['a', 'b', 'c', 'd', 'e']);
    expect(invoices.createInvoice).toHaveBeenCalledWith(expect.objectContaining({
      previewOutline: ['a', 'b', 'c', 'd', 'e'],
    }));
  });

  it('passes a valid language through to the hook and the invoice', async () => {
    m(generateHookAndOutline).mockResolvedValue({ hook: 'un hook fuerte', outline: ['a', 'b', 'c', 'd', 'e'] });
    m(invoices.createInvoice).mockResolvedValue(baseInvoice({ preview_hook: 'un hook fuerte' }));
    await POST(req({ service: 'x-thread', params: { topic: 'bitcoin layer 2', tone: 'educational', length: 5, language: 'vi' } }));
    expect(generateHookAndOutline).toHaveBeenCalledWith('bitcoin layer 2', 'educational', 5, 'vi');
    expect(invoices.createInvoice).toHaveBeenCalledWith(expect.objectContaining({
      serviceId: 'x-thread',
      params: { topic: 'bitcoin layer 2', tone: 'educational', length: 5, language: 'vi' },
      previewHook: 'un hook fuerte',
    }));
  });

  it('falls back to auto for an unknown language instead of rejecting', async () => {
    m(generateHookAndOutline).mockRejectedValue(new Error('hook off')); // isolate from prior mock state
    m(invoices.createInvoice).mockResolvedValue(baseInvoice());
    const res = await POST(req({ service: 'x-thread', params: { topic: 'bitcoin layer 2', tone: 'educational', length: 5, language: 'klingon' } }));
    expect(res.status).toBe(402);
    expect(invoices.createInvoice).toHaveBeenCalledWith(expect.objectContaining({
      params: { topic: 'bitcoin layer 2', tone: 'educational', length: 5, language: 'auto' },
    }));
  });

  it('multi-tone quote prices ×3 and tags variant_tones', async () => {
    m(checkRateLimit).mockResolvedValue({ allowed: true, retryAfterSec: 0 });
    m(invoices.createInvoice).mockImplementation(async (a) => ({
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
    const arg = m(invoices.createInvoice).mock.calls[0][0];
    expect(arg.priceStx).toBe(100000 * 3);
    expect(arg.priceSbtc).toBe(100 * 3);
    expect(arg.variantTones).toEqual(['educational', 'funny', 'threadboi']);
    const body = await res.json();
    expect(body.priceStx).toBe(300000);
  });
});

describe('POST /api/generate — verify + generate (branch 2)', () => {
  it('returns 404 when the invoice does not exist', async () => {
    m(invoices.getInvoice).mockResolvedValue(null);
    const res = await POST(req({ invoiceId: INVOICE_ID }));
    expect(res.status).toBe(404);
  });

  it('consumed invoice -> returns cached thread, no LLM call', async () => {
    m(invoices.getInvoice).mockResolvedValue(baseInvoice({ status: 'consumed' }));
    m(invoices.getGeneration).mockResolvedValue({
      invoice_id: INVOICE_ID, service_id: 'x-thread', payer_address: 'ST1PAYER', token: 'STX',
      amount: 100000, tx_id: 'tx', thread_content: ['cu'],
    });
    const res = await POST(req({ invoiceId: INVOICE_ID }));
    expect(res.status).toBe(200);
    expect((await res.json()).thread).toEqual(['cu']);
    expect(generateThread).not.toHaveBeenCalled();
  });

  it('no receipt and not expired -> 402, no LLM call', async () => {
    m(invoices.getInvoice).mockResolvedValue(baseInvoice());
    m(invoices.isExpired).mockReturnValue(false);
    m(fetchReceipt).mockResolvedValue(null);
    const res = await POST(req({ invoiceId: INVOICE_ID }));
    expect(res.status).toBe(402);
    expect(generateThread).not.toHaveBeenCalled();
  });

  it('no receipt and expired -> 410', async () => {
    m(invoices.getInvoice).mockResolvedValue(baseInvoice());
    m(invoices.isExpired).mockReturnValue(true);
    m(fetchReceipt).mockResolvedValue(null);
    const res = await POST(req({ invoiceId: INVOICE_ID }));
    expect(res.status).toBe(410);
  });

  // ITEM 1: an on-chain receipt must be honored even if the invoice has expired.
  it('paid but invoice expired -> STILL generates (no lost funds)', async () => {
    m(invoices.getInvoice).mockResolvedValue(baseInvoice());
    m(invoices.isExpired).mockReturnValue(true); // expired
    m(fetchReceipt).mockResolvedValue(stxReceipt); // but already paid on-chain
    m(invoices.claimInvoice).mockResolvedValue(true);
    m(generateThread).mockResolvedValue(['t1', 't2']);
    m(invoices.saveGenerationAndConsume).mockImplementation(async (g) => g);
    const res = await POST(req({ invoiceId: INVOICE_ID }));
    expect(res.status).toBe(200);
    expect((await res.json()).thread).toEqual(['t1', 't2']);
    expect(generateThread).toHaveBeenCalledTimes(1);
  });

  it('underpaid -> 402, no LLM call', async () => {
    m(invoices.getInvoice).mockResolvedValue(baseInvoice());
    m(invoices.isExpired).mockReturnValue(false);
    m(fetchReceipt).mockResolvedValue({ ...stxReceipt, amount: 99999n });
    const res = await POST(req({ invoiceId: INVOICE_ID }));
    expect(res.status).toBe(402);
    expect(generateThread).not.toHaveBeenCalled();
  });

  it('valid payment -> wins claim -> generates and saves', async () => {
    m(invoices.getInvoice).mockResolvedValue(baseInvoice());
    m(invoices.isExpired).mockReturnValue(false);
    m(fetchReceipt).mockResolvedValue(stxReceipt);
    m(invoices.claimInvoice).mockResolvedValue(true);
    m(generateThread).mockResolvedValue(['hook', 'cta']);
    m(invoices.saveGenerationAndConsume).mockImplementation(async (g) => g);
    const res = await POST(req({ invoiceId: INVOICE_ID, txId: '0xtx' }));
    expect(res.status).toBe(200);
    expect((await res.json()).thread).toEqual(['hook', 'cta']);
    expect(generateThread).toHaveBeenCalledTimes(1);
    expect(invoices.saveGenerationAndConsume).toHaveBeenCalledTimes(1);
  });

  // ITEM 2: two concurrent requests -> only one generates.
  it('loses claim (concurrent request) -> NO LLM call, returns 202', async () => {
    m(invoices.getInvoice).mockResolvedValue(baseInvoice());
    m(invoices.isExpired).mockReturnValue(false);
    m(fetchReceipt).mockResolvedValue(stxReceipt);
    m(invoices.claimInvoice).mockResolvedValue(false); // the other request already claimed
    m(invoices.getGeneration).mockResolvedValue(null); // winner not done yet
    const res = await POST(req({ invoiceId: INVOICE_ID }));
    expect(res.status).toBe(202);
    expect(generateThread).not.toHaveBeenCalled();
  });

  it('loses claim but generation already done -> returns cached thread', async () => {
    m(invoices.getInvoice).mockResolvedValue(baseInvoice());
    m(invoices.isExpired).mockReturnValue(false);
    m(fetchReceipt).mockResolvedValue(stxReceipt);
    m(invoices.claimInvoice).mockResolvedValue(false);
    m(invoices.getGeneration).mockResolvedValue({
      invoice_id: INVOICE_ID, service_id: 'x-thread', payer_address: 'ST1PAYER', token: 'STX',
      amount: 100000, tx_id: 'tx', thread_content: ['xong'],
    });
    const res = await POST(req({ invoiceId: INVOICE_ID }));
    expect(res.status).toBe(200);
    expect((await res.json()).thread).toEqual(['xong']);
    expect(generateThread).not.toHaveBeenCalled();
  });

  it('status=generating, FRESH lock, no result yet -> 202 (no reclaim)', async () => {
    m(invoices.getInvoice).mockResolvedValue(baseInvoice({ status: 'generating' }));
    m(invoices.getGeneration).mockResolvedValue(null);
    m(invoices.isGeneratingStale).mockReturnValue(false);
    const res = await POST(req({ invoiceId: INVOICE_ID }));
    expect(res.status).toBe(202);
    expect(fetchReceipt).not.toHaveBeenCalled();
    expect(generateThread).not.toHaveBeenCalled();
  });

  // ITEM 1 (senior review): a crashed worker must not strand a paid user forever.
  it('status=generating, STALE lock, no result -> reclaims, re-verifies, generates', async () => {
    m(invoices.getInvoice).mockResolvedValue(baseInvoice({ status: 'generating' }));
    m(invoices.getGeneration).mockResolvedValue(null);
    m(invoices.isGeneratingStale).mockReturnValue(true); // previous worker died
    m(invoices.isExpired).mockReturnValue(false);
    m(fetchReceipt).mockResolvedValue(stxReceipt); // payment is on-chain
    m(invoices.claimInvoice).mockResolvedValue(true); // we win the stale slot
    m(generateThread).mockResolvedValue(['recovered']);
    m(invoices.saveGenerationAndConsume).mockImplementation(async (g) => g);
    const res = await POST(req({ invoiceId: INVOICE_ID }));
    expect(res.status).toBe(200);
    expect((await res.json()).thread).toEqual(['recovered']);
    expect(fetchReceipt).toHaveBeenCalledTimes(1);
    expect(generateThread).toHaveBeenCalledTimes(1);
  });

  it('reuses the stored preview_hook as tweet #1 when generating', async () => {
    m(invoices.getInvoice).mockResolvedValue(baseInvoice({ preview_hook: 'pinned hook' }));
    m(invoices.isExpired).mockReturnValue(false);
    m(fetchReceipt).mockResolvedValue(stxReceipt);
    m(invoices.claimInvoice).mockResolvedValue(true);
    m(generateThread).mockResolvedValue(['pinned hook', 'b']);
    m(invoices.saveGenerationAndConsume).mockImplementation(async (g) => g);
    await POST(req({ invoiceId: INVOICE_ID, txId: '0xtx' }));
    expect(generateThread).toHaveBeenCalledWith(
      'bitcoin layer 2', 'educational', 5, { firstTweet: 'pinned hook', language: 'auto', outline: null },
    );
  });

  it('passes the invoice language through to generateThread', async () => {
    m(invoices.getInvoice).mockResolvedValue(baseInvoice({
      params: { topic: 'bitcoin layer 2', tone: 'educational', length: 5, language: 'vi' },
      preview_hook: 'pinned hook',
    }));
    m(invoices.isExpired).mockReturnValue(false);
    m(fetchReceipt).mockResolvedValue(stxReceipt);
    m(invoices.claimInvoice).mockResolvedValue(true);
    m(generateThread).mockResolvedValue(['t1', 't2']);
    m(invoices.saveGenerationAndConsume).mockImplementation(async (g) => g);
    await POST(req({ invoiceId: INVOICE_ID, txId: '0xtx' }));
    expect(generateThread).toHaveBeenCalledWith(
      'bitcoin layer 2', 'educational', 5, { firstTweet: 'pinned hook', language: 'vi', outline: null },
    );
  });

  it('Branch 2 generates from invoice.params/service, ignoring client body', async () => {
    const seen: { params: unknown; ctx: unknown }[] = [];
    vi.spyOn(registry, 'getService').mockReturnValue({
      id: 'x-thread', label: '', blurb: '', chained: true, priceStx: 100000, priceSbtc: 100, fields: [],
      validate: () => ({ ok: true, params: {} }),
      generatePreview: async () => ({ hook: null, outline: null }),
      generate: async (params: unknown, ctx: unknown) => { seen.push({ params, ctx }); return ['t1', 't2']; },
      regenerateOne: async () => 't',
    } as never);

    m(invoices.getInvoice).mockResolvedValue(baseInvoice({ params: { topic: 'real' }, preview_hook: 'hook', preview_outline: ['o1', 'o2'] }));
    m(invoices.isExpired).mockReturnValue(false);
    m(fetchReceipt).mockResolvedValue(stxReceipt);
    m(invoices.claimInvoice).mockResolvedValue(true);
    m(invoices.getGeneration).mockResolvedValue(null);
    m(invoices.saveGenerationAndConsume).mockImplementation(async (g) => g);

    const res = await POST(req({ invoiceId: INVOICE_ID, txId: '0xabc', params: { topic: 'HACKED' } }));
    expect(res.status).toBe(200);
    expect(seen[0].params).toEqual({ topic: 'real' });   // from invoice, not 'HACKED'
    expect(seen[0].ctx).toEqual({ previewHook: 'hook', previewOutline: ['o1', 'o2'] });
  });

  it('LLM fails after claim -> releases invoice for free retry, returns 500', async () => {
    m(invoices.getInvoice).mockResolvedValue(baseInvoice());
    m(invoices.isExpired).mockReturnValue(false);
    m(fetchReceipt).mockResolvedValue(stxReceipt);
    m(invoices.claimInvoice).mockResolvedValue(true);
    m(generateThread).mockRejectedValue(new Error('anthropic down'));
    const res = await POST(req({ invoiceId: INVOICE_ID }));
    expect(res.status).toBe(500);
    expect(invoices.releaseInvoice).toHaveBeenCalledWith(INVOICE_ID);
    expect(invoices.saveGenerationAndConsume).not.toHaveBeenCalled();
  });
});
