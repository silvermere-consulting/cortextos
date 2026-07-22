// cortextOS Dashboard - Chokidar file watcher singleton
// Monitors CTX_ROOT for JSON/JSONL changes, syncs to SQLite, emits SSE events.

import { EventEmitter } from 'events';
import { watch, type FSWatcher } from 'chokidar';
import path from 'path';
import { CTX_ROOT, getOrgs } from './config';
import { syncFile, syncAll } from './sync';
import type { SSEEvent } from './types';

// ---------------------------------------------------------------------------
// globalThis singleton pattern (survives Next.js hot reloads)
// ---------------------------------------------------------------------------

const globalForWatcher = globalThis as unknown as {
  __cortextos_emitter: EventEmitter | undefined;
  __cortextos_watcher: FSWatcher | undefined;
};

export const emitter: EventEmitter =
  globalForWatcher.__cortextos_emitter ?? new EventEmitter();
emitter.setMaxListeners(100); // support many concurrent SSE clients

if (process.env.NODE_ENV !== 'production') {
  globalForWatcher.__cortextos_emitter = emitter;
}

// ---------------------------------------------------------------------------
// Watch path builder
// ---------------------------------------------------------------------------

// chokidar v4 removed glob support (this repo has carried ^5 since its initial
// commit), so a glob here is watched as a LITERAL path that never exists and
// the watcher detects nothing — silently. Measured on the live box 2026-07-22:
// zero "[watcher] change:" lines across every pm2 out log since 2026-06-30.
// Watch real DIRECTORIES (chokidar recurses) and filter to the interesting
// files in isInterestingFile() at event time instead.
function getWatchPaths(): string[] {
  const paths: string[] = [];
  const orgs = getOrgs();

  for (const org of orgs) {
    const orgBase = path.join(CTX_ROOT, 'orgs', org);
    paths.push(path.join(orgBase, 'tasks'));
    paths.push(path.join(orgBase, 'approvals'));
    paths.push(path.join(orgBase, 'analytics', 'events'));
  }

  // Flat paths (not org-scoped)
  paths.push(path.join(CTX_ROOT, 'state'));
  paths.push(path.join(CTX_ROOT, 'inbox'));

  return paths;
}

// The extension/name filter the globs used to express, applied per event.
// state/ is watched as a whole directory but only heartbeat.json files in it
// are signals — everything else under state/ (crons.json, session files,
// oauth) is high-churn noise that must not reach syncFile or the SSE stream.
function isInterestingFile(filePath: string): boolean {
  if (filePath.includes(`${path.sep}state${path.sep}`)) {
    return path.basename(filePath) === 'heartbeat.json';
  }
  if (filePath.includes(`${path.sep}analytics${path.sep}events${path.sep}`)) {
    return filePath.endsWith('.jsonl');
  }
  return filePath.endsWith('.json');
}

// ---------------------------------------------------------------------------
// File change handler
// ---------------------------------------------------------------------------

function categorizeFilePath(filePath: string): SSEEvent['type'] {
  if (filePath.includes('/tasks/')) return 'task';
  if (filePath.includes('/approvals/')) return 'approval';
  if (filePath.includes('/heartbeat.json')) return 'heartbeat';
  if (filePath.includes('/analytics/events/')) return 'event';
  return 'sync';
}

function handleFileChange(
  filePath: string,
  changeType: 'change' | 'add' | 'remove',
): void {
  console.log(`[watcher] ${changeType}: ${filePath}`);

  // Sync the changed file to SQLite (skip for deletions)
  if (changeType !== 'remove') {
    try {
      syncFile(filePath);
    } catch (err) {
      console.error(`[watcher] Sync failed for ${filePath}:`, err);
    }
  }

  // Emit SSE event. CONTRACT: this is a CHANGE SIGNAL, not a data feed —
  // data carries only {filePath, changeType} (kept for debugging/targeted
  // refetch). Consumers must refetch the authoritative source on signal
  // (see hooks/use-sse-refetch.ts); never render display rows from this payload.
  const sseEvent: SSEEvent = {
    type: categorizeFilePath(filePath),
    data: { filePath, changeType },
    timestamp: new Date().toISOString(),
  };

  emitter.emit('sse', sseEvent);
}

// ---------------------------------------------------------------------------
// Watcher factory
// ---------------------------------------------------------------------------

function createWatcher(): FSWatcher {
  const watchPaths = getWatchPaths();

  if (watchPaths.length === 0) {
    console.warn(
      '[watcher] No paths to watch - CTX_ROOT may not have any orgs yet',
    );
  }

  const watcher = watch(watchPaths, {
    ignoreInitial: true,
    persistent: true,
    awaitWriteFinish: {
      stabilityThreshold: 300,
      pollInterval: 100,
    },
  });

  watcher.on('add', (fp) => { if (isInterestingFile(fp)) handleFileChange(fp, 'add'); });
  watcher.on('change', (fp) => { if (isInterestingFile(fp)) handleFileChange(fp, 'change'); });
  watcher.on('unlink', (fp) => { if (isInterestingFile(fp)) handleFileChange(fp, 'remove'); });
  watcher.on('error', (error) => console.error('[watcher] Error:', error));

  console.log(
    `[watcher] Watching ${watchPaths.length} patterns under ${CTX_ROOT}`,
  );
  return watcher;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Initialize the file watcher singleton.
 * Runs a full sync on first call, then starts watching for incremental changes.
 */
export function initWatcher(): FSWatcher {
  if (globalForWatcher.__cortextos_watcher) {
    return globalForWatcher.__cortextos_watcher;
  }

  console.log('[watcher] Running initial full sync...');
  syncAll();

  const watcher = createWatcher();

  if (process.env.NODE_ENV !== 'production') {
    globalForWatcher.__cortextos_watcher = watcher;
  }

  return watcher;
}

/**
 * Gracefully close the watcher.
 */
export function stopWatcher(): void {
  if (globalForWatcher.__cortextos_watcher) {
    globalForWatcher.__cortextos_watcher.close();
    globalForWatcher.__cortextos_watcher = undefined;
  }
}

/**
 * Subscribe to SSE events. Returns an unsubscribe function.
 */
export function onSSEEvent(
  handler: (event: SSEEvent) => void,
): () => void {
  emitter.on('sse', handler);
  return () => emitter.off('sse', handler);
}

// Graceful shutdown on process exit
if (typeof process !== 'undefined') {
  const shutdown = () => {
    stopWatcher();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
