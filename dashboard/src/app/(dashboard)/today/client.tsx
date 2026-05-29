'use client';

import { useRouter, usePathname } from 'next/navigation';
import { useTransition } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import type { TodayDigest } from '@/lib/data/today';

const RANGE_OPTIONS: { key: 'today' | 'yesterday' | 'this-week'; label: string }[] = [
  { key: 'today', label: 'Today' },
  { key: 'yesterday', label: 'Yesterday' },
  { key: 'this-week', label: 'This week' },
];

function formatTime(iso: string): string {
  try {
    return new Date(iso).toLocaleTimeString('en-GB', {
      timeZone: 'Asia/Dubai',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return iso.slice(11, 16);
  }
}

function formatDate(iso: string): string {
  try {
    return new Date(iso).toLocaleDateString('en-GB', {
      timeZone: 'Asia/Dubai',
      weekday: 'long',
      day: 'numeric',
      month: 'long',
      year: 'numeric',
    });
  } catch {
    return iso.slice(0, 10);
  }
}

function severityColor(sev: string): string {
  if (sev === 'error') return 'bg-red-500/10 text-red-700 dark:text-red-300';
  if (sev === 'warning') return 'bg-amber-500/10 text-amber-700 dark:text-amber-300';
  return 'bg-slate-500/10 text-slate-700 dark:text-slate-300';
}

export function TodayPageClient({ digest, currentOrg, currentRange }: { digest: TodayDigest; currentOrg: string; currentRange: 'today' | 'yesterday' | 'this-week' | 'custom' }) {
  const router = useRouter();
  const pathname = usePathname();
  const [isPending, startTransition] = useTransition();

  function switchRange(kind: 'today' | 'yesterday' | 'this-week') {
    startTransition(() => {
      router.push(`${pathname}?range=${kind}&org=${encodeURIComponent(currentOrg)}`);
    });
  }

  function refresh() {
    startTransition(() => {
      router.refresh();
    });
  }

  const projectGroups = new Map<string, typeof digest.deliverables>();
  for (const d of digest.deliverables) {
    if (!projectGroups.has(d.project)) projectGroups.set(d.project, []);
    projectGroups.get(d.project)!.push(d);
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold">{digest.range.label}</h1>
          <p className="text-sm text-muted-foreground mt-1">
            {formatDate(digest.range.fromIso)} · {currentOrg}
          </p>
        </div>
        <div className="flex flex-wrap gap-2 items-center">
          {RANGE_OPTIONS.map((r) => {
            const active = currentRange === r.key;
            return (
              <button
                key={r.key}
                type="button"
                onClick={() => switchRange(r.key)}
                disabled={isPending}
                className={
                  'px-3 py-1.5 rounded-md text-xs font-medium border transition-colors ' +
                  (active
                    ? 'bg-slate-900 text-white border-slate-900 dark:bg-white dark:text-slate-900 dark:border-white'
                    : 'bg-transparent text-slate-700 border-slate-300 hover:bg-slate-50 dark:text-slate-300 dark:border-slate-700 dark:hover:bg-slate-800')
                }
              >
                {r.label}
              </button>
            );
          })}
          <button
            type="button"
            onClick={refresh}
            disabled={isPending}
            className="px-3 py-1.5 rounded-md text-xs font-medium border bg-amber-500/10 text-amber-700 border-amber-300 hover:bg-amber-500/20"
          >
            {isPending ? 'Loading…' : 'Refresh'}
          </button>
        </div>
      </div>

      {/* Counts strip */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <CountCard label="Events" value={digest.counts.events} />
        <CountCard label="Tasks completed" value={digest.counts.tasksCompleted} />
        <CountCard label="PDFs created" value={digest.counts.deliverables} />
        <CountCard label="Active agents" value={digest.counts.activeAgents} />
      </div>

      {/* Two-column main: feed + sidebars */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Activity feed (2 cols) */}
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle className="text-sm font-medium uppercase tracking-wider text-muted-foreground">Activity feed ({digest.events.length})</CardTitle>
          </CardHeader>
          <CardContent>
            {digest.events.length === 0 ? (
              <p className="text-sm text-muted-foreground italic">No events in this range yet.</p>
            ) : (
              <ul className="divide-y divide-slate-200 dark:divide-slate-800 max-h-[600px] overflow-y-auto">
                {digest.events.map((e) => (
                  <li key={e.id} className="py-2 flex items-start gap-3 text-sm">
                    <span className="text-xs text-muted-foreground font-mono shrink-0 w-12">{formatTime(e.timestamp)}</span>
                    <Badge variant="outline" className="shrink-0 text-[10px]">{e.agent}</Badge>
                    <span className={'shrink-0 rounded px-1.5 py-0.5 text-[10px] font-semibold ' + severityColor(e.severity)}>{e.type}</span>
                    <span className="text-slate-700 dark:text-slate-300 truncate">{e.message ?? e.category ?? ''}</span>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>

        {/* Agent activity (right col) */}
        <Card>
          <CardHeader>
            <CardTitle className="text-sm font-medium uppercase tracking-wider text-muted-foreground">Agent activity</CardTitle>
          </CardHeader>
          <CardContent>
            {digest.agentActivity.length === 0 ? (
              <p className="text-sm text-muted-foreground italic">No agent activity yet.</p>
            ) : (
              <ul className="space-y-2">
                {digest.agentActivity.map((a) => (
                  <li key={a.agent} className="flex items-center justify-between gap-2 text-sm">
                    <span className="font-medium">{a.agent}</span>
                    <span className="text-xs text-muted-foreground">
                      {a.events} ev · {a.taskCompletions} done
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Deliverables — grouped by project */}
      <Card>
        <CardHeader>
          <CardTitle className="text-sm font-medium uppercase tracking-wider text-muted-foreground">Deliverables ({digest.counts.deliverables})</CardTitle>
        </CardHeader>
        <CardContent>
          {digest.deliverables.length === 0 ? (
            <p className="text-sm text-muted-foreground italic">No PDFs created in this range.</p>
          ) : (
            <div className="space-y-4">
              {[...projectGroups.entries()].map(([project, items]) => (
                <div key={project}>
                  <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-2">{project} ({items.length})</h3>
                  <ul className="space-y-1">
                    {items.map((d) => (
                      <li key={d.absPath} className="text-sm flex items-center justify-between gap-3">
                        <a
                          className="text-amber-700 dark:text-amber-300 hover:underline truncate"
                          href={`/knowledge-base?org=${encodeURIComponent(d.org)}&doc=${encodeURIComponent(d.absPath)}`}
                        >
                          {d.filename}
                        </a>
                        <span className="text-xs text-muted-foreground shrink-0">
                          {formatTime(d.modifiedAtIso)} · {(d.sizeBytes / 1024).toFixed(0)}KB
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Bottom row: open picks + banked rules */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        <Card>
          <CardHeader>
            <CardTitle className="text-sm font-medium uppercase tracking-wider text-muted-foreground">Open Steven picks</CardTitle>
          </CardHeader>
          <CardContent>
            {digest.openPicks.length === 0 ? (
              <p className="text-sm text-muted-foreground italic">No queued picks surfaced today.</p>
            ) : (
              <ul className="space-y-1.5">
                {digest.openPicks.map((p, i) => (
                  <li key={i} className="text-sm flex items-start gap-2">
                    <span className="text-amber-600 shrink-0">•</span>
                    <span className="text-slate-700 dark:text-slate-300">{p}</span>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-sm font-medium uppercase tracking-wider text-muted-foreground">Banked rules</CardTitle>
          </CardHeader>
          <CardContent>
            {digest.bankedRules.length === 0 ? (
              <p className="text-sm text-muted-foreground italic">No MEMORY.md updates today.</p>
            ) : (
              <ul className="space-y-2 max-h-[400px] overflow-y-auto">
                {digest.bankedRules.slice(0, 10).map((r, i) => (
                  <li key={i} className="text-sm border-l-2 border-amber-500/40 pl-3">
                    <div className="flex items-center gap-2">
                      <Badge variant="outline" className="text-[10px]">{r.agent}</Badge>
                      <span className="font-medium">{r.title}</span>
                    </div>
                    {r.description && (
                      <p className="text-xs text-muted-foreground mt-0.5 line-clamp-2">{r.description}</p>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

function CountCard({ label, value }: { label: string; value: number }) {
  return (
    <Card>
      <CardContent className="pt-6">
        <p className="text-xs text-muted-foreground uppercase tracking-wider">{label}</p>
        <p className="text-3xl font-semibold tabular-nums mt-1">{value}</p>
      </CardContent>
    </Card>
  );
}
