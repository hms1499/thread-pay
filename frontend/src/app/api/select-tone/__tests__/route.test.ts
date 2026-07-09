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
