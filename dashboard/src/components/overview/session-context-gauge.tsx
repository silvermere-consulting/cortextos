'use client';

import { useEffect, useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { IconBrain } from '@tabler/icons-react';
import type { AgentContextMetrics, ContextStatus } from '@/app/api/agents/session-context/route';

const STATUS_COLORS: Record<ContextStatus, { bar: string; label: string; text: string }> = {
  green: { bar: 'bg-emerald-500', label: 'Healthy', text: 'text-emerald-600 dark:text-emerald-400' },
  amber: { bar: 'bg-amber-400',   label: 'Filling',  text: 'text-amber-600 dark:text-amber-400' },
  red:   { bar: 'bg-red-500',     label: 'Critical', text: 'text-red-600 dark:text-red-400' },
};

function ContextBar({ agent }: { agent: AgentContextMetrics }) {
  const colors = STATUS_COLORS[agent.status];
  const barWidth = `${Math.min(agent.fillPct, 100)}%`;

  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between text-xs">
        <span className="font-medium truncate max-w-[120px]">{agent.agent}</span>
        <span className={`font-mono ${colors.text}`}>
          {agent.fillPct}%
        </span>
      </div>
      <div className="h-1.5 w-full rounded-full bg-muted overflow-hidden">
        <div
          className={`h-full rounded-full transition-all ${colors.bar}`}
          style={{ width: barWidth }}
        />
      </div>
      <div className="flex items-center justify-between text-[10px] text-muted-foreground">
        <span className={colors.text}>{colors.label}</span>
        <span>
          {agent.etaTurns !== null
            ? `~${agent.etaTurns} turns left`
            : agent.burnRatePerTurn === 0
            ? 'idle'
            : 'no projection'}
        </span>
      </div>
    </div>
  );
}

export function SessionContextGauge() {
  const [agents, setAgents] = useState<AgentContextMetrics[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;

    async function fetchData() {
      try {
        const res = await fetch('/api/agents/session-context');
        if (!res.ok) return;
        const data = await res.json();
        if (!cancelled) setAgents(data.agents ?? []);
      } catch {
        // silent — widget is non-critical
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    fetchData();
    const interval = setInterval(fetchData, 30_000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, []);

  const redCount = agents.filter((a) => a.status === 'red').length;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm font-medium uppercase tracking-wider text-muted-foreground flex items-center gap-2">
          <IconBrain size={15} />
          Session Context
          {redCount > 0 && (
            <span className="ml-auto text-xs font-normal text-red-500 normal-case">
              {redCount} critical
            </span>
          )}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {loading ? (
          <p className="text-xs text-muted-foreground">Loading…</p>
        ) : agents.length === 0 ? (
          <p className="text-xs text-muted-foreground">No active sessions found</p>
        ) : (
          agents.map((agent) => <ContextBar key={agent.agent} agent={agent} />)
        )}
      </CardContent>
    </Card>
  );
}
