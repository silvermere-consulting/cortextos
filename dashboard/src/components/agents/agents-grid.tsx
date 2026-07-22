'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { AgentCard, type AgentCardData } from './agent-card';
import { AddAgentCard } from './add-agent-card';
import { CreateAgentDialog } from './create-agent-dialog';
import { HealthDot } from '@/components/shared/health-dot';
import { IconUsers } from '@tabler/icons-react';
import { useSSERefetch } from '@/hooks/use-sse-refetch';

interface AgentsGridProps {
  initialAgents: AgentCardData[];
}

export function AgentsGrid({ initialAgents }: AgentsGridProps) {
  const router = useRouter();
  const [createOpen, setCreateOpen] = useState(false);

  // Render the server-derived agents directly. The old code copied the prop
  // into state once and patched it from SSE payload fields the producer never
  // writes (data.agent/health/current_task) — so live health updates were
  // silently dead. The authority for agent/health state is the server page
  // (heartbeats via getHealthStatus), so a heartbeat signal triggers a server
  // re-render; the fresh prop flows straight through.
  const agents = initialAgents;

  useSSERefetch({
    types: ['heartbeat'],
    onRefetch: () => router.refresh(),
  });

  return (
    <div className="space-y-4">
      {/* Health summary row */}
      <div className="flex items-center gap-4 text-sm text-muted-foreground">
        <span className="flex items-center gap-1.5">
          <HealthDot status="healthy" />
          {agents.filter((a) => a.health === 'healthy').length} healthy
        </span>
        <span className="flex items-center gap-1.5">
          <HealthDot status="stale" />
          {agents.filter((a) => a.health === 'stale').length} stale
        </span>
        <span className="flex items-center gap-1.5">
          <HealthDot status="down" />
          {agents.filter((a) => a.health === 'down').length} down
        </span>
      </div>

      {/* Grid */}
      {agents.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-16 text-center">
          <IconUsers size={48} className="text-muted-foreground/30 mb-4" />
          <h3 className="text-lg font-medium mb-1">No agents configured</h3>
          <p className="text-sm text-muted-foreground mb-4 max-w-sm">
            Add your first agent to start monitoring and managing your AI fleet.
          </p>
          <AddAgentCard onClick={() => setCreateOpen(true)} />
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {agents.map((agent) => (
            <AgentCard key={agent.name} agent={agent} />
          ))}
          <AddAgentCard onClick={() => setCreateOpen(true)} />
        </div>
      )}

      <CreateAgentDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        onCreated={() => router.refresh()}
      />
    </div>
  );
}
