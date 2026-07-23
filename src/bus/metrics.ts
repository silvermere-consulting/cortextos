/**
 * Observability & Metrics Module
 * Node.js equivalent of bash collect-metrics.sh, scrape-usage.sh, check-upstream.sh
 */

import { existsSync, readFileSync, writeFileSync, appendFileSync, readdirSync, mkdirSync } from 'fs';
import { join, basename, dirname } from 'path';
import { execSync } from 'child_process';
import { ensureDir } from '../utils/atomic.js';
import { isHeartbeatStale } from '../utils/heartbeat-staleness.js';
import { collectAgentMemory, collectSessionPss, type MemorySnapshot } from './agent-memory.js';
import {
  appendHistory, collectSessionKeys, evaluateAllSlopes, slopeThresholdsFromEnv,
  type SlopeVerdict,
} from './memory-slope.js';

// --- Types ---

export interface AgentMetrics {
  tasks_completed: number;
  tasks_pending: number;
  tasks_in_progress: number;
  errors_today: number;
  /**
   * Real compaction count — number of `metric/compaction_started` events
   * emitted by hook-compact-telegram on PreCompact for this agent today.
   * Replaces the audit-retired log-grep proxy which counted occurrences of
   * the literal word "compact" in stdout and drifted arbitrarily (~1700 vs
   * reality ~0). See utils audit-doc row #2.
   */
  compactions_today: number;
  heartbeat_stale: boolean;
}

/**
 * Host disk usage for a single mount, captured at collect-metrics time so the
 * nightly report carries a disk trend and a >85% blind-spot can be surfaced as
 * an anomaly. Added after the 2026-06-20 disk-pressure incident (/ hit 96%
 * while collect-metrics had no disk field at all). Sizes are GiB (binary,
 * matching `df -h`) rounded to 1 decimal.
 */
export interface DiskMetrics {
  mount: string;
  percent_used: number;
  used_gb: number;
  free_gb: number;
  total_gb: number;
}

export interface SystemMetrics {
  total_tasks_completed: number;
  agents_healthy: number;
  agents_total: number;
  approvals_pending: number;
  /** Root-filesystem usage. Optional so old reports / df failures don't break consumers. */
  disk?: DiskMetrics;
  /** Per-agent RSS + RAM headroom (OOM monitor). Optional so old reports / non-Linux don't break consumers. */
  memory?: MemorySnapshot;
  /** Per-agent RSS slope verdicts (leak = a SLOPE, not a LEVEL; identity-free). Optional as above. */
  memory_slope?: SlopeVerdict[];
  /** Box-level orphaned agent-browser chrome (PPID==1). Optional so old reports / non-Linux don't break consumers. */
  orphan_browser?: OrphanBrowserMetrics;
}

/**
 * Box-level orphaned browser processes — chrome/chromium/headless_shell trees
 * that agent-browser/Playwright leaked when an agent session died mid-run, so
 * they reparented to init (PPID==1). They are invisible to per-agent RSS
 * attribution (no owning agent), which is the monitor blind spot this closes.
 * The orphan-chrome-reaper timer auto-kills them every 30min; this line just
 * gives collect-metrics visibility of what is currently orphaned.
 */
export interface OrphanBrowserMetrics {
  /** Count of orphaned (PPID==1) chrome-family processes at collect time. */
  orphan_count: number;
  /** Total RSS (MB, 1-decimal) held by those orphaned processes. */
  rss_mb: number;
}

/** Disk usage at/above this percent is surfaced as an anomaly at collect time. */
export const DISK_ALERT_THRESHOLD = 85;

/**
 * Tiered classification the analyst's routing keys off. Mirrors the agreed
 * spec (2026-06-20): 85< warning, 92< elevated, 97< critical. Only the
 * `critical` tier is Steven-eligible on the analyst side.
 */
export interface DiskAnomaly {
  severity: 'warning' | 'critical';
  tier: 'warning' | 'elevated' | 'critical';
  disk: DiskMetrics;
}

export interface MetricsReport {
  timestamp: string;
  agents: Record<string, AgentMetrics>;
  system: SystemMetrics;
}

export interface UsageData {
  agent: string;
  timestamp: string;
  session: { used_pct: number; resets: string };
  week_all_models: { used_pct: number; resets: string };
  week_sonnet: { used_pct: number };
}

export interface CatalogAddition {
  name: string;
  type: string;
  description?: string;
  tags?: string[];
}

export interface UpstreamResult {
  status: string;
  commits?: number;
  diff_stat?: string;
  commit_log?: string;
  changes?: {
    bus: string[];
    scripts: string[];
    templates: string[];
    skills: string[];
    community: string[];
    other: string[];
  };
  catalog_additions?: CatalogAddition[];
  message?: string;
  error?: string;
  hint?: string;
}

export interface RegisterCommandsResult {
  status: string;
  count: number;
  commands: { command: string; description: string }[];
  error?: string;
}

// --- collectMetrics ---

/**
 * Decide whether a single JSONL event line should be counted as an error
 * for the daily errors_today metric. Returns false on malformed JSON
 * rather than throwing — bad lines should not break the report.
 *
 * An event qualifies only when BOTH:
 *   - category === 'error', AND
 *   - severity ∈ {'error', 'critical'}
 * 'warning' is intentionally not counted toward errors_today; it has its
 * own meaning in the severity ladder. 'info' events with category=error
 * (the original false-positive class) are filtered out here.
 */
function isErrorEvent(line: string): boolean {
  let evt: { category?: unknown; severity?: unknown };
  try {
    evt = JSON.parse(line);
  } catch {
    return false;
  }
  if (evt.category !== 'error') return false;
  return evt.severity === 'error' || evt.severity === 'critical';
}

/**
 * Decide whether a JSONL event line is a compaction-started event from the
 * PreCompact hook. Counts only ground-truth fires — the previous log-grep
 * proxy counted the status-line UI text "compact" and drifted by orders of
 * magnitude. See audit doc row #2.
 */
function isCompactionEvent(line: string): boolean {
  let evt: { category?: unknown; event?: unknown };
  try {
    evt = JSON.parse(line);
  } catch {
    return false;
  }
  return evt.category === 'metric' && evt.event === 'compaction_started';
}

/**
 * Parse the output of `df -P -k <mount>` into a DiskMetrics. Pure (no IO) so it
 * is unit-testable without spawning df. `-P` guarantees the POSIX one-data-line
 * format (no wrapping); `-k` gives 1024-byte blocks. Returns null if the output
 * has no parseable data row.
 */
export function parseDfKOutput(output: string, mount: string): DiskMetrics | null {
  const lines = output
    .split('\n')
    .map(l => l.trim())
    .filter(l => l && !l.startsWith('Filesystem'));
  if (lines.length === 0) return null;

  // Fields: Filesystem 1024-blocks Used Available Capacity Mounted-on
  const fields = lines[lines.length - 1].split(/\s+/);
  if (fields.length < 6) return null;

  const totalKib = Number(fields[1]);
  const usedKib = Number(fields[2]);
  const freeKib = Number(fields[3]);
  const percent = parseInt(fields[4].replace('%', ''), 10);
  if (!Number.isFinite(totalKib) || !Number.isFinite(usedKib) || !Number.isFinite(freeKib) || !Number.isFinite(percent)) {
    return null;
  }

  const toGib = (kib: number): number => Math.round((kib / 1024 / 1024) * 10) / 10;
  return {
    mount,
    percent_used: percent,
    used_gb: toGib(usedKib),
    free_gb: toGib(freeKib),
    total_gb: toGib(totalKib),
  };
}

/**
 * Capture disk usage for a mount via `df -P -k`. Best-effort: returns null if
 * df fails or output is unparseable — a disk read must never break the report.
 */
export function collectDiskMetrics(mount = '/'): DiskMetrics | null {
  try {
    const out = execSync(`df -P -k ${mount}`, { encoding: 'utf-8', timeout: 5000 });
    return parseDfKOutput(out, mount);
  } catch {
    return null;
  }
}

/**
 * True for a `ps comm` value that is an agent-browser chrome-family process.
 * Mirrors the orphan-chrome-reaper.sh comm set (chrome / chromium /
 * chromium-browser / headless_shell / chrome_crashpad_handler). Uses a
 * startsWith for the crashpad handler because `ps comm` truncates to 15 chars
 * (TASK_COMM_LEN), so `chrome_crashpad_handler` arrives as `chrome_crashpad`.
 */
function isOrphanBrowserComm(comm: string): boolean {
  return (
    comm === 'chrome' ||
    comm === 'chromium' ||
    comm === 'chromium-browser' ||
    comm === 'headless_shell' ||
    comm.startsWith('chrome_crashpad')
  );
}

/**
 * Parse `ps -eo pid=,ppid=,rss=,comm=` output into an OrphanBrowserMetrics.
 * Counts chrome-family processes reparented to init (PPID==1) and sums their
 * RSS. Pure (no IO) so it is unit-testable without spawning ps. Mirrors the
 * orphan-chrome-reaper's detection (comm set + PPID==1) so the metric and the
 * reaper agree on what "orphaned browser" means; the reaper's 3-min age guard
 * is a kill-safety measure and is deliberately NOT applied here — the metric
 * reports current orphan RSS at collect time.
 */
export function parseOrphanChromeRss(output: string): OrphanBrowserMetrics {
  let orphan_count = 0;
  let rssKb = 0;
  for (const line of output.split('\n')) {
    const f = line.trim().split(/\s+/);
    if (f.length < 4) continue;
    const ppid = f[1];
    const rss = f[2];
    const comm = f[3];
    if (ppid !== '1') continue;
    if (!isOrphanBrowserComm(comm)) continue;
    const kb = Number(rss);
    if (!Number.isFinite(kb)) continue;
    orphan_count += 1;
    rssKb += kb;
  }
  return { orphan_count, rss_mb: Math.round((rssKb / 1024) * 10) / 10 };
}

/**
 * Capture box-level orphaned-browser RSS via `ps`. Best-effort: returns null if
 * ps fails or is absent (non-Linux) — a process scan must never break the report.
 */
export function collectOrphanBrowserMetrics(): OrphanBrowserMetrics | null {
  try {
    const out = execSync('ps -eo pid=,ppid=,rss=,comm=', { encoding: 'utf-8', timeout: 5000 });
    return parseOrphanChromeRss(out);
  } catch {
    return null;
  }
}

/**
 * Classify a DiskMetrics into a tiered anomaly, or null if below threshold.
 * Pure — this is the load-bearing tier logic the analyst's routing depends on.
 *   85 < p <= 92  -> warning  / warning
 *   92 < p <= 97  -> warning  / elevated
 *        p  > 97  -> critical / critical
 */
export function evaluateDiskAnomaly(disk: DiskMetrics | null | undefined): DiskAnomaly | null {
  if (!disk) return null;
  const p = disk.percent_used;
  if (p <= DISK_ALERT_THRESHOLD) return null;
  if (p > 97) return { severity: 'critical', tier: 'critical', disk };
  if (p > 92) return { severity: 'warning', tier: 'elevated', disk };
  return { severity: 'warning', tier: 'warning', disk };
}

export function collectMetrics(ctxRoot: string, org?: string): MetricsReport {
  const timestamp = new Date().toISOString();
  const today = timestamp.split('T')[0];

  const enabledFile = join(ctxRoot, 'config', 'enabled-agents.json');
  let agentNames: string[] = [];
  if (existsSync(enabledFile)) {
    try {
      agentNames = Object.keys(JSON.parse(readFileSync(enabledFile, 'utf-8')));
    } catch { /* empty */ }
  }

  const agents: Record<string, AgentMetrics> = {};
  let totalCompleted = 0;
  let agentsHealthy = 0;
  const agentsTotal = agentNames.length;

  // Gather task directories
  const taskDirs: string[] = [];
  const tasksDir = join(ctxRoot, 'tasks');
  if (existsSync(tasksDir)) taskDirs.push(tasksDir);
  // Org-scoped tasks
  const orgsDir = join(ctxRoot, 'orgs');
  if (existsSync(orgsDir)) {
    try {
      for (const orgEntry of readdirSync(orgsDir, { withFileTypes: true })) {
        if (orgEntry.isDirectory()) {
          const orgTasks = join(orgsDir, orgEntry.name, 'tasks');
          if (existsSync(orgTasks)) taskDirs.push(orgTasks);
        }
      }
    } catch { /* ignore */ }
  }

  for (const agent of agentNames) {
    let completed = 0, pending = 0, inProgress = 0;

    // Count tasks by status
    for (const taskDir of taskDirs) {
      try {
        for (const file of readdirSync(taskDir)) {
          if (!file.endsWith('.json')) continue;
          try {
            const task = JSON.parse(readFileSync(join(taskDir, file), 'utf-8'));
            if (task.assigned_to !== agent) continue;
            switch (task.status) {
              case 'completed': completed++; break;
              case 'pending': pending++; break;
              case 'in_progress': inProgress++; break;
            }
          } catch { /* skip bad files */ }
        }
      } catch { /* skip bad dirs */ }
    }
    totalCompleted += completed;

    // Count errors today from event logs.
    // Both category AND severity must match — early agents emitted
    // category=error events at severity=info for things like
    // `gap_detector_false_positive` (Frank had 7 of these in a single day,
    // all classified as "errors" by the previous substring check). Filter
    // on parsed JSON to skip false positives that happen to contain
    // `"category":"error"` inside a metadata payload, and only count
    // events where severity is genuinely error-level.
    let errorsToday = 0;
    let compactionsToday = 0;
    const eventPaths = [
      join(ctxRoot, 'analytics', 'events', agent, `${today}.jsonl`),
    ];
    if (org) {
      eventPaths.push(join(ctxRoot, 'orgs', org, 'analytics', 'events', agent, `${today}.jsonl`));
    }
    for (const eventFile of eventPaths) {
      if (existsSync(eventFile)) {
        try {
          const lines = readFileSync(eventFile, 'utf-8').split('\n').filter(Boolean);
          for (const line of lines) {
            if (isErrorEvent(line)) errorsToday++;
            if (isCompactionEvent(line)) compactionsToday++;
          }
        } catch { /* skip */ }
      }
    }

    // Per-agent-interval-aware staleness — see utils/heartbeat-staleness.ts.
    // Stale if age > 2 × loop_interval (default 5h fallback if interval empty).
    let heartbeatStale = true;
    const hbFile = join(ctxRoot, 'state', agent, 'heartbeat.json');
    if (existsSync(hbFile)) {
      try {
        const hb = JSON.parse(readFileSync(hbFile, 'utf-8'));
        if (!isHeartbeatStale(hb.last_heartbeat, hb.loop_interval)) {
          heartbeatStale = false;
          agentsHealthy++;
        }
      } catch { /* stale by default */ }
    }

    agents[agent] = {
      tasks_completed: completed,
      tasks_pending: pending,
      tasks_in_progress: inProgress,
      errors_today: errorsToday,
      compactions_today: compactionsToday,
      heartbeat_stale: heartbeatStale,
    };
  }

  // Count pending approvals
  let approvalsPending = 0;
  const approvalPaths = [join(ctxRoot, 'approvals', 'pending')];
  if (existsSync(orgsDir)) {
    try {
      for (const orgEntry of readdirSync(orgsDir, { withFileTypes: true })) {
        if (orgEntry.isDirectory()) {
          const p = join(orgsDir, orgEntry.name, 'approvals', 'pending');
          if (existsSync(p)) approvalPaths.push(p);
        }
      }
    } catch { /* ignore */ }
  }
  for (const apDir of approvalPaths) {
    if (existsSync(apDir)) {
      try {
        approvalsPending += readdirSync(apDir).filter(f => f.endsWith('.json')).length;
      } catch { /* ignore */ }
    }
  }

  const disk = collectDiskMetrics('/');

  // Per-agent RSS + RAM headroom (OOM monitor — flag-only, see agent-memory.ts).
  // Best-effort: zeroed snapshot on non-Linux / read failure.
  const memory = collectAgentMemory('/proc');

  // Slope arm: sample into history, evaluate per-agent rise within the CURRENT
  // process session (see memory-slope.ts — identity-free, restart-aware by
  // construction). Best-effort: an IO failure here must never break the report.
  let memorySlope: SlopeVerdict[] = [];
  try {
    if (memory.agents.length) {
      const t = slopeThresholdsFromEnv();
      const sessionKeys = collectSessionKeys('/proc');
      // OBSERVE-ONLY (2026-07-23): session-pid PSS logged beside the tree-sum to
      // accumulate a recalibration window. Attached to the live snapshot for
      // visibility in latest.json and threaded into the history; NOTHING
      // evaluates it yet (evaluateSlope/evaluateMemoryAnomalies read rss_mb).
      const sessionPss = collectSessionPss(sessionKeys, '/proc');
      for (const a of memory.agents) {
        const pss = sessionPss.get(a.agent);
        if (pss != null) a.session_pss_mb = pss;
      }
      const history = appendHistory(ctxRoot, memory, sessionKeys, t, undefined, sessionPss);
      memorySlope = evaluateAllSlopes(history, memory, t);
    }
  } catch { /* slope is additive; never fatal */ }

  // Box-level orphaned agent-browser chrome (PPID==1) — invisible to per-agent
  // RSS attribution, so it's the monitor blind spot. The reaper auto-kills these;
  // this line gives visibility. Best-effort: null on non-Linux / ps failure.
  const orphanBrowser = collectOrphanBrowserMetrics();

  const report: MetricsReport = {
    timestamp,
    agents,
    system: {
      total_tasks_completed: totalCompleted,
      agents_healthy: agentsHealthy,
      agents_total: agentsTotal,
      approvals_pending: approvalsPending,
      ...(disk ? { disk } : {}),
      ...(memory.agents.length || memory.mem_total_mb ? { memory } : {}),
      ...(memorySlope.length ? { memory_slope: memorySlope } : {}),
      ...(orphanBrowser ? { orphan_browser: orphanBrowser } : {}),
    },
  };

  // Write to analytics reports
  const orgBase = org ? join(ctxRoot, 'orgs', org) : ctxRoot;
  const reportsDir = join(orgBase, 'analytics', 'reports');
  ensureDir(reportsDir);
  writeFileSync(join(reportsDir, 'latest.json'), JSON.stringify(report, null, 2) + '\n', 'utf-8');

  // Also write system-wide report if org-scoped
  if (org) {
    const systemReports = join(ctxRoot, 'analytics', 'reports');
    ensureDir(systemReports);
    writeFileSync(join(systemReports, 'latest.json'), JSON.stringify(report, null, 2) + '\n', 'utf-8');
  }

  return report;
}

// --- scrapeUsage ---

/**
 * Parse Claude Code /usage output text.
 * This is the parsing logic; the actual tmux interaction is handled by the daemon.
 */
export function parseUsageOutput(output: string, agentName: string): UsageData {
  const timestamp = new Date().toISOString();

  // Parse session percentage
  const sessionMatch = output.match(/Current session[\s\S]*?(\d+)%/);
  const sessionPct = sessionMatch ? parseInt(sessionMatch[1], 10) : 0;

  // Parse week all-models percentage
  const weekMatch = output.match(/Current week.*all[\s\S]*?(\d+)%/i);
  const weekPct = weekMatch ? parseInt(weekMatch[1], 10) : 0;

  // Parse week sonnet percentage
  const sonnetMatch = output.match(/Current week.*Sonnet[\s\S]*?(\d+)%/i);
  const sonnetPct = sonnetMatch ? parseInt(sonnetMatch[1], 10) : 0;

  // Parse reset times
  const sessionResetMatch = output.match(/Current session[\s\S]*?Resets\s+(.*)/);
  const sessionReset = sessionResetMatch ? sessionResetMatch[1].trim() : '';

  const weekResetMatch = output.match(/Current week.*all[\s\S]*?Resets\s+(.*)/i);
  const weekReset = weekResetMatch ? weekResetMatch[1].trim() : '';

  return {
    agent: agentName,
    timestamp,
    session: { used_pct: sessionPct, resets: sessionReset },
    week_all_models: { used_pct: weekPct, resets: weekReset },
    week_sonnet: { used_pct: sonnetPct },
  };
}

/**
 * Store scraped usage data to state files.
 */
export function storeUsageData(ctxRoot: string, data: UsageData): void {
  const usageDir = join(ctxRoot, 'state', 'usage');
  ensureDir(usageDir);

  // Write latest
  writeFileSync(join(usageDir, 'latest.json'), JSON.stringify(data, null, 2) + '\n', 'utf-8');

  // Append to daily log
  const today = data.timestamp.split('T')[0];
  const dailyPath = join(usageDir, `${today}.jsonl`);
  const line = JSON.stringify(data) + '\n';
  try {
    appendFileSync(dailyPath, line, 'utf-8');
  } catch {
    writeFileSync(dailyPath, line, 'utf-8');
  }
}

// --- checkUpstream ---

/**
 * Check for upstream framework updates.
 * This function performs git operations in the given directory.
 * Returns structured diff information for the agent to present.
 */
export function checkUpstream(
  frameworkRoot: string,
  options: { apply?: boolean } = {},
): UpstreamResult {
  const execOpts = { cwd: frameworkRoot, encoding: 'utf-8' as const, timeout: 30000 };

  // Check if it's a git repo
  try {
    execSync('git rev-parse --is-inside-work-tree', { ...execOpts, stdio: 'pipe' });
  } catch {
    return { status: 'error', error: 'not a git repository' };
  }

  // Check upstream remote
  try {
    execSync('git remote get-url upstream', { ...execOpts, stdio: 'pipe' });
  } catch {
    return { status: 'error', error: 'no upstream remote configured', hint: 'Run: git remote add upstream <canonical-repo-url>' };
  }

  // Fetch upstream
  try {
    execSync('git fetch upstream main', { ...execOpts, stdio: 'pipe' });
  } catch {
    return { status: 'error', error: 'failed to fetch upstream', hint: 'Check network and repo access' };
  }

  // Compare heads
  let localHead: string, upstreamHead: string;
  try {
    localHead = execSync('git rev-parse HEAD', { ...execOpts, stdio: 'pipe' }).trim();
    upstreamHead = execSync('git rev-parse upstream/main', { ...execOpts, stdio: 'pipe' }).trim();
  } catch {
    return { status: 'error', error: 'failed to resolve HEAD or upstream/main' };
  }

  if (localHead === upstreamHead) {
    return { status: 'up_to_date', message: 'No upstream changes available' };
  }

  // Count changes
  let commitCount = 0;
  try {
    commitCount = parseInt(execSync('git rev-list HEAD..upstream/main --count', { ...execOpts, stdio: 'pipe' }).trim(), 10);
  } catch { /* default 0 */ }

  let diffStat = '';
  try {
    const stat = execSync('git diff HEAD..upstream/main --stat', { ...execOpts, stdio: 'pipe' });
    const lines = stat.trim().split('\n');
    diffStat = lines[lines.length - 1] || '';
  } catch { /* ignore */ }

  // Categorize changed files
  let changedFiles: string[] = [];
  try {
    changedFiles = execSync('git diff HEAD..upstream/main --name-only', { ...execOpts, stdio: 'pipe' })
      .trim().split('\n').filter(Boolean);
  } catch { /* ignore */ }

  const changes = {
    bus: [] as string[],
    scripts: [] as string[],
    templates: [] as string[],
    skills: [] as string[],
    community: [] as string[],
    other: [] as string[],
  };

  for (const file of changedFiles) {
    if (file.startsWith('bus/')) changes.bus.push(file);
    else if (file.startsWith('scripts/')) changes.scripts.push(file);
    else if (file.startsWith('templates/')) changes.templates.push(file);
    else if (file.startsWith('skills/')) changes.skills.push(file);
    else if (file.startsWith('community/')) changes.community.push(file);
    else changes.other.push(file);
  }

  // Commit log
  let commitLog = '';
  try {
    commitLog = execSync('git log HEAD..upstream/main --oneline', { ...execOpts, stdio: 'pipe' }).trim();
  } catch { /* ignore */ }

  // Detect new catalog items in upstream vs local
  function getCatalogItems(source: 'local' | 'upstream'): CatalogAddition[] {
    try {
      let raw: string;
      if (source === 'upstream') {
        raw = execSync('git show upstream/main:community/catalog.json', { ...execOpts, stdio: 'pipe' });
      } else {
        const localPath = join(frameworkRoot, 'community', 'catalog.json');
        if (!existsSync(localPath)) return [];
        raw = readFileSync(localPath, 'utf-8');
      }
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed.items) ? parsed.items : [];
    } catch {
      return [];
    }
  }

  // If --apply: merge upstream
  if (options.apply) {
    if (process.env.CORTEXTOS_CONFIRM_UPSTREAM_MERGE !== 'yes') {
      return {
        status: 'error',
        error: 'Refusing to auto-merge upstream. Review the diff first (run without --apply), then re-run with CORTEXTOS_CONFIRM_UPSTREAM_MERGE=yes if you trust the changes.',
      };
    }
    const localItems = getCatalogItems('local');
    const localNames = new Set(localItems.map((i: CatalogAddition) => i.name));
    try {
      execSync('git merge upstream/main --no-edit', { ...execOpts, stdio: 'pipe' });
      // After merge, read updated catalog and surface new items
      const mergedItems = getCatalogItems('local');
      const catalog_additions = mergedItems.filter((i: CatalogAddition) => !localNames.has(i.name));
      return {
        status: 'merged',
        commits: commitCount,
        message: 'Upstream changes applied successfully',
        ...(catalog_additions.length > 0 ? { catalog_additions } : {}),
      };
    } catch {
      try { execSync('git merge --abort', { ...execOpts, stdio: 'pipe' }); } catch { /* ignore */ }
      return { status: 'conflict', message: 'Merge conflicts detected. Resolve conversationally with user.' };
    }
  }

  // Dry-run: surface new catalog items in upstream vs local
  const localItems = getCatalogItems('local');
  const localNames = new Set(localItems.map((i: CatalogAddition) => i.name));
  const upstreamItems = getCatalogItems('upstream');
  const catalog_additions = upstreamItems.filter((i: CatalogAddition) => !localNames.has(i.name));

  return {
    status: 'updates_available',
    commits: commitCount,
    diff_stat: diffStat,
    commit_log: commitLog,
    changes,
    ...(catalog_additions.length > 0 ? { catalog_additions } : {}),
  };
}

// --- registerTelegramCommands ---

/**
 * Scan directories for skills/commands, parse YAML frontmatter,
 * and build a list of Telegram bot commands to register.
 * The actual API call is separate (requires bot token).
 */
export function collectTelegramCommands(scanDirs: string[]): { command: string; description: string }[] {
  const seen = new Set<string>();
  const commands: { command: string; description: string }[] = [];

  for (const dir of scanDirs) {
    if (!existsSync(dir)) continue;

    const skillFiles = collectSkillFiles(dir);
    for (const file of skillFiles) {
      const parsed = parseSkillFrontmatter(file);
      if (!parsed) continue;
      if (parsed.userInvocable === false) continue;

      let name = parsed.name || deriveNameFromPath(file);
      if (!name) continue;

      const cmd = sanitizeCommand(name);
      if (!cmd || seen.has(cmd)) continue;
      seen.add(cmd);

      const description = (parsed.description || `Skill: ${name}`).slice(0, 256);
      commands.push({ command: cmd, description });
    }
  }

  return commands;
}

/**
 * Register commands with Telegram Bot API.
 */
export async function registerTelegramCommands(
  botToken: string,
  commands: { command: string; description: string }[],
): Promise<RegisterCommandsResult> {
  if (commands.length === 0) {
    return { status: 'empty', count: 0, commands: [], error: 'No commands found to register' };
  }

  try {
    // Register under all_private_chats scope so the / menu appears in private bot chats.
    // The default scope alone is insufficient — Telegram shows commands from the most
    // specific matching scope, and all_private_chats takes precedence over default.
    const response = await fetch(`https://api.telegram.org/bot${botToken}/setMyCommands`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ commands, scope: { type: 'all_private_chats' } }),
    });

    const data = await response.json() as { ok: boolean; description?: string };
    if (data.ok) {
      return { status: 'ok', count: commands.length, commands };
    } else {
      return { status: 'error', count: 0, commands, error: data.description || 'Failed to register commands with Telegram' };
    }
  } catch (err) {
    return { status: 'error', count: 0, commands, error: String(err) };
  }
}

// --- Internal helpers ---

function collectSkillFiles(dir: string): string[] {
  const files: string[] = [];

  // .claude/commands/*.md
  const cmdDir = join(dir, '.claude', 'commands');
  if (existsSync(cmdDir)) {
    try {
      for (const f of readdirSync(cmdDir)) {
        if (f.endsWith('.md')) files.push(join(cmdDir, f));
      }
    } catch { /* ignore */ }
  }

  // .codex/prompts/*.md and .codex/commands/*.md (issue #329)
  // Codex CLI exposes user prompts via `.codex/prompts/`; some templates also
  // ship a `.codex/commands/` dir mirroring the .claude convention. Both feed
  // the Telegram setMyCommands call so codex-runtime agents get a slash menu.
  for (const sub of ['prompts', 'commands']) {
    const codexDir = join(dir, '.codex', sub);
    if (existsSync(codexDir)) {
      try {
        for (const f of readdirSync(codexDir)) {
          if (f.endsWith('.md')) files.push(join(codexDir, f));
        }
      } catch { /* ignore */ }
    }
  }

  // .claude/skills/*/SKILL.md
  const claudeSkillsDir = join(dir, '.claude', 'skills');
  if (existsSync(claudeSkillsDir)) {
    try {
      for (const entry of readdirSync(claudeSkillsDir, { withFileTypes: true })) {
        if (entry.isDirectory()) {
          const skillFile = join(claudeSkillsDir, entry.name, 'SKILL.md');
          if (existsSync(skillFile)) files.push(skillFile);
        }
      }
    } catch { /* ignore */ }
  }

  // skills/*/SKILL.md
  const skillsDir = join(dir, 'skills');
  if (existsSync(skillsDir)) {
    try {
      for (const entry of readdirSync(skillsDir, { withFileTypes: true })) {
        if (entry.isDirectory()) {
          const skillFile = join(skillsDir, entry.name, 'SKILL.md');
          if (existsSync(skillFile)) files.push(skillFile);
        }
      }
    } catch { /* ignore */ }
  }

  return files;
}

function parseSkillFrontmatter(filePath: string): { name?: string; description?: string; userInvocable?: boolean } | null {
  try {
    const content = readFileSync(filePath, 'utf-8');
    const lines = content.split('\n');
    let inFrontmatter = false;
    let name: string | undefined;
    let description: string | undefined;
    let userInvocable: boolean | undefined;
    let readingMultiline = '';
    let multilineValue = '';

    for (const line of lines) {
      if (line.trim() === '---') {
        if (inFrontmatter) {
          // Flush multiline
          if (readingMultiline === 'description') description = multilineValue.trim();
          else if (readingMultiline === 'name') name = multilineValue.trim();
          break;
        }
        inFrontmatter = true;
        continue;
      }
      if (!inFrontmatter) continue;

      // Multi-line continuation
      if (readingMultiline && /^\s/.test(line)) {
        multilineValue += ' ' + line.trim();
        continue;
      } else if (readingMultiline) {
        if (readingMultiline === 'description') description = multilineValue.trim();
        else if (readingMultiline === 'name') name = multilineValue.trim();
        readingMultiline = '';
        multilineValue = '';
      }

      // Parse fields
      const nameMatch = line.match(/^name:\s*["']?(.+?)["']?\s*$/);
      if (nameMatch) { name = nameMatch[1]; continue; }

      const descMatch = line.match(/^description:\s*(.+)$/);
      if (descMatch) {
        const val = descMatch[1].trim().replace(/^["']|["']$/g, '');
        if (/^[>|]-?$/.test(val)) {
          readingMultiline = 'description';
          multilineValue = '';
        } else {
          description = val;
        }
        continue;
      }

      const invMatch = line.match(/^user-invocable:\s*(.+)$/);
      if (invMatch) {
        userInvocable = invMatch[1].trim() !== 'false';
      }
    }

    return { name, description, userInvocable };
  } catch {
    return null;
  }
}

function deriveNameFromPath(filePath: string): string {
  const base = basename(filePath);
  if (base === 'SKILL.md') {
    return basename(dirname(filePath));
  }
  return base.replace(/\.md$/, '');
}

function sanitizeCommand(name: string): string {
  return name.toLowerCase().replace(/-/g, '_').replace(/[^a-z0-9_]/g, '').slice(0, 32);
}
