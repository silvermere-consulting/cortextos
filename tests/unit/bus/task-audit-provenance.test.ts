import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { fileURLToPath } from 'url';
import {
  createTask,
  claimTask,
  updateTask,
  completeTask,
  readTaskAudit,
  AUDIT_SCHEMA_VERSION,
} from '../../../src/bus/task';
import type { BusPaths } from '../../../src/types';

/**
 * Provenance guard for the task audit log.
 *
 * The defect (pre-v2): updateTask and completeTask stamped the audit `agent`
 * with the task's assigned_to (the ASSIGNEE) instead of the calling agent (the
 * ACTOR). Because the fleet reads task history to decide who did what, that
 * laundered one agent's action into the owner's voice and made every task look
 * self-serviced. These controls pin the fix in every direction, and the schema
 * version (v) is the machine-readable cutover marker that travels per-row.
 */
describe('Task audit provenance (actor, not assignee)', () => {
  let testDir: string;
  let paths: BusPaths;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'cortextos-provenance-test-'));
    paths = {
      ctxRoot: testDir,
      inbox: join(testDir, 'inbox', 'x'),
      inflight: join(testDir, 'inflight', 'x'),
      processed: join(testDir, 'processed', 'x'),
      logDir: join(testDir, 'logs', 'x'),
      stateDir: join(testDir, 'state', 'x'),
      taskDir: join(testDir, 'tasks'),
      approvalDir: join(testDir, 'approvals'),
      analyticsDir: join(testDir, 'analytics'),
      heartbeatDir: join(testDir, 'heartbeats'),
    };
  });

  afterEach(() => { rmSync(testDir, { recursive: true, force: true }); });

  // Control (a): actor != assignee — the row must name the ACTOR. This is the
  // exact scenario the defect corrupted: a task owned by alice, acted on by bob.
  it('names the ACTOR when actor differs from assignee', () => {
    const id = createTask(paths, 'chief', 'acme', 'Owned by alice', { assignee: 'alice' });
    updateTask(paths, id, 'in_progress', 'bob');
    completeTask(paths, id, 'bob', 'done by bob');

    const log = readTaskAudit(paths, id);
    const update = log.find(e => e.event === 'update')!;
    const complete = log.find(e => e.event === 'complete')!;
    expect(update.agent).toBe('bob');
    expect(complete.agent).toBe('bob');
    // Negative: the assignee must NOT appear as the actor on these rows.
    expect(update.agent).not.toBe('alice');
    expect(complete.agent).not.toBe('alice');
  });

  // Control (b): actor == assignee — the row must still name the right agent.
  // Guards against a fix that "works" only because it stopped reading the
  // assignee at all (which would blank the agent in the self-service case).
  it('still names the agent when actor equals assignee', () => {
    const id = createTask(paths, 'chief', 'acme', 'Owned by alice', { assignee: 'alice' });
    updateTask(paths, id, 'in_progress', 'alice');
    completeTask(paths, id, 'alice', 'done by alice');

    const log = readTaskAudit(paths, id);
    expect(log.find(e => e.event === 'update')!.agent).toBe('alice');
    expect(log.find(e => e.event === 'complete')!.agent).toBe('alice');
  });

  // Control (c): a non-agent caller (the dashboard) must be recorded as itself,
  // never as the assignee and never as an invented agent. The CLI resolves the
  // dashboard's identity to the literal 'dashboard' (CTX_AGENT_NAME='dashboard')
  // and the "can't invent an agent" guarantee is enforced upstream by
  // refuseMintedIdentity on the update-task/complete-task commands; here we pin
  // that whatever actor the caller resolves to is what lands in the row.
  it('records a non-agent caller (dashboard) as the actor, not the assignee', () => {
    const id = createTask(paths, 'chief', 'acme', 'Owned by alice', { assignee: 'alice' });
    updateTask(paths, id, 'in_progress', 'dashboard');
    completeTask(paths, id, 'dashboard', 'closed from dashboard');

    const log = readTaskAudit(paths, id);
    const update = log.find(e => e.event === 'update')!;
    const complete = log.find(e => e.event === 'complete')!;
    expect(update.agent).toBe('dashboard');
    expect(complete.agent).toBe('dashboard');
    expect(update.agent).not.toBe('alice');
    expect(complete.agent).not.toBe('alice');
  });

  // Control (d): every newly written row carries the current schema version.
  it('stamps v:AUDIT_SCHEMA_VERSION on newly written rows', () => {
    const id = createTask(paths, 'chief', 'acme', 'Versioned');
    updateTask(paths, id, 'in_progress', 'bob');

    for (const e of readTaskAudit(paths, id)) {
      expect(e.v).toBe(AUDIT_SCHEMA_VERSION);
    }
  });

  // Control (e): exercise EVERY audit-emitting write path and assert zero
  // v-less rows. This is what proves the version stamp is not skipped on any
  // event type — a v-less row after the cutover is the read-time LOUD anomaly,
  // so no legitimate write path may ever produce one.
  it('every write path (create/claim/update/complete) produces a versioned row — zero v-less', () => {
    const id = createTask(paths, 'chief', 'acme', 'All paths', { assignee: 'bob' });
    claimTask(paths, id, 'bob');
    updateTask(paths, id, 'blocked', 'bob');
    updateTask(paths, id, 'in_progress', 'bob');
    completeTask(paths, id, 'bob', 'shipped');

    const log = readTaskAudit(paths, id);
    // All four event kinds are present — we really did hit every writer.
    expect(new Set(log.map(e => e.event))).toEqual(
      new Set(['create', 'claim', 'update', 'complete']),
    );
    const vless = log.filter(e => e.v === undefined);
    expect(vless).toEqual([]);
  });

  // Structural proof: appendTaskAudit is the SOLE writer of the audit log.
  // The per-row controls above only hold if nothing bypasses the chokepoint,
  // so we assert at the source level that exactly one write call targets the
  // audit path, and it lives inside appendTaskAudit. If a second writer is
  // ever added, this flips red and the "v-less == bypass" reasoning is restored
  // by forcing the new writer through the chokepoint (or updating this proof).
  it('STRUCTURAL: appendTaskAudit is the only writer to the audit log', () => {
    const srcPath = fileURLToPath(new URL('../../../src/bus/task.ts', import.meta.url));
    const lines = readFileSync(srcPath, 'utf-8').split('\n');

    const writeCall = /\b(appendFileSync|writeFileSync|atomicWriteSync|writeSync|createWriteStream)\s*\(/;
    const auditWriters = lines
      .map((line, idx) => ({ line, idx }))
      .filter(({ line }) => writeCall.test(line) && /audit/i.test(line));

    // Exactly one write call site touches the audit path.
    expect(auditWriters.length).toBe(1);

    // ...and it sits inside appendTaskAudit's body (between its declaration and
    // the next top-level export).
    const fnStart = lines.findIndex(l => l.includes('export function appendTaskAudit'));
    expect(fnStart).toBeGreaterThanOrEqual(0);
    const afterFn = lines
      .slice(fnStart + 1)
      .findIndex(l => /^export (function|const|interface|class) /.test(l));
    const fnEnd = afterFn === -1 ? lines.length : fnStart + 1 + afterFn;

    expect(auditWriters[0].idx).toBeGreaterThan(fnStart);
    expect(auditWriters[0].idx).toBeLessThan(fnEnd);
  });
});
