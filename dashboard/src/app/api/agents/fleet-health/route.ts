import { promises as fs } from 'fs';
import path from 'path';
import os from 'os';

export const dynamic = 'force-dynamic';

const CONTEXT_LIMIT = 1_000_000;
const AMBER_THRESHOLD = 0.6;
const RED_THRESHOLD = 0.85;
const USAGE_STALE_MS = 10 * 60 * 1000; // treat usage data older than 10 min as unavailable

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

export interface FleetHealthResponse {
  agents: FleetAgentData[];
  usage: UsageData | null;
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

// --- Usage data helper ---

interface UsageLatest {
  five_hour_utilization: number;
  seven_day_utilization: number;
  fetched_at: string;
}

async function readUsageData(): Promise<UsageData | null> {
  const ctxRoot = path.join(os.homedir(), '.cortextos', 'default');
  const latestPath = path.join(ctxRoot, 'state', 'usage', 'latest.json');
  try {
    const raw = await fs.readFile(latestPath, 'utf-8');
    const data = JSON.parse(raw) as UsageLatest;
    const age = Date.now() - new Date(data.fetched_at).getTime();
    if (age > USAGE_STALE_MS) return null;
    return {
      five_hour_utilization: data.five_hour_utilization,
      seven_day_utilization: data.seven_day_utilization,
      fetched_at: data.fetched_at,
    };
  } catch {
    return null;
  }
}

// --- Route handler ---

export async function GET() {
  const [heartbeats, contextMetrics, usage] = await Promise.all([
    readHeartbeats(),
    readAllContextMetrics(),
    readUsageData(),
  ]);

  // Union of all known agents
  const allAgents = new Set([...heartbeats.keys(), ...contextMetrics.keys()]);

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

  const response: FleetHealthResponse = { agents, usage, healthy, stale, down };
  return Response.json(response);
}
