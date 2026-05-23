/**
 * hook-compact-telegram.ts — PreCompact hook.
 * Sends a Telegram notification when Claude Code begins context compaction,
 * so the user knows why the agent goes quiet for a moment (#18). Also logs a
 * structured `metric/compaction_started` event so per-day compaction rates
 * become countable (audit 2026-05-22 retired the log-grep proxy).
 *
 * This hook fires and returns immediately — it never blocks the compaction.
 * Registered in settings.json under the "PreCompact" event.
 *
 * Safety: fetch is raced against a 5s abort signal so this process always
 * exits well within the 10s settings.json timeout. A timed-out or failed
 * Telegram call must never abort compaction. The event-log write is
 * best-effort, sync, and swallows all errors for the same reason.
 */

import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { loadEnv } from './index.js';
import { logEvent } from '../bus/event.js';
import { resolvePaths } from '../utils/paths.js';

/**
 * Best-effort: log a metric event capturing the compaction fire and the
 * used_percentage at the moment of compaction (sourced from the live gauge).
 * Sync, swallows all errors — must never block or fail the hook.
 */
function logCompactionEvent(agentName: string, org: string): void {
  try {
    const instanceId = process.env.CTX_INSTANCE_ID ?? 'default';
    const paths = resolvePaths(agentName, instanceId, org || undefined);

    let usedPercentage: number | null = null;
    try {
      const gaugePath = join(
        process.env.CTX_ROOT || join(homedir(), '.cortextos', instanceId),
        'state',
        agentName,
        'context_status.json',
      );
      if (existsSync(gaugePath)) {
        const gauge = JSON.parse(readFileSync(gaugePath, 'utf-8'));
        if (typeof gauge.used_percentage === 'number') {
          usedPercentage = gauge.used_percentage;
        }
      }
    } catch { /* gauge unavailable — log without it */ }

    logEvent(paths, agentName, org ?? '', 'metric', 'compaction_started', 'info', {
      ...(usedPercentage !== null ? { used_percentage: usedPercentage } : {}),
    });
  } catch {
    // Event-log write must never block compaction.
  }
}

async function main(): Promise<void> {
  const env = loadEnv();
  const agentName = env.agentName || 'agent';

  // Log the compaction event first — it's a sync filesystem write, sub-ms,
  // and survives even when no Telegram is configured.
  logCompactionEvent(agentName, process.env.CTX_ORG ?? '');

  if (!env.botToken || !env.chatId) return;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);

  try {
    const url = `https://api.telegram.org/bot${env.botToken}/sendMessage`;
    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: env.chatId,
        text: `[${agentName}] Context compacting... resuming shortly`,
      }),
      signal: controller.signal,
    });
  } catch {
    // Never fail — compaction must not be blocked
  } finally {
    clearTimeout(timer);
  }
}

main().catch(() => process.exit(0));
