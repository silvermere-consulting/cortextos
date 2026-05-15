'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { HealthDot } from '@/components/shared/health-dot';
import { IconShieldHalfFilled } from '@tabler/icons-react';
import type { FleetAgentData, FleetHealthResponse, ContextStatus, HealthStatus } from '@/app/api/agents/fleet-health/route';

const CONTEXT_COLORS: Record<ContextStatus, { bar: string; text: string }> = {
  green:   { bar: 'bg-emerald-500', text: 'text-emerald-600 dark:text-emerald-400' },
  amber:   { bar: 'bg-amber-400',   text: 'text-amber-600 dark:text-amber-400' },
  red:     { bar: 'bg-red-500',     text: 'text-red-600 dark:text-red-400' },
  unknown: { bar: 'bg-muted',       text: 'text-muted-foreground' },
};

function QuotaBar({ label, value }: { label: string; value: number }) {
  const pct = Math.round(value * 100);
  const color = pct >= 85 ? 'bg-red-500' : pct >= 70 ? 'bg-amber-400' : 'bg-emerald-500';
  return (
    <div className="flex items-center gap-2 min-w-0">
      <span className="text-[10px] text-muted-foreground shrink-0">{label}</span>
      <div className="h-1 flex-1 rounded-full bg-muted overflow-hidden">
        <div className={`h-full rounded-full ${color}`} style={{ width: `${pct}%` }} />
      </div>
      <span className="text-[10px] font-mono text-muted-foreground shrink-0">{pct}%</span>
    </div>
  );
}

function AgentRow({ agent }: { agent: FleetAgentData }) {
  const ctx = CONTEXT_COLORS[agent.contextStatus];
  const barWidth = `${Math.min(agent.fillPct, 100)}%`;

  return (
    <Link
      href={`/agents?agent=${encodeURIComponent(agent.agent)}`}
      className="flex items-center gap-3 rounded-md px-2 py-1.5 hover:bg-muted/50 transition-colors group"
    >
      <HealthDot status={agent.health as HealthStatus} />
      <span className="text-sm font-medium w-28 truncate shrink-0">{agent.agent}</span>

      {/* Context fill bar */}
      <div className="flex-1 min-w-0">
        <div className="h-1.5 w-full rounded-full bg-muted overflow-hidden">
          <div
            className={`h-full rounded-full transition-all ${agent.contextStatus === 'unknown' ? 'bg-muted' : ctx.bar}`}
            style={{ width: barWidth }}
          />
        </div>
      </div>

      <span className={`text-xs font-mono w-10 text-right shrink-0 ${ctx.text}`}>
        {agent.fillPct > 0 ? `${agent.fillPct}%` : '—'}
      </span>

      {agent.etaTurns !== null && agent.etaTurns < 200 && (
        <span className="text-[10px] text-muted-foreground shrink-0 hidden group-hover:inline">
          ~{agent.etaTurns}t left
        </span>
      )}
    </Link>
  );
}

export function FleetHealth() {
  const [data, setData] = useState<FleetHealthResponse | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function fetchData() {
      try {
        const res = await fetch('/api/agents/fleet-health');
        if (!res.ok) return;
        const json = await res.json() as FleetHealthResponse;
        if (!cancelled) setData(json);
      } catch {
        // non-critical
      }
    }

    fetchData();
    const interval = setInterval(fetchData, 30_000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, []);

  const total = (data?.healthy ?? 0) + (data?.stale ?? 0) + (data?.down ?? 0);
  const unhealthy = (data?.stale ?? 0) + (data?.down ?? 0);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm font-medium uppercase tracking-wider text-muted-foreground flex items-center gap-2">
          <IconShieldHalfFilled size={16} />
          Fleet Health
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {/* Summary line */}
        <div className="text-sm font-medium px-2">
          {data === null ? (
            <span className="text-muted-foreground">Loading…</span>
          ) : total === 0 ? (
            <span className="text-muted-foreground">No agents detected</span>
          ) : unhealthy === 0 ? (
            <span className="text-emerald-600 dark:text-emerald-400">
              {total}/{total} agents healthy
            </span>
          ) : (
            <span className="text-destructive">
              {unhealthy} agent{unhealthy !== 1 ? 's' : ''} down or stale
            </span>
          )}
        </div>

        {/* Agent rows */}
        {data && data.agents.length > 0 && (
          <div className="space-y-0.5">
            <div className="flex items-center gap-3 px-2 pb-1">
              <div className="w-4 shrink-0" />
              <span className="text-[10px] text-muted-foreground w-28 shrink-0">Agent</span>
              <span className="text-[10px] text-muted-foreground flex-1">Context</span>
              <span className="text-[10px] text-muted-foreground w-10 text-right shrink-0">Fill</span>
            </div>
            {data.agents.map((agent) => (
              <AgentRow key={agent.agent} agent={agent} />
            ))}
          </div>
        )}

        {/* Quota footer */}
        <div className="border-t pt-2 space-y-1.5">
          {data?.usage ? (
            <>
              <QuotaBar label="5h quota" value={data.usage.five_hour_utilization} />
              <QuotaBar label="7d quota" value={data.usage.seven_day_utilization} />
            </>
          ) : (
            <p className="text-[10px] text-muted-foreground px-2">
              Quota unavailable — usage API pending
            </p>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
