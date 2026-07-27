'use client';

import { useEffect, useState, useCallback } from 'react';
import { useOrg } from '@/hooks/use-org';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { ApprovalCard } from '@/components/approvals/approval-card';
import { ApprovalDetailDialog } from '@/components/approvals/approval-detail-dialog';
import { ApprovalHistoryList } from '@/components/approvals/approval-history-list';
import { IconUser, IconCheck, IconClock } from '@tabler/icons-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card, CardContent } from '@/components/ui/card';
import { PriorityBadge, TimeAgo } from '@/components/shared';
import type { Approval, Task, UnifiedApprovalsFeed } from '@/lib/types';

export default function ApprovalsPage() {
  const { currentOrg } = useOrg();

  const [pending, setPending] = useState<Approval[]>([]);
  const [resolved, setResolved] = useState<Approval[]>([]);
  const [humanTasks, setHumanTasks] = useState<Task[]>([]);
  const [loading, setLoading] = useState(true);

  // Single-source pending feed (approval objects UNION needs_approval tasks),
  // three-valued so "could not read" never renders as "all caught up".
  const [unifiedFeed, setUnifiedFeed] = useState<UnifiedApprovalsFeed>({ status: 'loading' });

  const [selectedApproval, setSelectedApproval] = useState<Approval | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);

  // Per-task response drafts for the [HUMAN] task cards (return-and-close in
  // one action: the value rides complete-task --result, which already exists).
  const [taskResponses, setTaskResponses] = useState<Record<string, string>>({});

  // History filters
  const [historyFilters, setHistoryFilters] = useState({
    agent: 'all',
    category: 'all',
  });

  const fetchApprovals = useCallback(async () => {
    const orgParam = currentOrg !== 'all' ? `&org=${currentOrg}` : '';

    // Single-source pending feed, fetched with EXPLICIT three-valued handling:
    // a failure must surface as "unavailable", never be swallowed into an empty
    // list that reads as "all caught up" (the exact bug this whole change fixes).
    try {
      const res = await fetch('/api/approvals/unified');
      if (res.ok) {
        const body = await res.json();
        setUnifiedFeed({ status: 'ok', items: Array.isArray(body?.items) ? body.items : [] });
      } else {
        const body = await res.json().catch(() => null);
        setUnifiedFeed({ status: 'error', reason: body?.reason || 'Approvals store unavailable' });
      }
    } catch {
      setUnifiedFeed({ status: 'error', reason: 'Could not reach the approvals service' });
    }

    try {
      const [pendingRes, resolvedRes, humanRes] = await Promise.all([
        fetch(`/api/approvals?status=pending${orgParam}`),
        fetch(
          `/api/approvals?status=resolved${orgParam}${
            historyFilters.agent !== 'all' ? `&agent=${historyFilters.agent}` : ''
          }${
            historyFilters.category !== 'all' ? `&category=${historyFilters.category}` : ''
          }`
        ),
        fetch(`/api/tasks?agent=human${orgParam ? `&org=${currentOrg}` : ''}`),
      ]);

      if (pendingRes.ok) {
        setPending(await pendingRes.json());
      }
      if (resolvedRes.ok) {
        setResolved(await resolvedRes.json());
      }
      if (humanRes.ok) {
        const allHuman: Task[] = await humanRes.json();
        setHumanTasks(allHuman.filter(t => t.status !== 'completed'));
      }
    } catch {
      // Silently fail
    } finally {
      setLoading(false);
    }
  }, [currentOrg, historyFilters]);

  useEffect(() => {
    setLoading(true);
    fetchApprovals();
  }, [fetchApprovals]);

  function handleApprovalClick(approval: Approval) {
    setSelectedApproval(approval);
    setDialogOpen(true);
  }

  async function handleResolve(
    id: string,
    decision: 'approved' | 'rejected',
    note?: string,
    response?: string,
  ) {
    try {
      const res = await fetch(`/api/approvals/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ decision, note, response }),
      });

      if (res.ok) {
        fetchApprovals();
      } else {
        // Surface the server's refusal (e.g. secret-shaped response) instead
        // of silently reloading — the message names the fix.
        const data = await res.json().catch(() => null);
        if (data?.error) window.alert(data.error);
      }
    } catch {
      // Silently fail
    }
  }

  function handleHistoryFilterChange(key: string, value: string) {
    setHistoryFilters((prev) => ({ ...prev, [key]: value }));
  }

  function handleClearHistoryFilters() {
    setHistoryFilters({ agent: 'all', category: 'all' });
  }

  // Derive unique values for history filter dropdowns
  const historyAgents = [...new Set(resolved.map((a) => a.agent))];
  const historyCategories = [...new Set(resolved.map((a) => a.category))];

  if (loading) {
    return (
      <div className="space-y-6">
        <h1 className="text-2xl font-semibold">Approvals</h1>
        <div className="space-y-4">
          <div className="h-10 w-48 rounded-lg bg-muted/30 animate-pulse" />
          <div className="space-y-2">
            {Array.from({ length: 3 }).map((_, i) => (
              <div key={i} className="h-24 rounded-xl bg-muted/30 animate-pulse" />
            ))}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-semibold">Approvals</h1>

      <Tabs defaultValue={humanTasks.length > 0 ? 'human' : 'pending'}>
        <TabsList>
          <TabsTrigger value="human">
            <IconUser size={14} className="mr-1" />
            Your Tasks
            {humanTasks.length > 0 && (
              <span className="ml-1.5 rounded-full bg-primary px-1.5 py-0.5 text-[10px] font-semibold text-primary-foreground">
                {humanTasks.length}
              </span>
            )}
          </TabsTrigger>
          <TabsTrigger value="pending">
            Approvals
            {unifiedFeed.status === 'ok' && unifiedFeed.items.length > 0 && (
              <span className="ml-1.5 rounded-full bg-primary px-1.5 py-0.5 text-[10px] font-semibold text-primary-foreground">
                {unifiedFeed.items.length}
              </span>
            )}
            {unifiedFeed.status === 'error' && (
              <span className="ml-1.5 rounded-full bg-destructive px-1.5 py-0.5 text-[10px] font-semibold text-destructive-foreground">
                !
              </span>
            )}
          </TabsTrigger>
          <TabsTrigger value="history">History</TabsTrigger>
        </TabsList>

        {/* Human Tasks tab */}
        <TabsContent value="human">
          {humanTasks.length === 0 ? (
            <p className="py-12 text-center text-sm text-muted-foreground">
              No tasks assigned to you right now.
            </p>
          ) : (
            <div className="grid gap-2 max-w-2xl">
              {humanTasks.map((task) => (
                <Card key={task.id} className="hover:bg-muted/20 transition-colors">
                  <CardContent className="flex items-start justify-between py-3">
                    <div className="min-w-0 flex-1 space-y-1">
                      <p className="text-sm font-medium">{task.title}</p>
                      {task.description && (
                        <p className="text-xs text-muted-foreground line-clamp-2">{task.description}</p>
                      )}
                      <div className="flex items-center gap-2 text-xs text-muted-foreground">
                        <PriorityBadge priority={task.priority} />
                        <span>from {task.assignee ?? 'unknown'}</span>
                        <IconClock size={12} />
                        <TimeAgo date={task.created_at} />
                      </div>
                      <Input
                        className="mt-1 h-8 text-xs"
                        placeholder="Response — one-time share link preferred (optional)"
                        value={taskResponses[task.id] ?? ''}
                        maxLength={1000}
                        onChange={(e) =>
                          setTaskResponses((prev) => ({
                            ...prev,
                            [task.id]: e.target.value,
                          }))
                        }
                      />
                    </div>
                    <Button
                      size="sm"
                      variant="outline"
                      className="ml-3 shrink-0"
                      onClick={async () => {
                        const outputSummary =
                          taskResponses[task.id]?.trim() || undefined;
                        const res = await fetch(`/api/tasks/${task.id}`, {
                          method: 'PATCH',
                          headers: { 'Content-Type': 'application/json' },
                          body: JSON.stringify({ status: 'completed', outputSummary }),
                        });
                        if (!res.ok) {
                          const data = await res.json().catch(() => null);
                          if (data?.error) window.alert(data.error);
                        }
                        fetchApprovals();
                      }}
                    >
                      <IconCheck size={14} className="mr-1" />
                      Done
                    </Button>
                  </CardContent>
                </Card>
              ))}
            </div>
          )}
        </TabsContent>

        {/* Pending tab — single-source unified feed, THREE-VALUED.
            cannot-read renders an explicit unavailable state, never "all caught up". */}
        <TabsContent value="pending">
          {unifiedFeed.status === 'loading' ? (
            <p className="py-12 text-center text-sm text-muted-foreground">Loading…</p>
          ) : unifiedFeed.status === 'error' ? (
            <div className="max-w-2xl rounded-xl border border-destructive/50 bg-destructive/10 p-4">
              <p className="text-sm font-semibold text-destructive">Approvals unavailable</p>
              <p className="mt-1 text-xs text-destructive/80">
                Could not read the approvals store — {unifiedFeed.reason}. This is <strong>not</strong> &ldquo;all caught up&rdquo;: the list failed to load and may be hiding pending items. Retry shortly or check the dashboard logs.
              </p>
            </div>
          ) : unifiedFeed.items.length === 0 ? (
            <p className="py-12 text-center text-sm text-muted-foreground">
              No pending approvals - you are all caught up.
            </p>
          ) : (
            <div className="grid gap-2 max-w-2xl">
              {unifiedFeed.items.map((item) => {
                // A real approval object with its full record present → keep the
                // interactive resolve card. A flagged task (or an approval whose
                // full record isn't loaded) → an informational visible row.
                const full = item.source === 'approval'
                  ? pending.find((p) => p.id === item.id)
                  : undefined;
                if (full) {
                  return (
                    <ApprovalCard key={item.id} approval={full} onClick={handleApprovalClick} />
                  );
                }
                return (
                  <Card key={item.id}>
                    <CardContent className="py-3 space-y-1">
                      <div className="flex items-center gap-2">
                        <span className="rounded-full bg-muted px-1.5 py-0.5 text-[10px] font-semibold uppercase text-muted-foreground">
                          {item.source === 'flagged_task' ? 'Task' : 'Approval'}
                        </span>
                        <p className="text-sm font-medium">{item.title}</p>
                      </div>
                      <div className="flex items-center gap-2 text-xs text-muted-foreground">
                        <span>{item.agent}</span>
                        <span>·</span>
                        <span>{item.status}</span>
                        <span>·</span>
                        <span>{item.org}</span>
                        <IconClock size={12} />
                        <TimeAgo date={item.created_at} />
                      </div>
                    </CardContent>
                  </Card>
                );
              })}
            </div>
          )}
        </TabsContent>

        {/* History tab */}
        <TabsContent value="history">
          <ApprovalHistoryList
            approvals={resolved}
            agents={historyAgents}
            categories={historyCategories}
            filters={historyFilters}
            onFilterChange={handleHistoryFilterChange}
            onClearFilters={handleClearHistoryFilters}
            onApprovalClick={handleApprovalClick}
          />
        </TabsContent>
      </Tabs>

      {/* Approval detail dialog */}
      <ApprovalDetailDialog
        approval={selectedApproval}
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        onResolve={selectedApproval?.status === 'pending' ? handleResolve : undefined}
      />
    </div>
  );
}
