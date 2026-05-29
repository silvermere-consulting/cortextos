// Dynamic "today" digest data — aggregates events, tasks, PDFs, agent counts
// for the /today dashboard page. Default time range is today (00:00 Dubai → now);
// callers can override by passing explicit ISO bounds.

import { readdirSync, statSync, readFileSync, existsSync } from 'node:fs';
import { join, basename } from 'node:path';
import { db } from '@/lib/db';
import { getFrameworkRoot } from '@/lib/config';

const DUBAI_TZ = 'Asia/Dubai';

export type TodayRange = {
  label: string;
  fromIso: string;
  toIso: string;
};

export type TodayEvent = {
  id: string;
  timestamp: string;
  agent: string;
  org: string;
  type: string;
  category: string | null;
  severity: string;
  message: string | null;
  data: string | null;
};

export type TodayTask = {
  id: string;
  title: string;
  assignee: string | null;
  org: string;
  project: string | null;
  status: string;
  completed_at: string | null;
  updated_at: string | null;
  notes: string | null;
};

export type TodayDeliverable = {
  filename: string;
  relPath: string;
  absPath: string;
  org: string;
  project: string;
  agent: string | null;
  sizeBytes: number;
  modifiedAtIso: string;
};

export type AgentActivity = {
  agent: string;
  events: number;
  taskCompletions: number;
  lastEventAt: string | null;
};

export type BankedRule = {
  agent: string;
  org: string;
  title: string;
  description: string;
  relPath: string;
};

export function rangeFor(kind: 'today' | 'yesterday' | 'this-week' | 'custom', custom?: { from: string; to: string }): TodayRange {
  if (kind === 'custom' && custom) {
    return { label: 'Custom', fromIso: custom.from, toIso: custom.to };
  }
  const now = new Date();
  const dubaiYmd = new Intl.DateTimeFormat('en-CA', { timeZone: DUBAI_TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
  const [year, month, day] = dubaiYmd.split('-').map(Number);
  // Dubai midnight as ISO with +04:00 offset → JS Date in UTC
  const dubaiMidnight = new Date(Date.UTC(year, month - 1, day, 0, 0, 0) - 4 * 60 * 60 * 1000);

  if (kind === 'yesterday') {
    const yStart = new Date(dubaiMidnight.getTime() - 24 * 60 * 60 * 1000);
    const yEnd = new Date(dubaiMidnight.getTime() - 1);
    return { label: 'Yesterday', fromIso: yStart.toISOString(), toIso: yEnd.toISOString() };
  }
  if (kind === 'this-week') {
    // Monday-anchored Dubai week
    const dayOfWeek = new Date(year, month - 1, day).getUTCDay() || 7;
    const weekStart = new Date(dubaiMidnight.getTime() - (dayOfWeek - 1) * 24 * 60 * 60 * 1000);
    return { label: 'This week', fromIso: weekStart.toISOString(), toIso: now.toISOString() };
  }
  return { label: 'Today', fromIso: dubaiMidnight.toISOString(), toIso: now.toISOString() };
}

export function getTodayEvents(range: TodayRange, org?: string, limit = 500): TodayEvent[] {
  const conditions = ['timestamp >= ?', 'timestamp <= ?'];
  const params: (string | number)[] = [range.fromIso, range.toIso];
  if (org) {
    conditions.push('org = ?');
    params.push(org);
  }
  try {
    const rows = db
      .prepare(`SELECT id, timestamp, agent, org, type, category, severity, message, data
         FROM events WHERE ${conditions.join(' AND ')}
         ORDER BY timestamp DESC LIMIT ?`)
      .all(...params, limit) as TodayEvent[];
    return rows;
  } catch {
    return [];
  }
}

export function getTodayCompletedTasks(range: TodayRange, org?: string): TodayTask[] {
  const conditions = ['status = ?', 'completed_at >= ?', 'completed_at <= ?'];
  const params: (string | number)[] = ['completed', range.fromIso, range.toIso];
  if (org) {
    conditions.push('org = ?');
    params.push(org);
  }
  try {
    const rows = db
      .prepare(`SELECT id, title, assignee, org, project, status, completed_at, updated_at, notes
         FROM tasks WHERE ${conditions.join(' AND ')}
         ORDER BY completed_at DESC`)
      .all(...params) as TodayTask[];
    return rows;
  } catch {
    return [];
  }
}

// Walk orgs/{org}/ for *.pdf files modified within the range.
// Bounded depth + ignores node_modules/dist/.git for speed.
export function getTodayDeliverables(range: TodayRange, org = 'silvermere-tech'): TodayDeliverable[] {
  const root = join(getFrameworkRoot(), 'orgs', org);
  if (!existsSync(root)) return [];
  const fromMs = new Date(range.fromIso).getTime();
  const toMs = new Date(range.toIso).getTime();
  const out: TodayDeliverable[] = [];
  const SKIP = new Set(['node_modules', 'dist', '.next', '.git', 'venv', 'workspace']);
  function walk(dir: string, depth: number) {
    if (depth > 5) return;
    let entries: import('node:fs').Dirent[];
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.name.startsWith('.')) continue;
      if (SKIP.has(e.name)) continue;
      const p = join(dir, e.name);
      if (e.isDirectory()) {
        walk(p, depth + 1);
      } else if (e.isFile() && e.name.toLowerCase().endsWith('.pdf')) {
        let st;
        try { st = statSync(p); } catch { continue; }
        const m = st.mtimeMs;
        if (m >= fromMs && m <= toMs) {
          const relPath = p.slice(root.length + 1);
          const segments = relPath.split('/');
          const project = segments[0] === 'projects' && segments[1] ? segments[1]
            : segments[0] === 'research' ? 'research'
            : segments[0] === 'agents' && segments[1] ? `agent:${segments[1]}`
            : segments[0] ?? 'other';
          const agentMatch = relPath.match(/agents\/([^/]+)\//);
          out.push({
            filename: e.name,
            relPath,
            absPath: p,
            org,
            project,
            agent: agentMatch ? agentMatch[1] : null,
            sizeBytes: st.size,
            modifiedAtIso: new Date(m).toISOString(),
          });
        }
      }
    }
  }
  walk(root, 0);
  out.sort((a, b) => b.modifiedAtIso.localeCompare(a.modifiedAtIso));
  return out;
}

export function getAgentActivity(range: TodayRange, org?: string): AgentActivity[] {
  const conditions = ['timestamp >= ?', 'timestamp <= ?'];
  const params: (string | number)[] = [range.fromIso, range.toIso];
  if (org) {
    conditions.push('org = ?');
    params.push(org);
  }
  try {
    const eventRows = db
      .prepare(`SELECT agent, COUNT(*) AS events, MAX(timestamp) AS lastEventAt
         FROM events WHERE ${conditions.join(' AND ')}
         GROUP BY agent ORDER BY events DESC`)
      .all(...params) as { agent: string; events: number; lastEventAt: string | null }[];

    const taskConditions = ['status = ?', 'completed_at >= ?', 'completed_at <= ?'];
    const taskParams: (string | number)[] = ['completed', range.fromIso, range.toIso];
    if (org) {
      taskConditions.push('org = ?');
      taskParams.push(org);
    }
    const taskRows = db
      .prepare(`SELECT assignee AS agent, COUNT(*) AS taskCompletions
         FROM tasks WHERE ${taskConditions.join(' AND ')} AND assignee IS NOT NULL
         GROUP BY assignee`)
      .all(...taskParams) as { agent: string; taskCompletions: number }[];
    const taskMap = new Map(taskRows.map((r) => [r.agent, r.taskCompletions]));

    return eventRows.map((e) => ({
      agent: e.agent,
      events: e.events,
      taskCompletions: taskMap.get(e.agent) ?? 0,
      lastEventAt: e.lastEventAt,
    }));
  } catch {
    return [];
  }
}

// Heuristic: any markdown file under orgs/{org}/agents/{agent}/memory/ whose
// mtime falls within the range AND that contains "Banked" or "## $UTC" with
// a Memory.md add — for v0.1 we just surface MEMORY.md entries whose mtime is
// within range, parsed by top-level "## " sections.
export function getBankedRules(range: TodayRange, org = 'silvermere-tech'): BankedRule[] {
  const agentsRoot = join(getFrameworkRoot(), 'orgs', org, 'agents');
  if (!existsSync(agentsRoot)) return [];
  const fromMs = new Date(range.fromIso).getTime();
  const toMs = new Date(range.toIso).getTime();
  const out: BankedRule[] = [];
  let agentDirs: import('node:fs').Dirent[] = [];
  try { agentDirs = readdirSync(agentsRoot, { withFileTypes: true }); } catch { return []; }
  for (const ad of agentDirs) {
    if (!ad.isDirectory()) continue;
    const memPath = join(agentsRoot, ad.name, 'MEMORY.md');
    if (!existsSync(memPath)) continue;
    let st;
    try { st = statSync(memPath); } catch { continue; }
    if (st.mtimeMs < fromMs || st.mtimeMs > toMs) continue;
    let content = '';
    try { content = readFileSync(memPath, 'utf-8'); } catch { continue; }
    // Find "## " sections after a today-shaped date marker in the body
    const lines = content.split('\n');
    let i = 0;
    while (i < lines.length) {
      const line = lines[i];
      const m = line.match(/^##\s+(.+?)\s*(\(.+?\))?\s*$/);
      if (m) {
        const title = m[1].trim();
        // Heuristic: section was added recently if file mtime is in range
        // For v0.1 collect all H2 sections from today-modified MEMORY.md; UI shows file mtime
        const descLines: string[] = [];
        let j = i + 1;
        while (j < lines.length && !lines[j].startsWith('## ')) {
          if (lines[j].trim()) descLines.push(lines[j].trim());
          j++;
          if (descLines.length >= 3) break;
        }
        out.push({
          agent: ad.name,
          org,
          title,
          description: descLines.join(' ').slice(0, 240),
          relPath: `agents/${ad.name}/MEMORY.md`,
        });
        i = j;
      } else {
        i++;
      }
    }
  }
  return out.slice(0, 50);
}

// Open Steven picks — v0.1 reads chief's daily memory file looking for an
// "## Open Steven queue" or "## Open" section. Manual curation is acceptable.
export function getOpenStevenPicks(org = 'silvermere-tech'): string[] {
  const today = new Date().toISOString().slice(0, 10);
  const memoryPath = join(getFrameworkRoot(), 'orgs', org, 'agents', 'chief', 'memory', `${today}.md`);
  if (!existsSync(memoryPath)) return [];
  let content = '';
  try { content = readFileSync(memoryPath, 'utf-8'); } catch { return []; }
  const lines = content.split('\n');
  const out: string[] = [];
  // Find any line that looks like "queue item": "- something" under a heading mentioning steven/queue/open
  let inQueueSection = false;
  for (const line of lines) {
    if (line.startsWith('## ')) {
      inQueueSection = /steven|queue|open|pending/i.test(line);
      continue;
    }
    if (inQueueSection && line.trim().startsWith('-')) {
      out.push(line.trim().replace(/^-\s*/, ''));
    }
    if (out.length >= 12) break;
  }
  return out;
}

export type TodayDigest = {
  range: TodayRange;
  events: TodayEvent[];
  tasks: TodayTask[];
  deliverables: TodayDeliverable[];
  agentActivity: AgentActivity[];
  bankedRules: BankedRule[];
  openPicks: string[];
  counts: {
    events: number;
    tasksCompleted: number;
    deliverables: number;
    activeAgents: number;
  };
};

export function getTodayDigest(opts: {
  kind?: 'today' | 'yesterday' | 'this-week' | 'custom';
  customFrom?: string;
  customTo?: string;
  org?: string;
} = {}): TodayDigest {
  const kind = opts.kind ?? 'today';
  const range = rangeFor(kind, opts.customFrom && opts.customTo ? { from: opts.customFrom, to: opts.customTo } : undefined);
  const org = opts.org ?? 'silvermere-tech';
  const events = getTodayEvents(range, org, 500);
  const tasks = getTodayCompletedTasks(range, org);
  const deliverables = getTodayDeliverables(range, org);
  const agentActivity = getAgentActivity(range, org);
  const bankedRules = getBankedRules(range, org);
  const openPicks = getOpenStevenPicks(org);
  return {
    range,
    events,
    tasks,
    deliverables,
    agentActivity,
    bankedRules,
    openPicks,
    counts: {
      events: events.length,
      tasksCompleted: tasks.length,
      deliverables: deliverables.length,
      activeAgents: agentActivity.length,
    },
  };
}
