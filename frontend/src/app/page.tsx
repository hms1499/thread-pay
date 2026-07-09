'use client';

import { useEffect, useRef, useState } from 'react';
import { Button, Checkbox, Typography, Flex, Statistic, App, Drawer, Segmented } from 'antd';
import { AnimatedCounter } from '@/components/AnimatedCounter';
import { WalletOutlined, CopyOutlined, CheckOutlined, HistoryOutlined, TwitterOutlined } from '@ant-design/icons';
import { ThreadForm, type FormValues } from '@/components/ThreadForm';
import type { PublicServiceDef } from '@/lib/services/types';
import { TweetCard } from '@/components/TweetCard';
import { PaymentStatus, type Phase } from '@/components/PaymentStatus';
import { PostThreadModal } from '@/components/PostThreadModal';
import { AppSplash } from '@/components/AppSplash';
import { VanGoghCanvas } from '@/components/VanGoghCanvas';
import { HistoryPanel } from '@/components/HistoryPanel';
import { EmptyGallery } from '@/components/EmptyGallery';
import { OutlinePreview } from '@/components/OutlinePreview';
import { ShareButton } from '@/components/ShareButton';
import { ThemeToggle } from '@/components/ThemeToggle';
import { connectWallet, disconnectWallet, getAddress, payInvoice, signInWithWallet, waitForTx } from '@/lib/stacks';
import { MAX_FREE_REGENS } from '@/lib/config';
import { applyEdit, deleteTweet } from '@/lib/editThread';
import { creditUrl, creditTweet } from '@/lib/postToX';

const { Title, Paragraph, Text } = Typography;

type Quote = {
  invoiceId: string; priceStx: number; priceSbtc: number; expiresAt: string; previewHook?: string | null; previewOutline?: string[] | null;
};

export default function Home() {
  const { message } = App.useApp();
  const [address, setAddress] = useState<string | null>(null);
  const [phase, setPhase] = useState<Phase>('idle');
  const [txid, setTxid] = useState<string>();
  const [error, setError] = useState<string>();
  const [thread, setThread] = useState<string[]>([]);
  const [pendingInvoiceId, setPendingInvoiceId] = useState<string>();
  const [stats, setStats] = useState<{ threads: number; stxRevenue: number; sbtcRevenue: number }>();
  const [services, setServices] = useState<PublicServiceDef[]>([]);
  const [servicesError, setServicesError] = useState(false);
  const [servicesSettled, setServicesSettled] = useState(false);
  // Whether the currently displayed thread came from a chained service (true) or a
  // pack of standalone posts (false) — drives i/n numbering in the post-to-X flow.
  const [threadChained, setThreadChained] = useState(true);
  const [previewHook, setPreviewHook] = useState<string | null>(null);
  const [previewOutline, setPreviewOutline] = useState<string[] | null>(null);
  const [previewPriceLabel, setPreviewPriceLabel] = useState<string>('');
  const [copiedAll, setCopiedAll] = useState(false);
  const [postOpen, setPostOpen] = useState(false);
  const [includeCredit, setIncludeCredit] = useState(true);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [displayedInvoiceId, setDisplayedInvoiceId] = useState<string>();
  const [regenRemaining, setRegenRemaining] = useState<number | null>(null);
  const [regenerating, setRegenerating] = useState(false);
  const [rerollingIndex, setRerollingIndex] = useState<number | null>(null);
  const [shareUrl, setShareUrl] = useState<string | null>(null);
  const [sharing, setSharing] = useState(false);
  const [unsharing, setUnsharing] = useState(false);
  const [variants, setVariants] = useState<{ tone: string; thread: string[] }[] | null>(null);
  const [selectedTone, setSelectedTone] = useState<string | null>(null);
  const [switchingTone, setSwitchingTone] = useState(false);
  const threadRef = useRef<HTMLDivElement>(null);

  function refreshStats() {
    fetch('/api/stats')
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => { if (d && typeof d.threads === 'number') setStats(d); })
      .catch(() => {});
  }

  function handleEditTweet(index: number, draft: string) {
    setThread((t) => applyEdit(t, index, draft));
  }

  function handleDeleteTweet(index: number) {
    setThread((t) => {
      const next = deleteTweet(t, index);
      // Deleting the last tweet returns the gallery to its empty/idle state.
      if (next.length === 0) setPhase('idle');
      return next;
    });
  }

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setAddress(getAddress());
    refreshStats();
    // Load the service marketplace. On failure, surface a retry notice rather than
    // crashing — the rest of the page still works.
    fetch('/api/services')
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`status ${r.status}`))))
      .then((d) => { if (Array.isArray(d?.services)) setServices(d.services); else throw new Error('bad payload'); })
      .catch(() => setServicesError(true))
      .finally(() => setServicesSettled(true));
  }, []);

  // When a fresh thread finishes, bring it into view so the result isn't
  // stranded below the fold. Respects reduced-motion.
  useEffect(() => {
    if (phase !== 'done' || thread.length === 0 || !threadRef.current) return;
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    threadRef.current.scrollIntoView({
      behavior: reduce ? 'auto' : 'smooth',
      block: 'start',
    });
  }, [phase, thread]);

  async function redeem(invoiceId: string, txId?: string) {
    try {
      setError(undefined);
      setPhase('generating');
      const genRes = await fetch('/api/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ invoiceId, txId }),
      });
      if (genRes.status === 402 || genRes.status === 202) {
        setPendingInvoiceId(invoiceId);
        setPhase('recover');
        setError(genRes.status === 402
          ? 'Payment not confirmed on-chain yet — wait a moment, then Check payment.'
          : 'AI is still writing your thread — Check payment again in a moment.');
        return;
      }
      if (!genRes.ok) {
        const e = await genRes.json().catch(() => ({}));
        throw new Error(e.error ?? `Error ${genRes.status}`);
      }
      const data = await genRes.json();
      setThread(data.thread);
      setVariants(Array.isArray(data.variants) ? data.variants : null);
      setSelectedTone(typeof data.selectedTone === 'string' ? data.selectedTone : null);
      setDisplayedInvoiceId(invoiceId);
      setRegenRemaining(MAX_FREE_REGENS);
      setPreviewHook(null);
      setPendingInvoiceId(undefined);
      setPhase('done');
      refreshStats();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Unknown error');
      setPhase('error');
    }
  }

  // Authenticated calls to the ownership-gated endpoints (re-roll, share, unshare).
  // Try the session cookie first so repeat actions don't re-prompt. If the cookie is
  // missing/expired (401) OR bound to a different address than the on-chain payer
  // (403 — e.g. a stale session from another wallet account), prove the *connected*
  // wallet with a fresh signature and retry once. A fresh signature outranks any
  // cookie server-side, so this self-heals a wrong-account session and re-mints the
  // cookie to the correct address. If it still 403s, the connected wallet genuinely
  // isn't the payer — the caller surfaces that.
  async function authedFetch(path: string, method: 'POST' | 'DELETE', payload: object) {
    const call = (auth: object) => fetch(path, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...payload, ...auth }),
    });
    let res = await call({});
    if (res.status === 401 || res.status === 403) {
      const addr = getAddress() ?? address;
      if (!addr) throw new Error('Connect your wallet first.');
      res = await call(await signInWithWallet(addr));
    }
    return res;
  }

  async function regenerate() {
    if (!displayedInvoiceId) return;
    setRegenerating(true);
    setError(undefined);
    try {
      const res = await authedFetch('/api/regenerate', 'POST', { invoiceId: displayedInvoiceId });
      if (res.status === 403) throw new Error('This thread was paid by a different wallet. Switch to the paying account and try again.');
      if (res.status === 202) {
        message.info('A re-roll is already in progress — try again in a moment.');
        return;
      }
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? `Error ${res.status}`);
      setThread(data.thread);
      setVariants(null);
      setSelectedTone(null);
      setRegenRemaining(data.regenRemaining);
    } catch (e) {
      message.error(e instanceof Error ? e.message : 'Re-roll failed');
    } finally {
      setRegenerating(false);
    }
  }

  async function selectTone(tone: string) {
    if (!displayedInvoiceId || tone === selectedTone || switchingTone) return;
    // Optimistic: show the chosen variant immediately, then persist the winner.
    const previousThread = thread;
    const previousSelectedTone = selectedTone;
    const local = variants?.find((v) => v.tone === tone);
    if (local) { setThread(local.thread); setSelectedTone(tone); }
    setSwitchingTone(true);
    try {
      const res = await authedFetch('/api/select-tone', 'POST', { invoiceId: displayedInvoiceId, tone });
      if (res.status === 403) throw new Error('This thread was paid by a different wallet. Switch to the paying account and try again.');
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? `Error ${res.status}`);
      setThread(data.thread);
      setSelectedTone(data.selectedTone);
    } catch (e) {
      message.error(e instanceof Error ? e.message : 'Could not switch tone');
      setThread(previousThread);
      setSelectedTone(previousSelectedTone);
    } finally {
      setSwitchingTone(false);
    }
  }

  async function shareThread() {
    if (!displayedInvoiceId) return;
    setSharing(true);
    try {
      const res = await authedFetch('/api/share', 'POST', { invoiceId: displayedInvoiceId });
      if (res.status === 403) throw new Error('This thread was paid by a different wallet. Switch to the paying account and try again.');
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? `Error ${res.status}`);
      setShareUrl(`${window.location.origin}/t/${data.slug}`);
    } catch (e) {
      message.error(e instanceof Error ? e.message : 'Share failed');
    } finally {
      setSharing(false);
    }
  }

  async function unshareThread() {
    if (!displayedInvoiceId) return;
    setUnsharing(true);
    try {
      const res = await authedFetch('/api/share', 'DELETE', { invoiceId: displayedInvoiceId });
      if (res.status === 403) throw new Error('This thread was paid by a different wallet. Switch to the paying account and try again.');
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? `Error ${res.status}`);
      setShareUrl(null);
      message.success('Unshared');
    } catch (e) {
      message.error(e instanceof Error ? e.message : 'Unshare failed');
    } finally {
      setUnsharing(false);
    }
  }

  // Re-roll a single tweet, keeping the rest. Sends the current thread as the base
  // so inline edits to other tweets survive; shares the free re-roll budget.
  async function rerollTweet(index: number) {
    if (!displayedInvoiceId || regenRemaining === 0) return;
    setRerollingIndex(index);
    setError(undefined);
    try {
      const res = await authedFetch('/api/regenerate', 'POST', { invoiceId: displayedInvoiceId, tweetIndex: index, thread });
      if (res.status === 403) throw new Error('This thread was paid by a different wallet. Switch to the paying account and try again.');
      if (res.status === 202) {
        message.info('A re-roll is already in progress — try again in a moment.');
        return;
      }
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? `Error ${res.status}`);
      setThread(data.thread);
      setVariants(null);
      setSelectedTone(null);
      setRegenRemaining(data.regenRemaining);
    } catch (e) {
      message.error(e instanceof Error ? e.message : 'Re-roll failed');
    } finally {
      setRerollingIndex(null);
    }
  }

  async function handleGenerate(values: FormValues) {
    setError(undefined); setThread([]); setTxid(undefined); setPendingInvoiceId(undefined); setPreviewHook(null); setPreviewOutline(null); setPreviewPriceLabel(''); setDisplayedInvoiceId(undefined); setRegenRemaining(null); setShareUrl(null); setVariants(null); setSelectedTone(null);
    // Pin the chained-ness of the service we're generating with, so post-to-X
    // numbering matches the result once it lands.
    setThreadChained(services.find((s) => s.id === values.service)?.chained ?? true);
    try {
      if (!getAddress()) {
        const addr = await connectWallet();
        setAddress(addr);
      }
      setPhase('quoting');
      const quoteRes = await fetch('/api/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ service: values.service, params: values.params }),
      });
      if (quoteRes.status !== 402) {
        const e = await quoteRes.json().catch(() => ({}));
        throw new Error(e.error ?? `Could not get a quote (${quoteRes.status})`);
      }
      const quote: Quote = await quoteRes.json();
      setPreviewHook(quote.previewHook ?? null);
      setPreviewOutline(quote.previewOutline ?? null);
      setPreviewPriceLabel(values.token === 'STX'
        ? `${quote.priceStx / 1_000_000} STX`
        : `${quote.priceSbtc} sats`);

      setPhase('awaiting-signature');
      const amount = values.token === 'STX' ? quote.priceStx : quote.priceSbtc;
      const tx = await payInvoice({ token: values.token, invoiceId: quote.invoiceId, amount });
      setTxid(tx);

      setPhase('confirming');
      const status = await waitForTx(tx);
      if (status === 'failed') {
        throw new Error('Transaction reverted on-chain — invoice still valid, you can retry');
      }
      if (status === 'pending') {
        setPendingInvoiceId(quote.invoiceId);
        setPhase('recover');
        setError('Confirmation is taking longer than usual. Your invoice is saved — click Check payment once the tx confirms.');
        return;
      }
      await redeem(quote.invoiceId, tx);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Unknown error');
      setPhase('error');
    }
  }

  const busy = !['idle', 'done', 'error', 'recover'].includes(phase);
  const editable = phase === 'done' && !regenerating;
  const credit = includeCredit ? creditTweet(shareUrl || creditUrl()) : null;

  async function toggleWallet() {
    if (address) {
      disconnectWallet();
      setAddress(null);
      return;
    }
    setAddress(await connectWallet());
  }

  return (
    <main className="tp-shell" style={{ maxWidth: 640, margin: '0 auto', padding: '48px 20px 80px' }}>

      {/* ── Van Gogh loading overlays ── */}
      <AppSplash servicesSettled={servicesSettled} />
      {phase === 'generating' && <VanGoghCanvas label="Painting your thread…" tx={txid} />}

      {/* ── Hero: the real Starry Night painting ── */}
      <div className="vg-hero tp-rise">
        <Flex gap={8} style={{ position: 'absolute', top: 16, right: 16, zIndex: 2 }}>
          <ThemeToggle />
          {address && (
            <Button
              className="vg-wallet-btn"
              icon={<HistoryOutlined />}
              onClick={() => setHistoryOpen(true)}
              style={{
                background: 'var(--vg-glass)',
                borderColor: 'var(--vg-glass-border)',
                color: 'var(--vg-on-art)',
                backdropFilter: 'blur(8px)',
              }}
            >
              History
            </Button>
          )}
          <Button
            className={`vg-wallet-btn ${address ? 'tp-mono' : ''}`}
            icon={<WalletOutlined />}
            onClick={toggleWallet}
            style={{
              background: 'var(--vg-glass)',
              borderColor: 'var(--vg-glass-border)',
              color: address ? 'var(--vg-on-art-soft)' : 'var(--vg-on-art)',
              backdropFilter: 'blur(8px)',
            }}
          >
            {address ? `${address.slice(0, 6)}…${address.slice(-4)}` : 'Connect wallet'}
          </Button>
        </Flex>

        <div className="vg-hero__content">
          <Flex align="center" gap={10}>
            <span className="vg-star-glow" style={{ fontSize: 26, lineHeight: 1 }}>✦</span>
            <Title
              level={1}
              className="tp-display"
              style={{ margin: 0, fontWeight: 700, fontStyle: 'italic', color: 'var(--vg-on-art)', fontSize: 38 }}
            >
              ThreadGogh
            </Title>
          </Flex>
          <Paragraph
            style={{ margin: '8px 0 0', fontSize: 15, color: 'var(--vg-on-art-soft)', maxWidth: 440 }}
          >
            AI writes X threads — pay per generate with STX or sBTC on Stacks.{' '}
            <span style={{ color: 'var(--vg-on-art-faint)' }}>No account, no subscription.</span>
          </Paragraph>
        </div>
      </div>

      <div style={{ marginBottom: 28 }} />

      {/* ── Form ── */}
      <div className="tp-rise" style={{ animationDelay: '0.08s' }}>
        <ThreadForm services={services} servicesError={servicesError} onSubmit={handleGenerate} disabled={busy} />
      </div>

      {/* ── Free preview: hook + locked outline ── */}
      {previewHook && thread.length === 0 && (
        <OutlinePreview hook={previewHook} outline={previewOutline} priceLabel={previewPriceLabel} />
      )}

      {/* ── Payment status ── */}
      <div style={{ marginTop: 20 }}>
        <PaymentStatus phase={phase} txid={txid} error={error} />
        {phase === 'recover' && pendingInvoiceId && (
          <Button
            type="primary"
            block
            className="vg-glow-btn"
            style={{ marginTop: 12 }}
            onClick={() => redeem(pendingInvoiceId, txid)}
          >
            Check payment
          </Button>
        )}
      </div>

      {/* ── Generated thread ── */}
      {thread.length > 0 && (
        <Flex ref={threadRef} vertical gap={12} style={{ marginTop: 32, scrollMarginTop: 24 }}>
          <Flex justify="space-between" align="center" wrap gap={8} className="tp-rise">
            <Title
              level={4}
              className="tp-display"
              style={{ margin: 0, color: 'var(--vg-star)', fontStyle: 'italic', whiteSpace: 'nowrap', flex: '0 0 auto' }}
            >
              Your thread
            </Title>
            <Flex gap={8} align="center" wrap justify="flex-end" style={{ flex: '1 1 auto', minWidth: 0 }}>
              <Checkbox
                checked={includeCredit}
                onChange={(e) => setIncludeCredit(e.target.checked)}
                style={{ color: 'var(--vg-muted)' }}
              >
                Add ThreadGogh link
              </Checkbox>
              <Button
                type="text"
                size="small"
                icon={<TwitterOutlined />}
                onClick={() => setPostOpen(true)}
                style={{ color: 'var(--vg-star)' }}
              >
                Post to X
              </Button>
              {regenRemaining != null && (
                <Button
                  type="text"
                  size="small"
                  loading={regenerating}
                  disabled={regenRemaining === 0 || regenerating}
                  onClick={regenerate}
                  style={{ color: regenRemaining === 0 ? 'var(--vg-faint)' : 'var(--vg-muted)' }}
                >
                  {regenRemaining === 0 ? 'No free re-rolls left' : `Regenerate (${regenRemaining} free)`}
                </Button>
              )}
              <Button
                type="text"
                size="small"
                icon={copiedAll ? <CheckOutlined /> : <CopyOutlined />}
                style={{ color: copiedAll ? 'var(--vg-success)' : 'var(--vg-muted)' }}
                onClick={() => {
                  navigator.clipboard.writeText(credit ? `${thread.join('\n\n')}\n\n${credit}` : thread.join('\n\n'));
                  message.success('Whole thread copied');
                  setCopiedAll(true);
                  setTimeout(() => setCopiedAll(false), 1400);
                }}
              >
                {copiedAll ? 'Copied' : 'Copy all'}
              </Button>
              <ShareButton
                shared={!!shareUrl}
                sharing={sharing}
                shareUrl={shareUrl}
                onShare={shareThread}
                onCopy={() => { if (shareUrl) navigator.clipboard.writeText(shareUrl); }}
                unsharing={unsharing}
                onUnshare={unshareThread}
              />
            </Flex>
          </Flex>
          {variants && variants.length > 1 && (
            <Segmented
              block
              value={selectedTone ?? variants[0].tone}
              onChange={(v) => selectTone(String(v))}
              options={variants.map((x) => ({ label: x.tone, value: x.tone }))}
              disabled={switchingTone}
              style={{ marginBottom: 4 }}
            />
          )}
          {thread.map((t, i) => (
              <TweetCard
                key={i}
                text={t}
                index={i}
                total={thread.length}
                onEdit={editable ? handleEditTweet : undefined}
                onDelete={editable ? handleDeleteTweet : undefined}
                onReroll={editable && displayedInvoiceId && regenRemaining != null && regenRemaining !== 0 ? rerollTweet : undefined}
                rerolling={rerollingIndex === i}
              />
            ))}
        </Flex>
      )}

      {/* ── Empty state — before the first generation ── */}
      {thread.length === 0 && phase === 'idle' && <EmptyGallery />}

      {/* ── Post the whole thread to X, one tweet at a time ── */}
      <PostThreadModal thread={thread} chained={threadChained} credit={credit} open={postOpen} onClose={() => setPostOpen(false)} />

      {/* ── History — opened from the hero, not inline ── */}
      <Drawer
        title="Your threads"
        placement="right"
        open={historyOpen}
        onClose={() => setHistoryOpen(false)}
        styles={{ title: { fontSize: 15 } }}
        classNames={{
          section: 'vg-drawer__section',
          header: 'vg-drawer__header',
          title: 'vg-plate',
          body: 'vg-drawer__body',
          close: 'vg-drawer__close',
          mask: 'vg-drawer__mask',
        }}
      >
        <HistoryPanel
          address={address}
          onSelect={(t, invoiceId) => { setThread(t); setPhase('done'); setDisplayedInvoiceId(invoiceId); setRegenRemaining(null); setThreadChained(true); setHistoryOpen(false); setShareUrl(null); setVariants(null); setSelectedTone(null); }}
        />
      </Drawer>

      {/* ── Stats — gallery placard with Sunflowers ── */}
      {stats && (
        <div className="vg-gallery tp-rise" style={{ marginTop: 48 }}>
          <Text className="vg-plate" style={{ display: 'block', marginBottom: 16 }}>
            The ThreadGogh Collection
          </Text>
          <Flex gap={32} wrap>
            <Statistic
              title={<span style={{ color: 'var(--vg-on-art-faint)', fontSize: 12, textTransform: 'uppercase', letterSpacing: '0.08em' }}>Threads sold</span>}
              value={stats.threads}
              formatter={(val) => <AnimatedCounter value={Number(val)} format={(n) => String(Math.round(n))} />}
              styles={{ content: { fontFamily: 'var(--font-display)', color: 'var(--vg-star)' } }}
            />
            <Statistic
              title={<span style={{ color: 'var(--vg-on-art-faint)', fontSize: 12, textTransform: 'uppercase', letterSpacing: '0.08em' }}>STX revenue</span>}
              value={stats.stxRevenue / 1_000_000}
              suffix="STX"
              formatter={(val) => <AnimatedCounter value={Number(val)} format={(n) => n.toFixed(2)} />}
              styles={{ content: { fontFamily: 'var(--font-display)', color: 'var(--vg-on-art)' } }}
            />
            <Statistic
              title={<span style={{ color: 'var(--vg-on-art-faint)', fontSize: 12, textTransform: 'uppercase', letterSpacing: '0.08em' }}>sBTC revenue</span>}
              value={stats.sbtcRevenue}
              suffix="sats"
              formatter={(val) => <AnimatedCounter value={Number(val)} format={(n) => Math.round(n).toLocaleString()} />}
              styles={{ content: { fontFamily: 'var(--font-display)', color: 'var(--vg-on-art)' } }}
            />
          </Flex>
        </div>
      )}
    </main>
  );
}
