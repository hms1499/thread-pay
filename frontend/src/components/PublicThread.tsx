'use client';

import { Flex, Typography } from 'antd';
import { TweetCard } from '@/components/TweetCard';
import { PublicThreadActions } from '@/components/PublicThreadActions';

const { Title, Text, Paragraph } = Typography;

// Presentational client island for the public /t/[slug] page. antd's compound
// Typography sub-components (Title/Text/Paragraph) resolve to `undefined` when
// destructured inside a Server Component (they don't survive the RSC client-
// reference boundary), so all antd rendering lives here. The page stays a Server
// Component for the data fetch + notFound() and passes plain props down.
export function PublicThread({ label, topic, tweets, token, txUrl, chained, slug }: {
  label: string;
  topic: string | null;
  tweets: string[];
  token: string;
  txUrl: string;
  chained: boolean;
  slug: string;
}) {
  return (
    <Flex vertical gap={16} style={{ maxWidth: 640, margin: '0 auto', padding: 24 }}>
      <Flex justify="space-between" align="center" wrap gap={12}>
        <div>
          <Text type="secondary">{label}</Text>
          {topic && <Title level={3} style={{ margin: 0 }}>{topic}</Title>}
        </div>
        <PublicThreadActions thread={tweets} chained={chained} slug={slug} />
      </Flex>

      <Paragraph type="secondary" style={{ margin: 0 }}>
        Paid with {token} on Stacks ·{' '}
        <a href={txUrl} target="_blank" rel="noopener noreferrer">view tx</a>
      </Paragraph>

      <Flex vertical gap={12}>
        {tweets.map((t, i) => (
          <TweetCard key={i} text={t} index={i} total={tweets.length} />
        ))}
      </Flex>

      <Flex justify="center" style={{ marginTop: 24 }}>
        <a href={`/?ref=tg&src=${encodeURIComponent(slug)}`}><Title level={4} style={{ margin: 0 }}>✍️ Create your own thread →</Title></a>
      </Flex>
    </Flex>
  );
}
