'use client';

import { useState } from 'react';
import {
  IconMessage,
  IconCheckbox,
  IconShield,
  IconAlertTriangle,
  IconFlag,
  IconActivity,
} from '@tabler/icons-react';
import { formatDistanceToNow } from 'date-fns';
import { AgentAvatar } from '@/components/shared/agent-avatar';
import { useSSERefetch } from '@/hooks/use-sse-refetch';
import type { Event, EventType } from '@/lib/types';

// -- Icon mapping --

const eventTypeIcons: Record<string, React.ReactNode> = {
  message: <IconMessage size={16} />,
  task: <IconCheckbox size={16} />,
  approval: <IconShield size={16} />,
  error: <IconAlertTriangle size={16} className="text-destructive" />,
  milestone: <IconFlag size={16} className="text-primary" />,
  heartbeat: <IconActivity size={16} className="text-muted-foreground" />,
  action: <IconActivity size={16} />,
};

const severityBg: Record<string, string> = {
  info: '',
  warning: 'bg-warning/5',
  error: 'bg-destructive/5',
};

function formatEventTime(timestamp: string): string {
  try {
    return formatDistanceToNow(new Date(timestamp), { addSuffix: true });
  } catch {
    return 'unknown';
  }
}

// -- Types --

export interface EventFeedFilters {
  types: EventType[];
  agent: string;
  org: string;
  from?: string;
  to?: string;
}

interface EventFeedProps {
  initialEvents: Event[];
  filters: EventFeedFilters;
}

// -- Component --

export function EventFeed({ initialEvents, filters }: EventFeedProps) {
  const [allEvents, setAllEvents] = useState<Event[]>(initialEvents);

  // SSE is a signal, not data: the stream payload carries only
  // {filePath, changeType} — no agent/severity/message. Rows built from it
  // rendered live criticals as 'info' and made the agent filter drop every
  // live row. On signal, refetch the same SQL path the server render uses.
  const { isConnected } = useSSERefetch({
    types: ['event'],
    onRefetch: async () => {
      try {
        const res = await fetch('/api/events?limit=200');
        if (!res.ok) {
          console.warn('[event-feed] events refetch failed:', res.status);
          return; // keep the last authoritative list; never synthesize rows
        }
        setAllEvents((await res.json()) as Event[]);
      } catch (err) {
        console.warn('[event-feed] events refetch failed:', err);
      }
    },
  });

  // Apply client-side filters to display
  const displayEvents = allEvents.filter((e) => {
    if (filters.types.length > 0 && !filters.types.includes(e.type)) return false;
    if (filters.agent && e.agent !== filters.agent) return false;
    if (filters.org && e.org !== filters.org) return false;
    if (filters.from && e.timestamp < filters.from) return false;
    if (filters.to && e.timestamp > filters.to) return false;
    return true;
  });

  return (
    <div className="space-y-1">
      {/* Connection indicator */}
      <div className="flex items-center gap-2 pb-2 text-xs text-muted-foreground">
        <span
          className={`inline-block h-2 w-2 rounded-full ${
            isConnected ? 'bg-green-500 animate-pulse' : 'bg-yellow-500'
          }`}
        />
        {isConnected ? 'Live' : 'Reconnecting...'}
        <span className="ml-auto">{displayEvents.length} events</span>
      </div>

      {/* Event list */}
      {displayEvents.length === 0 ? (
        <p className="text-sm text-muted-foreground py-8 text-center">
          No events match the current filters.
        </p>
      ) : (
        displayEvents.map((event) => (
          <div
            key={event.id}
            className={`flex items-start gap-3 rounded-lg px-3 py-2.5 hover:bg-muted/50 transition-colors ${
              severityBg[event.severity] ?? ''
            }`}
          >
            {/* Timestamp */}
            <span className="shrink-0 text-xs text-muted-foreground tabular-nums w-[7rem] pt-0.5" suppressHydrationWarning>
              {formatEventTime(event.timestamp)}
            </span>

            {/* Agent avatar */}
            <AgentAvatar name={event.agent || '?'} size="sm" />

            {/* Event type icon */}
            <span className="shrink-0 mt-0.5 text-muted-foreground">
              {eventTypeIcons[event.type] ?? <IconActivity size={16} />}
            </span>

            {/* Message */}
            <div className="flex-1 min-w-0">
              <p className="text-sm leading-snug">
                {event.message ?? event.category ?? event.type}
              </p>
              {event.agent && (
                <p className="text-xs text-muted-foreground mt-0.5">
                  {event.agent}
                  {event.org ? ` - ${event.org}` : ''}
                </p>
              )}
            </div>

            {/* Type badge */}
            <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
              {event.type}
            </span>
          </div>
        ))
      )}
    </div>
  );
}
