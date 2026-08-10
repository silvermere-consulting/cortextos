// Autonomous-sync receipt + config (task_1786076594927 / ⑰; engineer<->analyst
// interface lock 2026-08-10).
//
// THE SPLIT (load-bearing): the RECEIPT written here is the NUMERATOR — proof a
// sync run REACHED A VERDICT and wrote. The DENOMINATOR (how many runs were OWED)
// lives in the analyst's absence-watcher, keyed on ITS OWN wallclock x interval,
// anchored at `enabled_since` — NEVER on these receipts. A record authored by the
// subject can only ever report the subject alive.
//
// enabled_since is therefore written by the DEPLOY STEP (an operator), NOT by the
// trigger: a trigger dead-from-birth must still leave the watcher an anchor
// (config says "owed since T", zero receipts = LOUD). This module only READS
// config and WRITES receipts; it never writes enabled_since or the config.

import fs from 'fs';
import path from 'path';
import { CTX_ROOT } from '@/lib/config';

export const SYNC_DIR = path.join(CTX_ROOT, 'state', 'dashboard-sync');
export const CONFIG_PATH = path.join(SYNC_DIR, 'sync-config.json');
export const DEFAULT_RECEIPT_PATH = path.join(SYNC_DIR, 'sync-runs.jsonl');

export interface SyncConfig {
  interval_ms: number;
  enabled_since: string; // ISO, written ONCE at deploy by the operator (not the hook)
  receipt_path?: string; // where receipts append; defaults to the sibling jsonl
}

export interface SyncReceipt {
  ts: string; // ISO, when the run finished
  ok: boolean; // reached a verdict AND wrote
  rows_synced: number; // sum across tasks/approvals/events/heartbeats
  error?: string;
  duration_ms: number;
}

/**
 * Read the sync config. Returns null when absent or missing a required field —
 * the trigger then logs and does NOT run. Cadence has ONE source of truth (this
 * file); the hook never guesses an interval, and a missing config reads to the
 * watcher as CANNOT_TELL (fail-closed), not a clean pass.
 */
export function readSyncConfig(): SyncConfig | null {
  try {
    const cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8')) as Partial<SyncConfig>;
    if (typeof cfg.interval_ms !== 'number' || cfg.interval_ms <= 0) return null;
    if (typeof cfg.enabled_since !== 'string' || !cfg.enabled_since) return null;
    return {
      interval_ms: cfg.interval_ms,
      enabled_since: cfg.enabled_since,
      receipt_path: typeof cfg.receipt_path === 'string' ? cfg.receipt_path : undefined,
    };
  } catch {
    return null;
  }
}

/**
 * Append ONE receipt line ATOMICALLY. A single appendFileSync of the complete
 * line+newline is one O_APPEND write; a receipt is far under PIPE_BUF (4096B),
 * so a reader never sees a torn line and a partial write can never read as a
 * missing receipt (analyst's constraint — a torn line must not fabricate a gap).
 * Never a two-step write. Best-effort: a receipt-write failure must not throw
 * back into the timer (the run itself already happened).
 */
export function writeSyncReceipt(cfg: SyncConfig, record: SyncReceipt): void {
  const target = cfg.receipt_path ?? DEFAULT_RECEIPT_PATH;
  try {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.appendFileSync(target, JSON.stringify(record) + '\n');
  } catch (e) {
    console.error('[dashboard-sync] receipt write failed (run still happened):', e);
  }
}
