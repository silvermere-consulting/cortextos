'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { HealthDot } from '@/components/shared/health-dot';
import { IconShieldHalfFilled, IconCoin } from '@tabler/icons-react';
import type { FleetAgentData, FleetHealthResponse, ContextStatus, HealthStatus, AgentTokenData } from '@/app/api/agents/fleet-health/route';

// Dubai working hours: 06:00–22:00 = 02:00–18:00 UTC
function refreshInterval(): number {
  const utcHour = new Date().getUTCHours();
  return (utcHour >= 2 && utcHour < 18) ? 30_000 : 60_000;
}

function fmtCost(usd: number): string {
  if (usd < 0.01) return '<$0.01';
  return `$${usd.toFixed(2)}`;
}

function fmtTok(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000)     return `${Math.round(n / 1_000)}k`;
  return String(n);
}

function modelBadge(model: string): string {
  if (model.includes('opus'))   return 'Opus';
  if (model.includes('sonnet')) return 'Sonnet';
  if (model.includes('haiku'))  return 'Haiku';
  return '—';
}

function TokenRow({ agent, data }: { agent: string; data: AgentTokenData }) {
  const totalTok = data.input + data.output + data.cacheRead + data.cacheCreate;
  const tokPerTask = data.tasksToday > 0 ? Math.round(totalTok / data.tasksToday) : null;
  return (
    <tr className="border-b last:border-0 text-xs">
      <td className="py-1.5 font-medium">{agent}</td>
      <td className="py-1.5 text-right">
        <span className="rounded bg-muted/60 px-1 py-0.5 text-[10px] font-mono">{modelBadge(data.model)}</span>
      </td>
      <td className="py-1.5 text-right tabular-nums font-medium">{fmtCost(data.costUsd)}</td>
      <td className="py-1.5 text-right tabular-nums text-muted-foreground">{fmtTok(totalTok)}</td>
      <td className="py-1.5 text-right tabular-nums text-muted-foreground">{data.tasksToday}</td>
      <td className="py-1.5 text-right tabular-nums text-muted-foreground">
        {tokPerTask !== null ? fmtTok(tokPerTask) : '—'}
      </td>
    </tr>
  );
}

const CONTEXT_COLORS: Record<ContextStatus, { bar: string; text: string }> = {
  green:   { bar: 'bg-emerald-500', text: 'text-emerald-600 dark:text-emerald-400' },
  amber:   { bar: 'bg-amber-400',   text: 'text-amber-600 dark:text-amber-400' },
  red:     { bar: 'bg-red-500',     text: 'text-red-600 dark:text-red-400' },
  unknown: { bar: 'bg-muted',       text: 'text-muted-foreground' },
};


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
    let timer: ReturnType<typeof setTimeout>;

    async function fetchData() {
      try {
        const res = await fetch('/api/agents/fleet-health');
        if (!res.ok) return;
        const json = await res.json() as FleetHealthResponse;
        if (!cancelled) setData(json);
      } catch {
        // non-critical
      }
      if (!cancelled) timer = setTimeout(fetchData, refreshInterval());
    }

    fetchData();
    return () => {
      cancelled = true;
      clearTimeout(timer);
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

        {/* Token spend section */}
        <div className="border-t pt-2">
          <div className="flex items-center gap-2 px-2 mb-2">
            <IconCoin size={13} className="text-muted-foreground" />
            <span className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider">Today's Spend</span>
            {data?.tokens && (
              <span className="ml-auto text-sm font-semibold tabular-nums">
                {fmtCost(data.tokens.fleetCostToday)}
              </span>
            )}
          </div>
          {data?.tokens ? (
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead>
                  <tr className="text-[10px] text-muted-foreground">
                    <th className="text-left pb-1 font-medium pl-2">Agent</th>
                    <th className="text-right pb-1 font-medium">Model</th>
                    <th className="text-right pb-1 font-medium">Cost</th>
                    <th className="text-right pb-1 font-medium">Tokens</th>
                    <th className="text-right pb-1 font-medium">Tasks</th>
                    <th className="text-right pb-1 font-medium pr-2">Tok/Task</th>
                  </tr>
                </thead>
                <tbody className="[&_td]:px-0 [&_td:first-child]:pl-2 [&_td:last-child]:pr-2">
                  {Object.entries(data.tokens.agents).map(([agent, tokenData]) => (
                    <TokenRow key={agent} agent={agent} data={tokenData} />
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="text-[10px] text-muted-foreground px-2">
              Scanning token data…
            </p>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
