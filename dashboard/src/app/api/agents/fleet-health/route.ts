import { promises as fs } from 'fs';
import path from 'path';
import os from 'os';

export const dynamic = 'force-dynamic';

const CONTEXT_LIMIT = 1_000_000;
const AMBER_THRESHOLD = 0.6;
const RED_THRESHOLD = 0.85;
const USAGE_STALE_MS = 10 * 60 * 1000;

export type HealthStatus = 'healthy' | 'stale' | 'down';
export type ContextStatus = 'green' | 'amber' | 'red' | 'unknown';

export interface FleetAgentData {
  agent: string;
  org: string;
  health: HealthStatus;
  lastHeartbeat?: string;
  currentTask?: string;
  fillPct: number;
  contextStatus: ContextStatus;
  cacheReadTokens: number;
  etaTurns: number | null;
  burnRatePerTurn: number;
}

export interface UsageData {
  five_hour_utilization: number;
  seven_day_utilization: number;
  fetched_at: string;
}

export interface AgentTokenData {
  input: number;
  output: number;
  cacheRead: number;
  cacheCreate: number;
  costUsd: number;
  model: string;
  tasksToday: number;
}

export interface FleetTokenSummary {
  agents: Record<string, AgentTokenData>;
  fleetCostToday: number;
  asOf: string;
}

export interface FleetHealthResponse {
  agents: FleetAgentData[];
  usage: UsageData | null;
  tokens: FleetTokenSummary | null;
  healthy: number;
  stale: number;
  down: number;
}

// --- Heartbeat helpers ---

interface HeartbeatFile {
  agent: string;
  org?: string;
  last_heartbeat?: string;
  current_task?: string;
}

const STALE_MS = 30 * 60 * 1000;
const DOWN_MS = 2 * 60 * 60 * 1000;

function healthFromHeartbeat(hb: HeartbeatFile): HealthStatus {
  if (!hb.last_heartbeat) return 'down';
  const age = Date.now() - new Date(hb.last_heartbeat).getTime();
  if (age < STALE_MS) return 'healthy';
  if (age < DOWN_MS) return 'stale';
  return 'down';
}

async function readHeartbeats(): Promise<Map<string, { health: HealthStatus; lastHeartbeat?: string; currentTask?: string; org: string }>> {
  const ctxRoot = path.join(os.homedir(), '.cortextos', 'default');
  const hbDir = path.join(ctxRoot, 'state');
  const result = new Map<string, { health: HealthStatus; lastHeartbeat?: string; currentTask?: string; org: string }>();

  let entries: string[];
  try {
    entries = await fs.readdir(hbDir);
  } catch {
    return result;
  }

  await Promise.all(
    entries.map(async (name) => {
      const hbPath = path.join(hbDir, name, 'heartbeat.json');
      try {
        const raw = await fs.readFile(hbPath, 'utf-8');
        const hb = JSON.parse(raw) as HeartbeatFile;
        result.set(hb.agent ?? name, {
          health: healthFromHeartbeat(hb),
          lastHeartbeat: hb.last_heartbeat,
          currentTask: hb.current_task,
          org: hb.org ?? 'default',
        });
      } catch {
        // agent dir without heartbeat — skip
      }
    }),
  );

  return result;
}

// --- Session context helpers ---

function contextStatus(fillPct: number): ContextStatus {
  const ratio = fillPct / 100;
  if (ratio >= RED_THRESHOLD) return 'red';
  if (ratio >= AMBER_THRESHOLD) return 'amber';
  return 'green';
}

function agentFromProjectDir(dirName: string): string | null {
  const match = dirName.match(/-agents-([a-z0-9_-]+)$/);
  return match ? match[1] : null;
}

interface ContextRecord {
  cacheRead: number;
}

async function readContextMetrics(jsonlPath: string): Promise<ContextRecord[]> {
  let content: string;
  try {
    content = await fs.readFile(jsonlPath, 'utf-8');
  } catch {
    return [];
  }
  const lines = content.split('\n').filter(Boolean);
  const tail = lines.slice(-100);
  const records: ContextRecord[] = [];
  for (const line of tail) {
    try {
      const msg = JSON.parse(line);
      if (msg.type !== 'assistant' || !msg.message?.usage) continue;
      const u = msg.message.usage;
      records.push({ cacheRead: u.cache_read_input_tokens ?? 0 });
    } catch {
      // skip
    }
  }
  return records;
}

async function readAllContextMetrics(): Promise<Map<string, { fillPct: number; contextStatus: ContextStatus; cacheReadTokens: number; etaTurns: number | null; burnRatePerTurn: number }>> {
  const projectsDir = path.join(os.homedir(), '.claude', 'projects');
  const result = new Map<string, { fillPct: number; contextStatus: ContextStatus; cacheReadTokens: number; etaTurns: number | null; burnRatePerTurn: number }>();

  let entries: string[];
  try {
    entries = await fs.readdir(projectsDir);
  } catch {
    return result;
  }

  await Promise.all(
    entries.map(async (dirName) => {
      const agentName = agentFromProjectDir(dirName);
      if (!agentName) return;

      const dirPath = path.join(projectsDir, dirName);
      let files: string[];
      try {
        files = (await fs.readdir(dirPath)).filter((f) => f.endsWith('.jsonl'));
      } catch {
        return;
      }
      if (files.length === 0) return;

      const statted = await Promise.all(
        files.map(async (f) => {
          const fp = path.join(dirPath, f);
          const stat = await fs.stat(fp).catch(() => null);
          return { file: fp, mtime: stat?.mtimeMs ?? 0 };
        }),
      );
      statted.sort((a, b) => b.mtime - a.mtime);
      const records = await readContextMetrics(statted[0].file);
      if (records.length === 0) return;

      const last = records[records.length - 1];
      const cacheRead = last.cacheRead;
      const fillRatio = Math.min(cacheRead / CONTEXT_LIMIT, 1);
      const fillPct = Math.round(fillRatio * 1000) / 10;

      const window = records.slice(-5);
      let burnRate = 0;
      if (window.length >= 2) {
        const delta = window[window.length - 1].cacheRead - window[0].cacheRead;
        burnRate = Math.max(0, delta / (window.length - 1));
      }

      const etaTurns = burnRate > 0 ? Math.max(0, (CONTEXT_LIMIT - cacheRead) / burnRate) : null;

      result.set(agentName, {
        fillPct,
        contextStatus: contextStatus(fillPct),
        cacheReadTokens: cacheRead,
        etaTurns: etaTurns !== null ? Math.round(etaTurns) : null,
        burnRatePerTurn: Math.round(burnRate),
      });
    }),
  );

  return result;
}

// --- Token tracking (JSONL incremental scanner) ---

const MODEL_PRICES: Record<string, { input: number; output: number; cacheWrite1h: number; cacheWrite5m: number; cacheRead: number }> = {
  'claude-opus-4-7':   { input: 5.00, output: 25.00, cacheWrite1h: 10.00, cacheWrite5m: 6.25, cacheRead: 0.50 },
  'claude-sonnet-4-6': { input: 3.00, output: 15.00, cacheWrite1h:  6.00, cacheWrite5m: 3.75, cacheRead: 0.30 },
  'claude-haiku-4-5':  { input: 1.00, output:  5.00, cacheWrite1h:  2.00, cacheWrite5m: 1.25, cacheRead: 0.10 },
};
const MTOK = 1_000_000;
// Discover agents dynamically from project session dirs; falls back to a baseline list
async function discoverKnownAgents(): Promise<string[]> {
  const projectsDir = path.join(os.homedir(), '.claude', 'projects');
  const stateDir = path.join(os.homedir(), '.cortextos', 'default', 'state');
  const agents = new Set<string>();

  // From JSONL session dirs: -home-cortext-cortextos-orgs-<org>-agents-<name>
  try {
    const entries = await fs.readdir(projectsDir);
    for (const e of entries) {
      const m = e.match(/-agents-([a-z0-9_-]+)$/);
      if (m) agents.add(m[1]);
    }
  } catch { /* ignore */ }

  // From heartbeat state dirs
  try {
    const entries = await fs.readdir(stateDir);
    for (const name of entries) {
      const hbPath = path.join(stateDir, name, 'heartbeat.json');
      try {
        await fs.access(hbPath);
        agents.add(name);
      } catch { /* skip */ }
    }
  } catch { /* ignore */ }

  const EXCLUDED = new Set(['usage', 'oauth', 'analytics', 'cortextos']);
  return [...agents].filter(a => !EXCLUDED.has(a));
}

const CTX_ROOT = path.join(os.homedir(), '.cortextos', 'default');
const CURSOR_PATH = path.join(CTX_ROOT, 'analytics', 'token-cursor.json');
const TOTALS_PATH = path.join(CTX_ROOT, 'analytics', 'token-totals.json');

interface AgentCursor { filePath: string; lineCount: number; }
interface CursorStore  { date: string; cursors: Record<string, AgentCursor>; }
interface TotalsStore  { date: string; agents: Record<string, AgentTokenData>; updatedAt: string; }

function todayUTC(): string {
  const d = new Date();
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}

function calcTurnCost(model: string, inp: number, out: number, cr: number, cc1h: number, cc5m: number): number {
  const p = MODEL_PRICES[model] ?? MODEL_PRICES['claude-sonnet-4-6'];
  return (inp / MTOK) * p.input
       + (out / MTOK) * p.output
       + (cr  / MTOK) * p.cacheRead
       + (cc1h / MTOK) * p.cacheWrite1h
       + (cc5m / MTOK) * p.cacheWrite5m;
}

async function readOrInit<T>(filePath: string, defaultVal: T, dateKey?: string): Promise<T> {
  try {
    const raw = await fs.readFile(filePath, 'utf-8');
    const parsed = JSON.parse(raw) as T & { date?: string };
    if (dateKey && parsed.date !== dateKey) return defaultVal;
    return parsed;
  } catch {
    return defaultVal;
  }
}

async function getLatestJsonlForAgent(agentName: string): Promise<string | null> {
  const dir = path.join(os.homedir(), '.claude', 'projects', `-home-cortext-cortextos-orgs-silvermere-tech-agents-${agentName}`);
  let files: string[];
  try {
    files = (await fs.readdir(dir)).filter(f => f.endsWith('.jsonl'));
  } catch {
    return null;
  }
  if (files.length === 0) return null;
  const statted = await Promise.all(files.map(async f => {
    const fp = path.join(dir, f);
    const stat = await fs.stat(fp).catch(() => null);
    return { fp, mtime: stat?.mtimeMs ?? 0 };
  }));
  statted.sort((a, b) => b.mtime - a.mtime);
  return statted[0].fp;
}

async function scanAgentTokens(
  agentName: string,
  cursor: AgentCursor | undefined,
  prior: AgentTokenData | undefined,
  today: string,
): Promise<{ tokens: AgentTokenData; newCursor: AgentCursor | null }> {
  const latestFile = await getLatestJsonlForAgent(agentName);
  const empty: AgentTokenData = { input: 0, output: 0, cacheRead: 0, cacheCreate: 0, costUsd: 0, model: 'unknown', tasksToday: 0 };

  if (!latestFile) return { tokens: prior ?? empty, newCursor: null };

  const content = await fs.readFile(latestFile, 'utf-8').catch(() => '');
  const lines = content.split('\n').filter(Boolean);

  // Carry forward prior totals when continuing same file; reset on file change or new day
  const sameFile = cursor?.filePath === latestFile;
  const startLine = sameFile ? (cursor?.lineCount ?? 0) : 0;
  const tokens: AgentTokenData = (sameFile && prior) ? { ...prior } : { ...empty };

  const modelCounts: Record<string, number> = {};
  const todayPrefix = today; // ISO timestamp starts with "YYYY-MM-DD"

  for (let i = startLine; i < lines.length; i++) {
    let obj: Record<string, unknown>;
    try { obj = JSON.parse(lines[i]); } catch { continue; }

    const ts = obj.timestamp as string | undefined;
    if (!ts?.startsWith(todayPrefix)) continue;

    const msg = obj.message as Record<string, unknown> | undefined;
    if (!msg || msg.role !== 'assistant') continue;
    const usage = msg.usage as Record<string, unknown> | undefined;
    if (!usage) continue;

    const model = (msg.model as string) || 'unknown';
    modelCounts[model] = (modelCounts[model] ?? 0) + 1;

    const inp = (usage.input_tokens as number) ?? 0;
    const out = (usage.output_tokens as number) ?? 0;
    const cr  = (usage.cache_read_input_tokens as number) ?? 0;
    const cc  = (usage.cache_creation_input_tokens as number) ?? 0;
    const ccObj = usage.cache_creation as Record<string, number> | undefined;
    const cc1h = ccObj?.ephemeral_1h_input_tokens ?? cc;
    const cc5m = ccObj?.ephemeral_5m_input_tokens ?? 0;

    tokens.input      += inp;
    tokens.output     += out;
    tokens.cacheRead  += cr;
    tokens.cacheCreate += cc;
    tokens.costUsd    += calcTurnCost(model, inp, out, cr, cc1h, cc5m);
  }

  if (Object.keys(modelCounts).length > 0) {
    tokens.model = Object.entries(modelCounts).sort((a, b) => b[1] - a[1])[0][0];
  }

  return { tokens, newCursor: { filePath: latestFile, lineCount: lines.length } };
}

async function countTasksToday(agentName: string, today: string): Promise<number> {
  const auditDir = path.join(CTX_ROOT, 'orgs', 'silvermere-tech', 'tasks', 'audit');
  let files: string[];
  try { files = (await fs.readdir(auditDir)).filter(f => f.endsWith('.jsonl')); }
  catch { return 0; }

  let count = 0;
  await Promise.all(files.map(async (file) => {
    const content = await fs.readFile(path.join(auditDir, file), 'utf-8').catch(() => '');
    for (const line of content.split('\n')) {
      if (!line.trim()) continue;
      try {
        const obj = JSON.parse(line) as { event?: string; agent?: string; ts?: string };
        if (obj.event === 'complete' && obj.agent === agentName && obj.ts?.startsWith(today)) count++;
      } catch { /* skip */ }
    }
  }));
  return count;
}

async function readAndUpdateTokenMetrics(): Promise<FleetTokenSummary> {
  const today = todayUTC();

  const [cursorStore, totalsStore, knownAgents] = await Promise.all([
    readOrInit<CursorStore>(CURSOR_PATH, { date: today, cursors: {} }, today),
    readOrInit<TotalsStore>(TOTALS_PATH, { date: today, agents: {}, updatedAt: '' }, today),
    discoverKnownAgents(),
  ]);

  const newCursors: CursorStore = { date: today, cursors: { ...cursorStore.cursors } };
  const newTotals: TotalsStore  = { date: today, agents: { ...totalsStore.agents }, updatedAt: new Date().toISOString() };

  await Promise.all(knownAgents.map(async (agent) => {
    const [scanResult, tasksToday] = await Promise.all([
      scanAgentTokens(agent, cursorStore.cursors[agent], totalsStore.agents[agent], today),
      countTasksToday(agent, today),
    ]);
    newTotals.agents[agent] = { ...scanResult.tokens, tasksToday };
    if (scanResult.newCursor) newCursors.cursors[agent] = scanResult.newCursor;
  }));

  // Persist state (fire-and-forget, non-blocking)
  void Promise.all([
    fs.writeFile(CURSOR_PATH, JSON.stringify(newCursors, null, 2)).catch(() => {}),
    fs.writeFile(TOTALS_PATH, JSON.stringify(newTotals, null, 2)).catch(() => {}),
  ]);

  const fleetCostToday = Object.values(newTotals.agents).reduce((s, a) => s + a.costUsd, 0);

  return { agents: newTotals.agents, fleetCostToday, asOf: newTotals.updatedAt };
}

// --- Usage data helper ---

interface UsageLatest {
  five_hour_utilization: number;
  seven_day_utilization: number;
  fetched_at: string;
}

async function readUsageData(): Promise<UsageData | null> {
  const ctxRoot = path.join(os.homedir(), '.cortextos', 'default');
  // Prefer api-latest.json (written by check-usage-api); fall back to latest.json
  const candidates = [
    path.join(ctxRoot, 'state', 'usage', 'api-latest.json'),
    path.join(ctxRoot, 'state', 'usage', 'latest.json'),
  ];
  for (const latestPath of candidates) {
    try {
      const raw = await fs.readFile(latestPath, 'utf-8');
      const data = JSON.parse(raw) as UsageLatest;
      if (!data.five_hour_utilization && !data.seven_day_utilization) continue;
      const age = Date.now() - new Date(data.fetched_at).getTime();
      if (age > USAGE_STALE_MS) continue;
      return {
        five_hour_utilization: data.five_hour_utilization,
        seven_day_utilization: data.seven_day_utilization,
        fetched_at: data.fetched_at,
      };
    } catch {
      // try next candidate
    }
  }
  return null;
}

// --- Route handler ---

export async function GET() {
  const [heartbeats, contextMetrics, usage, tokens] = await Promise.all([
    readHeartbeats(),
    readAllContextMetrics(),
    readUsageData(),
    readAndUpdateTokenMetrics().catch(() => null),
  ]);

  // Union of all known agents — exclude the cortextos watchdog process itself
  const EXCLUDED_AGENTS = new Set(['cortextos']);
  const allAgents = new Set(
    [...heartbeats.keys(), ...contextMetrics.keys()].filter(n => !EXCLUDED_AGENTS.has(n))
  );

  const agents: FleetAgentData[] = [];
  let healthy = 0, stale = 0, down = 0;

  for (const agentName of allAgents) {
    const hb = heartbeats.get(agentName);
    const ctx = contextMetrics.get(agentName);

    const health: HealthStatus = hb?.health ?? 'down';
    if (health === 'healthy') healthy++;
    else if (health === 'stale') stale++;
    else down++;

    agents.push({
      agent: agentName,
      org: hb?.org ?? 'unknown',
      health,
      lastHeartbeat: hb?.lastHeartbeat,
      currentTask: hb?.currentTask,
      fillPct: ctx?.fillPct ?? 0,
      contextStatus: ctx?.contextStatus ?? 'unknown',
      cacheReadTokens: ctx?.cacheReadTokens ?? 0,
      etaTurns: ctx?.etaTurns ?? null,
      burnRatePerTurn: ctx?.burnRatePerTurn ?? 0,
    });
  }

  agents.sort((a, b) => {
    const order: Record<HealthStatus, number> = { down: 0, stale: 1, healthy: 2 };
    const healthDiff = order[a.health] - order[b.health];
    if (healthDiff !== 0) return healthDiff;
    return b.fillPct - a.fillPct;
  });

  const response: FleetHealthResponse = { agents, usage, tokens, healthy, stale, down };
  return Response.json(response);
}
