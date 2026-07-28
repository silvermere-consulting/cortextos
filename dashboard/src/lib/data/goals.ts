// cortextOS Dashboard - Goals data fetcher
// Reads/writes goals.json directly from filesystem (not SQLite).

import fs from 'fs';
import path from 'path';
import os from 'os';
import { getGoalsPath } from '@/lib/config';
import type { GoalsFile, GoalsData } from '@/lib/types';

const DEFAULT_GOALS: GoalsFile = {
  bottleneck: '',
  goals: [],
};

/**
 * Read goals.json for an org. Returns default structure if file missing.
 */
export function getGoals(org: string): GoalsData {
  const filePath = getGoalsPath(org);
  if (!fs.existsSync(filePath)) {
    return { ...DEFAULT_GOALS, goals: [] };
  }
  try {
    const raw = fs.readFileSync(filePath, 'utf-8');
    const data = JSON.parse(raw);

    let goals: import('@/lib/types').Goal[] = [];
    if (Array.isArray(data.goals)) {
      goals = data.goals.map((g: unknown, i: number) => {
        if (typeof g === 'string') {
          // Legacy format: goals are plain strings
          return { id: `goal-${i}`, title: g, progress: 0, order: i };
        }
        // Dashboard format: goals are objects with id, title, progress
        const obj = g as Record<string, unknown>;
        return {
          id: (obj.id as string) ?? `goal-${i}`,
          title: (obj.title as string) ?? 'Untitled',
          progress: (obj.progress as number) ?? 0,
          order: (obj.order as number) ?? i,
        };
      });
    }

    return {
      bottleneck: data.bottleneck ?? '',
      goals,
      daily_focus: data.daily_focus ?? undefined,
      daily_focus_set_at: data.daily_focus_set_at ?? undefined,
    };
  } catch {
    return { ...DEFAULT_GOALS, goals: [] };
  }
}

/**
 * Atomic write of goals.json for an org (write to tmp, then rename).
 *
 * PRESERVE-MERGE: reads the existing file and spreads it UNDER `data`, so keys
 * that GoalsData does not model — `north_star` today, and any field added to
 * goals.json in future — survive a dashboard write instead of being stripped.
 * (Before this, the server-action path `getGoals -> mutate -> writeGoals`
 * JSON.stringify'd only the four GoalsData fields, silently deleting north_star
 * and never stamping updated_at — see othe's bug report 2026-07-28.) Also
 * (re-)stamps `updated_at`, matching the CLI writer (src/cli/goals.ts) and the
 * PATCH route (app/api/goals/route.ts) so all three writers leave the same shape.
 *
 * BOUND — ADDITIVE-ONLY: `{ ...existing, ...data }` can add or overwrite a key
 * but CANNOT delete one. Any key ever written to goals.json becomes immortal via
 * this path. Safe today: the dashboard has no delete-key operation on goals. If a
 * future dashboard feature needs to REMOVE a top-level goals.json key, it must not
 * rely on writeGoals — this merge would silently no-op the deletion (a silent
 * no-op in place of the old silent strip: same class, opposite sign).
 */
export function writeGoals(org: string, data: GoalsData): void {
  const filePath = getGoalsPath(org);
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  // Preserve keys not modelled by GoalsData (north_star, future additions).
  let existing: Record<string, unknown> = {};
  if (fs.existsSync(filePath)) {
    try {
      existing = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    } catch {
      // Corrupt/unparseable existing file: fall back to a clean write of `data`.
      existing = {};
    }
  }

  // Overlay only DEFINED fields from `data`, so an undefined optional (e.g.
  // daily_focus) never clobbers a value already on disk — mirrors the PATCH
  // route's "only apply provided fields" semantics.
  const overlay = Object.fromEntries(
    Object.entries(data).filter(([, v]) => v !== undefined),
  );
  const merged = { ...existing, ...overlay, updated_at: new Date().toISOString() };

  const tmp = path.join(os.tmpdir(), `goals-${org}-${Date.now()}.json`);
  fs.writeFileSync(tmp, JSON.stringify(merged, null, 2) + '\n', 'utf-8');
  fs.renameSync(tmp, filePath);
}

/**
 * Read goal history by scanning events for bottleneck/goal changes.
 * Returns recent events related to goal modifications.
 */
export function getGoalHistory(
  org: string
): Array<{ timestamp: string; change: string }> {
  try {
    const { getRecentEvents } = require('./events');
    const events = getRecentEvents(50, org) as Array<{
      type: string;
      message?: string;
      timestamp: string;
    }>;
    return events
      .filter(
        (e) =>
          e.type === 'action' &&
          e.message &&
          (e.message.includes('goal') || e.message.includes('bottleneck'))
      )
      .map((e) => ({
        timestamp: e.timestamp,
        change: e.message ?? '',
      }));
  } catch {
    return [];
  }
}
