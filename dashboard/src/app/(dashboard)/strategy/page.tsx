'use client';

import { useEffect, useState, useCallback } from 'react';
import { useOrg } from '@/hooks/use-org';
import { fetchGoals, fetchGoalHistory } from '@/lib/actions/goals';
import { BottleneckSection } from '@/components/strategy/bottleneck-section';
import { GoalsList } from '@/components/strategy/goals-list';
import { GoalHistory } from '@/components/strategy/goal-history';
import type { Goal } from '@/lib/types';

export default function StrategyPage() {
  const { currentOrg, orgs } = useOrg();
  const [bottleneck, setBottleneck] = useState('');
  const [goals, setGoals] = useState<Goal[]>([]);
  const [history, setHistory] = useState<Array<{ timestamp: string; change: string }>>([]);
  const [loading, setLoading] = useState(true);
  const [dailyFocus, setDailyFocus] = useState<string | undefined>(undefined);
  const [dailyFocusSetAt, setDailyFocusSetAt] = useState<string | undefined>(undefined);

  // Goals and bottlenecks are per-org and this page WRITES them (GoalsList,
  // BottleneckSection). "all" is not a writable target, so never collapse it to
  // orgs[0] — that silently misfiled Steve's goals onto the first org. Resolve
  // "all" to no target and prompt for a specific org instead.
  const effectiveOrg = currentOrg === 'all' ? '' : currentOrg;

  const loadData = useCallback(async () => {
    if (!effectiveOrg) {
      setBottleneck('');
      setGoals([]);
      setHistory([]);
      setLoading(false);
      return;
    }

    const [goalsData, historyData] = await Promise.all([
      fetchGoals(effectiveOrg),
      fetchGoalHistory(effectiveOrg),
    ]);

    setBottleneck(goalsData.bottleneck);
    setGoals(goalsData.goals);
    setDailyFocus(goalsData.daily_focus);
    setDailyFocusSetAt(goalsData.daily_focus_set_at);
    setHistory(historyData);
    setLoading(false);
  }, [effectiveOrg]);

  useEffect(() => {
    setLoading(true);
    loadData();
  }, [loadData]);

  if (!effectiveOrg) {
    const message =
      currentOrg === 'all' && orgs.length > 0
        ? 'Select a specific organization from the org switcher to view and edit its strategy. Goals and bottlenecks are set per-org.'
        : 'No organizations found. Create an org to get started.';
    return (
      <div className="space-y-6">
        <h1 className="text-2xl font-semibold">Strategy</h1>
        <p className="text-muted-foreground">{message}</p>
      </div>
    );
  }

  if (loading) {
    return (
      <div className="space-y-6">
        <h1 className="text-2xl font-semibold">Strategy</h1>
        <div className="space-y-4">
          <div className="h-40 rounded-xl bg-muted/30 animate-pulse" />
          <div className="h-24 rounded-lg bg-muted/30 animate-pulse" />
          <div className="h-24 rounded-lg bg-muted/30 animate-pulse" />
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-8 max-w-3xl">
      <h1 className="text-2xl font-semibold">Strategy</h1>

      {dailyFocus && (
        <div className="rounded-xl border border-primary/30 bg-primary/5 px-5 py-4">
          <div className="flex items-start justify-between gap-4">
            <div>
              <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground mb-1">Today&apos;s Focus</p>
              <p className="text-base font-medium">{dailyFocus}</p>
            </div>
            {dailyFocusSetAt && (
              <p className="text-xs text-muted-foreground shrink-0 mt-1">
                {new Date(dailyFocusSetAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
              </p>
            )}
          </div>
        </div>
      )}

      <BottleneckSection
        bottleneck={bottleneck}
        org={effectiveOrg}
        history={history.filter(
          (h) =>
            h.change.toLowerCase().includes('bottleneck'),
        )}
      />

      <GoalsList
        goals={goals}
        org={effectiveOrg}
        onRefresh={loadData}
      />

      <GoalHistory events={history} />
    </div>
  );
}
