import { getTodayDigest } from '@/lib/data/today';
import { TodayPageClient } from './client';

export const dynamic = 'force-dynamic';

export default async function TodayPage({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const params = await searchParams;
  const rangeParam = typeof params.range === 'string' ? params.range : 'today';
  const kind: 'today' | 'yesterday' | 'this-week' | 'custom' =
    rangeParam === 'yesterday' || rangeParam === 'this-week' || rangeParam === 'custom'
      ? rangeParam
      : 'today';
  const org = typeof params.org === 'string' ? params.org : 'silvermere-tech';
  const customFrom = typeof params.from === 'string' ? params.from : undefined;
  const customTo = typeof params.to === 'string' ? params.to : undefined;

  const digest = getTodayDigest({ kind, org, customFrom, customTo });

  return <TodayPageClient digest={digest} currentOrg={org} currentRange={kind} />;
}
