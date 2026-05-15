import { promises as fs } from 'fs';
import path from 'path';
import os from 'os';

export const dynamic = 'force-dynamic';

// Context window size for Claude Opus 4.7 / Opus 4.6 / Sonnet 4.6 (tokens)
const CONTEXT_LIMIT = 1_000_000;

// Thresholds for Green / Amber / Red
const AMBER_THRESHOLD = 0.6;
const RED_THRESHOLD = 0.85;

export type ContextStatus = 'green' | 'amber' | 'red';

export interface AgentContextMetrics {
  agent: string;
  fillPct: number;
  status: ContextStatus;
  burnRatePerTurn: number;
  etaTurns: number | null;
  totalTurns: number;
  cacheReadTokens: number;
  sessionFile: string;
}

interface UsageRecord {
  cacheRead: number;
  cacheCreate: number;
  input: number;
  output: number;
}

function contextStatus(fillPct: number): ContextStatus {
  if (fillPct >= RED_THRESHOLD) return 'red';
  if (fillPct >= AMBER_THRESHOLD) return 'amber';
  return 'green';
}

// Extract agent name from a Claude projects directory name.
// e.g. "-home-cortext-cortextos-orgs-silvermere-tech-agents-analyst" → "analyst"
function agentFromProjectDir(dirName: string): string | null {
  const match = dirName.match(/-agents-([a-z0-9_-]+)$/);
  return match ? match[1] : null;
}

async function readSessionMetrics(jsonlPath: string): Promise<UsageRecord[]> {
  let content: string;
  try {
    content = await fs.readFile(jsonlPath, 'utf-8');
  } catch {
    return [];
  }

  // Only read last 100 lines for performance
  const lines = content.split('\n').filter(Boolean);
  const tail = lines.slice(-100);

  const records: UsageRecord[] = [];
  for (const line of tail) {
    try {
      const msg = JSON.parse(line);
      if (msg.type !== 'assistant' || !msg.message?.usage) continue;
      const u = msg.message.usage;
      records.push({
        cacheRead: u.cache_read_input_tokens ?? 0,
        cacheCreate: u.cache_creation_input_tokens ?? 0,
        input: u.input_tokens ?? 0,
        output: u.output_tokens ?? 0,
      });
    } catch {
      // skip malformed lines
    }
  }
  return records;
}

export async function GET() {
  const projectsDir = path.join(os.homedir(), '.claude', 'projects');

  let entries: string[];
  try {
    entries = await fs.readdir(projectsDir);
  } catch {
    return Response.json({ agents: [] });
  }

  const results: AgentContextMetrics[] = [];

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

      // Use most recently modified session file
      const statted = await Promise.all(
        files.map(async (f) => {
          const fp = path.join(dirPath, f);
          const stat = await fs.stat(fp).catch(() => null);
          return { file: fp, mtime: stat?.mtimeMs ?? 0 };
        }),
      );
      statted.sort((a, b) => b.mtime - a.mtime);
      const sessionFile = statted[0].file;

      const records = await readSessionMetrics(sessionFile);
      if (records.length === 0) return;

      const last = records[records.length - 1];
      const cacheRead = last.cacheRead;
      const fillPct = Math.min(cacheRead / CONTEXT_LIMIT, 1);

      // Burn rate: average delta(cacheRead) over last 5 records
      const window = records.slice(-5);
      let burnRate = 0;
      if (window.length >= 2) {
        const delta = window[window.length - 1].cacheRead - window[0].cacheRead;
        burnRate = Math.max(0, delta / (window.length - 1));
      }

      const etaTurns =
        burnRate > 0 ? Math.max(0, (CONTEXT_LIMIT - cacheRead) / burnRate) : null;

      results.push({
        agent: agentName,
        fillPct: Math.round(fillPct * 1000) / 10, // one decimal place
        status: contextStatus(fillPct),
        burnRatePerTurn: Math.round(burnRate),
        etaTurns: etaTurns !== null ? Math.round(etaTurns) : null,
        totalTurns: records.length,
        cacheReadTokens: cacheRead,
        sessionFile: path.basename(sessionFile),
      });
    }),
  );

  results.sort((a, b) => b.fillPct - a.fillPct);

  return Response.json({ agents: results, contextLimit: CONTEXT_LIMIT });
}
