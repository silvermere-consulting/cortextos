/**
 * pending-approvals.ts — the SINGLE SOURCE for "what is awaiting approval".
 *
 * Unions two stores that both represent an unactioned approval need but that
 * no view previously read together:
 *   1. First-class approval objects (create-approval → approvals/pending/*.json).
 *   2. Tasks flagged `needs_approval` sitting in an unresolved state
 *      (pending / in_progress / blocked).
 *
 * WHY THIS EXISTS (engineer investigation, 2026-07-27): `create-task
 * --needs-approval` sets a task boolean and NEVER mints an approval object, so a
 * surface that reads only the approvals store is structurally blind to flagged
 * tasks. Eight Steve-gated GOTM-outreach tasks sat invisible for days while the
 * dashboard affirmed "No pending approvals — all caught up." The dashboard
 * Approvals API and the orchestrator's HEARTBEAT approvals sweep now BOTH call
 * this one function (the dashboard shells out to the CLI verb that wraps it), so
 * the fork cannot re-open as two drifting readers.
 *
 * THREE-VALUED CONTRACT (chief, 2026-07-27): a caller MUST be able to tell
 * "zero pending" from "could not read" — collapsing them rebuilds the exact bug
 * (a surface affirming completeness while blind) with a new mechanism. The
 * underlying listPendingApprovals/listTasks helpers SWALLOW fs errors to [] and
 * cannot tell missing-dir from unreadable-dir, so this function enforces the
 * distinction ABOVE them by THROWING on cannot-read. Callers map a throw to a
 * visible "unavailable" state, never to an empty list.
 *   - store ROOT (orgBase) absent  → path/instance/org did not resolve → THROW.
 *     Asserts RESOLVABILITY, never POPULATION: a row-count canary would be a
 *     false all-clear for a legitimately fresh org.
 *   - root present, substore never created → legit empty ([]).
 *   - substore exists but unreadable (EACCES etc.) → THROW.
 */

import { existsSync, readdirSync } from 'fs';
import { join, dirname } from 'path';
import type { BusPaths, TaskStatus } from '../types/index.js';
import { listPendingApprovals } from './approval.js';
import { listTasks } from './task.js';

export interface UnifiedPendingItem {
  /** Which store this came from: a first-class approval object, or a flagged task. */
  source: 'approval' | 'flagged_task';
  id: string;
  title: string;
  status: string;
  created_at: string;
  org: string;
  /** requesting_agent for approvals; assigned_to for flagged tasks. */
  agent: string;
  category: string;
  description: string;
}

/** Task statuses that mean an approval flag is still awaiting a decision. */
export const UNRESOLVED_FLAGGED_STATUSES: ReadonlySet<TaskStatus> = new Set<TaskStatus>([
  'pending',
  'in_progress',
  'blocked',
]);

/**
 * Assert a substore dir is readable. Missing (ENOENT) is legitimately empty
 * ONLY because the caller has already proven the store root resolved; any other
 * error (EACCES, etc.) is cannot-read and throws.
 */
function assertSubstoreReadable(dir: string): void {
  try {
    readdirSync(dir);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return; // root resolved, substore never created = legit empty
    throw new Error(`cannot read substore ${dir}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * Pending approvals UNION unresolved needs_approval tasks for ONE org's paths.
 * Throws on cannot-read (see the three-valued contract above); returns [] only
 * when the stores resolved and were genuinely empty.
 */
export function listPendingApprovalsUnified(paths: BusPaths): UnifiedPendingItem[] {
  // Fail-loud resolvability check BEFORE the swallowing helpers run.
  const storeRoot = dirname(paths.taskDir); // == dirname(approvalDir) == orgBase
  if (!existsSync(storeRoot)) {
    throw new Error(`store root did not resolve (${storeRoot} absent) — cannot-read, not empty`);
  }
  assertSubstoreReadable(paths.taskDir);
  assertSubstoreReadable(join(paths.approvalDir, 'pending'));

  const approvals: UnifiedPendingItem[] = listPendingApprovals(paths).map((a) => ({
    source: 'approval',
    id: a.id,
    title: a.title,
    status: a.status,
    created_at: a.created_at,
    org: a.org,
    agent: a.requesting_agent,
    category: a.category,
    description: a.description,
  }));

  const flagged: UnifiedPendingItem[] = listTasks(paths, {})
    .filter((t) => t.needs_approval === true && UNRESOLVED_FLAGGED_STATUSES.has(t.status))
    .map((t) => ({
      source: 'flagged_task',
      id: t.id,
      title: t.title,
      status: t.status,
      created_at: t.created_at,
      org: t.org,
      agent: t.assigned_to,
      category: 'needs-approval-task',
      description: t.description,
    }));

  return [...approvals, ...flagged].sort(
    (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime(),
  );
}
