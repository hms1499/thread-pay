'use client';

import { useEffect, useMemo, useState } from 'react';
import { Segmented, Button, Flex, Typography } from 'antd';
import { ThunderboltFilled } from '@ant-design/icons';
import type { PublicServiceDef } from '@/lib/services/types';
import { ServicePicker } from './ServicePicker';
import { ServiceForm } from './ServiceForm';
import { defaultParams, clientValidate } from '@/lib/services/form';
import { quotePrice } from '@/lib/price';
import { MULTI_TONE_MULTIPLIER } from '@/lib/config';

const { Text } = Typography;

function FieldLabel({ children }: { children: React.ReactNode }) {
  return (
    <span style={{
      fontSize: 11,
      textTransform: 'uppercase',
      letterSpacing: '0.1em',
      color: 'var(--vg-faint)',
      fontFamily: 'var(--font-mono)',
    }}>
      {children}
    </span>
  );
}

export type FormValues = { service: string; params: Record<string, unknown>; token: 'STX' | 'SBTC'; multiTone: boolean };

// The generate card is driven by the service registry: pick a service, fill its
// dynamic fields, choose a token, submit. Falls back gracefully if the registry
// hasn't loaded — the marketplace is an enhancement, never a hard dependency.
export function ThreadForm({ services, servicesError, onSubmit, disabled }: {
  services: PublicServiceDef[];
  servicesError?: boolean;
  onSubmit: (v: FormValues) => void;
  disabled: boolean;
}) {
  const [selectedId, setSelectedId] = useState('x-thread');
  const [params, setParams] = useState<Record<string, unknown>>({});
  const [token, setToken] = useState<'STX' | 'SBTC'>('STX');
  const [multiTone, setMultiTone] = useState(false);

  const selected = useMemo(
    () => services.find((s) => s.id === selectedId) ?? services[0],
    [services, selectedId],
  );

  // Seed each field to its default whenever the selected service changes (and once
  // the registry first loads). Keyed on the id so switching services resets cleanly.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (selected) { setParams(defaultParams(selected.fields)); setMultiTone(false); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected?.id]);

  const shell = { borderRadius: 14, padding: '22px 20px' } as const;

  if (servicesError) {
    return (
      <div className="vg-card" style={shell}>
        <Text type="secondary">Services unavailable — refresh to retry.</Text>
      </div>
    );
  }
  if (!selected) {
    return (
      <div className="vg-card" style={shell}>
        <Text type="secondary">Loading services…</Text>
      </div>
    );
  }

  const hasTone = selected.fields.some((f) => f.name === 'tone');
  const invalid = clientValidate(selected.fields, params) !== null;
  // Quoted with the same multiplier the server prices the invoice with, so the button
  // cannot promise a price the invoice will not honour.
  const price = quotePrice(selected, token, multiTone);

  function submit() {
    if (clientValidate(selected.fields, params)) return;
    const params2 = multiTone ? { ...params, multiTone: true } : params;
    onSubmit({ service: selected.id, params: params2, token, multiTone });
  }

  return (
    <div className="vg-card" style={shell}>
      <Flex vertical gap={20}>
        {services.length > 1 && (
          <ServicePicker
            services={services}
            selectedId={selected.id}
            onSelect={setSelectedId}
            disabled={disabled}
          />
        )}

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
                {
                  label: `Compare all ${MULTI_TONE_MULTIPLIER} (×${MULTI_TONE_MULTIPLIER} price)`,
                  value: 'all',
                },
              ]}
            />
          </Flex>
        )}

        <Flex vertical gap={8}>
          <FieldLabel>Pay with</FieldLabel>
          <Segmented
            block
            value={token}
            onChange={(v) => setToken(v as 'STX' | 'SBTC')}
            options={[
              { label: '⚡ STX',  value: 'STX' },
              { label: '₿ sBTC', value: 'SBTC' },
            ]}
          />
        </Flex>

        <Button
          type="primary"
          size="large"
          block
          disabled={disabled || invalid}
          loading={disabled}
          onClick={submit}
          icon={<ThunderboltFilled />}
          className="vg-glow-btn"
          style={{ marginTop: 4, height: 48, fontSize: 15, fontWeight: 600 }}
        >
          Generate {selected.label} · {price.label}
        </Button>

        {/* A visitor should never have to commit to find out what it costs. The free
            preview is the reason to click, so it is stated next to the price, not
            discovered later. */}
        <Text
          style={{ textAlign: 'center', fontSize: 12, color: 'var(--vg-ink-faint)' }}
        >
          Free preview first — you only pay if you like it.
        </Text>
      </Flex>
    </div>
  );
}
