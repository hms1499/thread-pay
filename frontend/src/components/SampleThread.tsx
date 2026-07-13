'use client';

import { Flex, Typography } from 'antd';
import { TweetCard } from './TweetCard';
import {
  SAMPLE_THREAD, SAMPLE_TOPIC, SAMPLE_TONE, SAMPLE_TOTAL,
} from '@/lib/sample-thread';

const { Text } = Typography;

// The cold-landing first impression. A stranger arriving from X should see the product's
// OUTPUT, not a form and an empty easel — a generator that never shows what it generates
// asks the visitor to imagine the value, and most will not bother.
//
// Rendered with the same TweetCard as a real result (read-only: no edit/delete/reroll
// handlers are passed), so what a visitor sees here is exactly what they get.
export function SampleThread() {
  return (
    <Flex vertical gap={14} style={{ padding: '24px 0 8px' }}>
      <Flex vertical align="center" gap={4}>
        <Text
          className="tp-display"
          style={{ color: 'var(--vg-gold)', fontStyle: 'italic', fontSize: 17 }}
        >
          From the collection
        </Text>
        <Text style={{ color: 'var(--vg-faint)', fontSize: 13, textAlign: 'center' }}>
          An example — “{SAMPLE_TOPIC}”, {SAMPLE_TONE}, {SAMPLE_TOTAL} tweets.
          <br />
          Yours hangs here once you generate it.
        </Text>
      </Flex>

      {SAMPLE_THREAD.map((text, i) => (
        <TweetCard key={i} text={text} index={i} total={SAMPLE_TOTAL} />
      ))}

      <Text
        style={{ color: 'var(--vg-faint)', fontSize: 12, textAlign: 'center', marginTop: 2 }}
      >
        …{SAMPLE_TOTAL - SAMPLE_THREAD.length} more tweets in the full thread.
      </Text>
    </Flex>
  );
}
