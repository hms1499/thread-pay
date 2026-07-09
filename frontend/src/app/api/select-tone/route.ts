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
