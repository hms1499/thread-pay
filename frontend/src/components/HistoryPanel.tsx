'use client';

import { useState } from 'react';
import { Typography, Tag, Flex, Button, App } from 'antd';
import { SafetyOutlined } from '@ant-design/icons';
import { signInWithWallet } from '@/lib/stacks';

const { Text } = Typography;

type Cursor = { createdAt: string; id: number };

type Item = {
  invoice_id: string;
  service_id: string;
  token: string;
  amount: number;
  thread_content: string[];
  created_at: string;
  topic: string | null;
  selected_tone: string | null;
};

// Legacy rows (and anything unrecognized) read as the original X-thread service.
const SERVICE_LABELS: Record<string, string> = {
  'x-thread': 'X Thread',
  'repurpose-thread': 'Repurpose',
  'hot-takes': 'Hot-takes',
};
const serviceLabel = (id: string) => SERVICE_LABELS[id] ?? 'X Thread';

export function HistoryPanel({ address, onSelect }: {
  address: string | null;
  onSelect: (thread: string[], invoiceId: string) => void;
}) {
  const { message: msg } = App.useApp();
  const [items, setItems] = useState<Item[] | null>(null); // null = not signed in yet
  const [cursor, setCursor] = useState<Cursor | null>(null); // next page, null = no more
  const [loading, setLoading] = useState(false);

  if (!address) return null;

  // History is gated behind a wallet signature proving the caller owns the address —
  // a free, no-fee sign-in. The first page signs and the server returns a session
  // cookie; later pages (and remounts within the cookie's lifetime) send only the
  // cursor and ride that cookie, so the wallet is never prompted again.
  async function loadPage(next: Cursor | null) {
    if (!address) return;
    const firstLoad = next === null;
    setLoading(true);
    try {
      let signIn = {};
      if (firstLoad) {
        signIn = await signInWithWallet(address);
      }
      const res = await fetch('/api/history', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...signIn, cursor: next }),
      });
      if (res.status === 401) {
        // Session lapsed mid-paging — drop back to the sign-in button.
        setItems(null);
        setCursor(null);
        throw new Error('Your session expired. Please sign in again.');
      }
      if (!res.ok) {
        const e = await res.json().catch(() => ({}));
        throw new Error(e.error ?? `Error ${res.status}`);
      }
      const d = await res.json();
      setItems((prev) => (next && prev ? [...prev, ...(d.items ?? [])] : (d.items ?? [])));
      setCursor(d.nextCursor ?? null);
    } catch (e) {
      msg.error(e instanceof Error ? e.message : 'Could not load history');
    } finally {
      setLoading(false);
    }
  }

  return (
    <Flex vertical gap={10}>
      {items === null ? (
        <Button
          icon={<SafetyOutlined />}
          loading={loading}
          onClick={() => loadPage(null)}
          style={{ alignSelf: 'flex-start' }}
        >
          Sign in to view your history
        </Button>
      ) : items.length === 0 ? (
        <Text type="secondary" style={{ fontSize: 13 }}>No threads yet for this wallet.</Text>
      ) : (
        <Flex vertical gap={2}>
          {items.map((it) => (
            <div
              key={it.invoice_id}
              className="vg-history-item"
              role="button"
              tabIndex={0}
              onClick={() => onSelect(it.thread_content, it.invoice_id)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  onSelect(it.thread_content, it.invoice_id);
                }
              }}
              style={{ cursor: 'pointer', padding: '10px 8px' }}
            >
              <Text style={{ display: 'block' }}>
                {it.topic ?? '(unknown topic)'}
                {it.selected_tone && (
                  <Tag color="purple" style={{ marginLeft: 6 }}>3 tones</Tag>
                )}
              </Text>
              <Flex gap={8} align="center" style={{ marginTop: 4 }}>
                <Tag variant="filled" color="blue">
                  {serviceLabel(it.service_id)}
                </Tag>
                <Tag className="tp-mono" variant="filled" color={it.token === 'SBTC' ? 'gold' : 'default'}>
                  {it.token}
                </Tag>
                <Text type="secondary" style={{ fontSize: 12 }}>
                  {new Date(it.created_at).toLocaleString()}
                </Text>
              </Flex>
            </div>
          ))}

          {cursor !== null && (
            <Button
              type="text"
              size="small"
              loading={loading}
              onClick={() => loadPage(cursor)}
              style={{ alignSelf: 'flex-start', marginTop: 6 }}
            >
              Load more
            </Button>
          )}
        </Flex>
      )}
    </Flex>
  );
}
