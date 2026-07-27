import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { listPendingApprovalsUnified } from '../../../src/bus/pending-approvals';
import type { BusPaths, Task, Approval, TaskStatus } from '../../../src/types';

/**
 * Fixtures nest taskDir/approvalDir under a shared orgBase, matching real
 * resolvePaths (taskDir = orgBase/tasks, approvalDir = orgBase/approvals) so
 * that dirname(taskDir) is the resolvability root the function asserts on.
 */
function mkPaths(root: string): BusPaths {
  const orgBase = join(root, 'orgs', 'testorg');
  return {
    ctxRoot: root,
    inbox: join(root, 'inbox', 'agent1'),
    inflight: join(root, 'inflight', 'agent1'),
    processed: join(root, 'processed', 'agent1'),
    logDir: join(root, 'logs', 'agent1'),
    stateDir: join(root, 'state', 'agent1'),
    taskDir: join(orgBase, 'tasks'),
    approvalDir: join(orgBase, 'approvals'),
    analyticsDir: join(orgBase, 'analytics'),
    heartbeatDir: join(root, 'heartbeats'),
  } as BusPaths;
}

function writeTask(paths: BusPaths, o: Partial<Task> & { id: string }): void {
  const now = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
  const task: Task = {
    id: o.id,
    title: o.title ?? 'Task',
    description: o.description ?? '',
    type: o.type ?? 'agent',
    needs_approval: o.needs_approval ?? false,
    status: o.status ?? 'pending',
    assigned_to: o.assigned_to ?? 'research',
    created_by: o.created_by ?? 'steven',
    org: o.org ?? 'testorg',
    priority: o.priority ?? 'normal',
    project: o.project ?? 'GOTM',
    kpi_key: o.kpi_key ?? null,
    created_at: o.created_at ?? now,
    updated_at: o.updated_at ?? now,
    completed_at: o.completed_at ?? null,
    due_date: o.due_date ?? null,
    archived: o.archived ?? false,
  };
  writeFileSync(join(paths.taskDir, `${task.id}.json`), JSON.stringify(task));
}

function writeApproval(paths: BusPaths, o: Partial<Approval> & { id: string }): void {
  const now = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
  const approval: Approval = {
    id: o.id,
    title: o.title ?? 'Approval',
    requesting_agent: o.requesting_agent ?? 'engineer',
    org: o.org ?? 'testorg',
    category: o.category ?? 'deployment',
    status: o.status ?? 'pending',
    description: o.description ?? '',
    created_at: o.created_at ?? now,
    updated_at: o.updated_at ?? now,
    resolved_at: o.resolved_at ?? null,
    resolved_by: o.resolved_by ?? null,
  };
  writeFileSync(join(paths.approvalDir, 'pending', `${approval.id}.json`), JSON.stringify(approval));
}

describe('listPendingApprovalsUnified', () => {
  let testDir: string;
  let paths: BusPaths;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'cortextos-unified-appr-'));
    paths = mkPaths(testDir);
    // Root (orgBase) + both substores created = a resolved, populated-or-empty store.
    mkdirSync(paths.taskDir, { recursive: true });
    mkdirSync(join(paths.approvalDir, 'pending'), { recursive: true });
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it('unions pending approval objects with unresolved needs_approval tasks', () => {
    writeApproval(paths, { id: 'appr_1', title: 'Deploy to prod', requesting_agent: 'engineer' });
    writeTask(paths, { id: 'task_flag_pending', needs_approval: true, status: 'pending', assigned_to: 'research', title: 'GOTM outreach' });
    writeTask(paths, { id: 'task_flag_inprog', needs_approval: true, status: 'in_progress', assigned_to: 'analyst', title: 'Backlink outreach' });
    writeTask(paths, { id: 'task_flag_blocked', needs_approval: true, status: 'blocked', assigned_to: 'research', title: 'Blocked outreach' });

    const items = listPendingApprovalsUnified(paths);

    expect(items).toHaveLength(4);
    const bySource = (s: string) => items.filter((i) => i.source === s);
    expect(bySource('approval')).toHaveLength(1);
    expect(bySource('flagged_task')).toHaveLength(3);

    const appr = items.find((i) => i.id === 'appr_1')!;
    expect(appr.source).toBe('approval');
    expect(appr.agent).toBe('engineer');

    const flagged = items.find((i) => i.id === 'task_flag_inprog')!;
    expect(flagged.source).toBe('flagged_task');
    expect(flagged.agent).toBe('analyst'); // assigned_to surfaced as agent
    expect(flagged.status).toBe('in_progress');
    expect(flagged.category).toBe('needs-approval-task');
  });

  it('excludes tasks that are not flagged, and flagged tasks in a resolved state', () => {
    writeTask(paths, { id: 'task_unflagged', needs_approval: false, status: 'pending' });
    writeTask(paths, { id: 'task_flag_completed', needs_approval: true, status: 'completed' as TaskStatus });
    writeTask(paths, { id: 'task_flag_cancelled', needs_approval: true, status: 'cancelled' as TaskStatus });
    writeTask(paths, { id: 'task_flag_live', needs_approval: true, status: 'pending' });

    const items = listPendingApprovalsUnified(paths);

    expect(items).toHaveLength(1);
    expect(items[0].id).toBe('task_flag_live');
  });

  it('returns EMPTY (not throw) when the store root resolved but substores are absent', () => {
    // Fresh org: orgBase exists, but tasks/ and approvals/pending were never created.
    const freshDir = mkdtempSync(join(tmpdir(), 'cortextos-unified-fresh-'));
    try {
      const fresh = mkPaths(freshDir);
      mkdirSync(join(freshDir, 'orgs', 'testorg'), { recursive: true }); // root only
      expect(listPendingApprovalsUnified(fresh)).toEqual([]);
    } finally {
      rmSync(freshDir, { recursive: true, force: true });
    }
  });

  it('THROWS cannot-read when the store root did not resolve (a false all-clear otherwise)', () => {
    // orgBase absent entirely = bad path/instance/org. Must NOT read as empty.
    const badDir = mkdtempSync(join(tmpdir(), 'cortextos-unified-bad-'));
    try {
      const bad = mkPaths(badDir); // orgBase never created
      expect(() => listPendingApprovalsUnified(bad)).toThrow(/store root did not resolve/);
    } finally {
      rmSync(badDir, { recursive: true, force: true });
    }
  });
});
