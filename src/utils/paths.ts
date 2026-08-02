import { homedir } from 'os';
import { join } from 'path';
import type { BusPaths } from '../types/index.js';
import { validateInstanceId } from './validate.js';

/**
 * Single source of truth for ctxRoot resolution.
 *
 * Both resolvePaths (below) and resolveEnv (env.ts) MUST route through this so
 * the two cannot diverge on the CTX_ROOT override. Before 2026-08-02 they did:
 * resolveEnv honoured process.env.CTX_ROOT while resolvePaths ignored it and
 * hardcoded join(homedir(), '.cortextos', instanceId). A caller who set
 * CTX_ROOT expecting isolation got it from resolveEnv and NOT from resolvePaths,
 * so writes landed in the LIVE store while every visible signal said isolated
 * (task_1785666893799). tests/isolate-home.setup.ts had to redirect HOME to
 * work around it. Sharing one function makes future divergence impossible by
 * construction rather than by everyone remembering to read the same env var.
 *
 * Precedence mirrors resolveEnv exactly:
 *   process.env.CTX_ROOT > envFileCtxRoot > join(homedir(), '.cortextos', id)
 * envFileCtxRoot is the .cortextos-env value, which only resolveEnv reads (it is
 * cwd-scoped); resolvePaths passes nothing and gets the process-env / derived
 * tiers. No validation here — resolveEnv does not validate instanceId on this
 * path, and resolvePaths/getIpcPath validate separately before calling.
 */
export function resolveCtxRoot(instanceId: string = 'default', envFileCtxRoot?: string): string {
  return process.env.CTX_ROOT || envFileCtxRoot || join(homedir(), '.cortextos', instanceId);
}

/**
 * Resolve all bus paths for an agent.
 * Mirrors the path resolution in bash _ctx-env.sh.
 *
 * The directory layout is:
 *   ~/.cortextos/{instance}/
 *     config/                - enabled-agents.json
 *     state/{agent}/         - flat, per-agent subdirs
 *     state/{agent}/heartbeat.json - canonical heartbeat location
 *     state/oauth/           - OAuth accounts.json (token store)
 *     state/usage/           - Usage monitoring snapshots
 *     inbox/{agent}/         - flat (not org-nested)
 *     inflight/{agent}/      - flat
 *     processed/{agent}/     - flat
 *     outbox/{agent}/        - flat
 *     logs/{agent}/          - flat
 *     orgs/{org}/tasks/      - org-scoped
 *     orgs/{org}/approvals/  - org-scoped
 *     orgs/{org}/analytics/  - org-scoped
 */
export function resolvePaths(
  agentName: string,
  instanceId: string = 'default',
  org?: string,
): BusPaths {
  validateInstanceId(instanceId);
  const ctxRoot = resolveCtxRoot(instanceId);

  // Org-scoped paths for tasks, approvals, analytics
  const orgBase = org ? join(ctxRoot, 'orgs', org) : ctxRoot;

  return {
    ctxRoot,
    inbox: join(ctxRoot, 'inbox', agentName),
    inflight: join(ctxRoot, 'inflight', agentName),
    processed: join(ctxRoot, 'processed', agentName),
    logDir: join(ctxRoot, 'logs', agentName),
    stateDir: join(ctxRoot, 'state', agentName),
    taskDir: join(orgBase, 'tasks'),
    approvalDir: join(orgBase, 'approvals'),
    analyticsDir: join(orgBase, 'analytics'),
    deliverablesDir: join(orgBase, 'deliverables'),
  };
}

/**
 * Get the IPC socket path for daemon communication.
 * Unix domain socket on macOS/Linux, named pipe on Windows.
 */
export function getIpcPath(instanceId: string = 'default'): string {
  validateInstanceId(instanceId);
  if (process.platform === 'win32') {
    return `\\\\.\\pipe\\cortextos-${instanceId}`;
  }
  // Same ctxRoot authority as resolvePaths — a sandbox that sets CTX_ROOT gets
  // its socket in the sandbox too, and in production (CTX_ROOT == derived) this
  // is identical to the previous hardcoded path.
  return join(resolveCtxRoot(instanceId), 'daemon.sock');
}
