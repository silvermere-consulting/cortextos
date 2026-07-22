'use client';

import { useEffect, useRef } from 'react';
import { useSSE } from './use-sse';
import type { SSEEvent } from '@/lib/types';

// The SSE stream is a CHANGE SIGNAL, not a data feed: the producer
// (lib/watcher.ts) emits {filePath, changeType} only. Any component that
// renders event/agent fields must refetch its authoritative source (SQLite via
// the API, or a server re-render) when signalled — never build display rows
// from the SSE payload itself.

export interface UseSSERefetchOptions {
  /** SSE event types that signal the authoritative source changed. */
  types: ReadonlyArray<SSEEvent['type']>;
  /** Refetch the authoritative source. Fired on the trailing edge of a burst. */
  onRefetch: () => void | Promise<void>;
  /** Trailing-edge debounce: one refetch per burst, after it settles (ms). */
  debounceMs?: number;
  /** Staleness bound under a continuous stream: refetch at least this often (ms). */
  maxWaitMs?: number;
}

export interface UseSSERefetchReturn {
  isConnected: boolean;
}

/**
 * Subscribe to the SSE stream as a *signal* and run a debounced refetch of the
 * authoritative source. Trailing-edge debounce collapses fleet-wide bursts
 * (e.g. a cron firing on every agent at once) into a single refetch; maxWaitMs
 * guarantees the refetch cannot be starved by a stream that never goes quiet.
 */
export function useSSERefetch({
  types,
  onRefetch,
  debounceMs = 750,
  maxWaitMs = 5_000,
}: UseSSERefetchOptions): UseSSERefetchReturn {
  const onRefetchRef = useRef(onRefetch);
  onRefetchRef.current = onRefetch;

  const typesRef = useRef(types);
  typesRef.current = types;

  const debounceMsRef = useRef(debounceMs);
  debounceMsRef.current = debounceMs;

  const maxWaitMsRef = useRef(maxWaitMs);
  maxWaitMsRef.current = maxWaitMs;

  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const firstSignalAtRef = useRef<number | null>(null);

  const filterRef = useRef((e: SSEEvent) => typesRef.current.includes(e.type));

  const { isConnected } = useSSE({
    bufferSize: 1,
    filter: filterRef.current,
    onEvent: () => {
      const now = Date.now();
      if (firstSignalAtRef.current === null) firstSignalAtRef.current = now;
      if (timerRef.current) clearTimeout(timerRef.current);

      const elapsed = now - firstSignalAtRef.current;
      const wait = Math.min(
        debounceMsRef.current,
        Math.max(0, maxWaitMsRef.current - elapsed),
      );
      timerRef.current = setTimeout(() => {
        timerRef.current = null;
        firstSignalAtRef.current = null;
        void onRefetchRef.current();
      }, wait);
    },
  });

  // Clear any pending refetch on unmount.
  useEffect(
    () => () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    },
    [],
  );

  return { isConnected };
}
