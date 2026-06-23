import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  parseVmRssKb,
  parseMeminfoKb,
  parseAgentFromEnviron,
  memoryThresholdsFromEnv,
  evaluateMemoryAnomalies,
  collectAgentMemory,
  agentEnvSuffix,
  agentRssLadderFromEnv,
  DEFAULT_MEMORY_THRESHOLDS,
  type MemorySnapshot,
} from '../src/bus/agent-memory.js';

describe('agent-memory — pure parsers', () => {
  it('parseVmRssKb extracts VmRSS, null when absent', () => {
    expect(parseVmRssKb('VmPeak:\t 700000 kB\nVmRSS:\t  550280 kB\nVmData: 1 kB')).toBe(550280);
    expect(parseVmRssKb('Name:\tclaude\nState:\tS')).toBeNull();
  });

  it('parseMeminfoKb extracts a key, null when absent', () => {
    const mem = 'MemTotal:        3987654 kB\nMemFree:  100 kB\nMemAvailable:     400000 kB';
    expect(parseMeminfoKb(mem, 'MemTotal')).toBe(3987654);
    expect(parseMeminfoKb(mem, 'MemAvailable')).toBe(400000);
    expect(parseMeminfoKb(mem, 'Nonexistent')).toBeNull();
  });

  it('parseAgentFromEnviron finds CTX_AGENT_NAME in NUL-separated environ', () => {
    expect(parseAgentFromEnviron('PATH=/usr/bin\0CTX_AGENT_NAME=chief\0HOME=/root')).toBe('chief');
    expect(parseAgentFromEnviron('PATH=/usr/bin\0HOME=/root')).toBeNull();
    expect(parseAgentFromEnviron('CTX_AGENT_NAME=\0X=1')).toBeNull(); // empty value
  });
});

describe('agent-memory — thresholds from env', () => {
  it('falls back to defaults and applies valid overrides', () => {
    expect(memoryThresholdsFromEnv({})).toEqual(DEFAULT_MEMORY_THRESHOLDS);
    const t = memoryThresholdsFromEnv({ CTX_MEM_AGENT_WARN_MB: '500', CTX_MEM_HEADROOM_CRITICAL_PCT: '5' });
    expect(t.agent_warn_mb).toBe(500);
    expect(t.headroom_critical_pct).toBe(5);
    expect(t.agent_critical_mb).toBe(DEFAULT_MEMORY_THRESHOLDS.agent_critical_mb); // untouched
    // invalid override ignored
    expect(memoryThresholdsFromEnv({ CTX_MEM_AGENT_WARN_MB: 'abc' }).agent_warn_mb).toBe(DEFAULT_MEMORY_THRESHOLDS.agent_warn_mb);
  });
});

describe('agent-memory — per-agent RSS ladder overrides', () => {
  const d = DEFAULT_MEMORY_THRESHOLDS;

  it('agentEnvSuffix uppercases and underscores non-alphanumerics', () => {
    expect(agentEnvSuffix('engineer')).toBe('ENGINEER');
    expect(agentEnvSuffix('business-analyst')).toBe('BUSINESS_ANALYST');
    expect(agentEnvSuffix('a.b-c')).toBe('A_B_C');
  });

  it('falls back to the global base when no agent-specific override is set', () => {
    expect(agentRssLadderFromEnv('engineer', d, {})).toEqual({
      agent_warn_mb: d.agent_warn_mb,
      agent_elevated_mb: d.agent_elevated_mb,
      agent_critical_mb: d.agent_critical_mb,
    });
  });

  it('applies an agent-specific override per rung, independently', () => {
    const l = agentRssLadderFromEnv('engineer', d, {
      CTX_MEM_AGENT_WARN_MB_ENGINEER: '1600',
      CTX_MEM_AGENT_ELEVATED_MB_ENGINEER: '1900',
      CTX_MEM_AGENT_CRITICAL_MB_ENGINEER: '2200',
    });
    expect(l).toEqual({ agent_warn_mb: 1600, agent_elevated_mb: 1900, agent_critical_mb: 2200 });
    // a single-rung override leaves the other rungs on base
    const partial = agentRssLadderFromEnv('engineer', d, { CTX_MEM_AGENT_WARN_MB_ENGINEER: '1600' });
    expect(partial.agent_warn_mb).toBe(1600);
    expect(partial.agent_elevated_mb).toBe(d.agent_elevated_mb);
  });

  it('an override for one agent does not leak to another', () => {
    const env = { CTX_MEM_AGENT_WARN_MB_ENGINEER: '1600' };
    expect(agentRssLadderFromEnv('analyst', d, env).agent_warn_mb).toBe(d.agent_warn_mb);
    expect(agentRssLadderFromEnv('engineer', d, env).agent_warn_mb).toBe(1600);
  });

  it('ignores non-positive / non-numeric overrides (falls through to base)', () => {
    expect(agentRssLadderFromEnv('engineer', d, { CTX_MEM_AGENT_WARN_MB_ENGINEER: 'abc' }).agent_warn_mb).toBe(d.agent_warn_mb);
    expect(agentRssLadderFromEnv('engineer', d, { CTX_MEM_AGENT_WARN_MB_ENGINEER: '0' }).agent_warn_mb).toBe(d.agent_warn_mb);
    expect(agentRssLadderFromEnv('engineer', d, { CTX_MEM_AGENT_WARN_MB_ENGINEER: '-5' }).agent_warn_mb).toBe(d.agent_warn_mb);
  });

  it('evaluateMemoryAnomalies honours the ladderFor resolver: a heavy agent stays silent under its own raised ceiling', () => {
    const snap: MemorySnapshot = {
      agents: [
        { agent: 'engineer', rss_mb: 1100, procs: 3 }, // over global warn (1000), under its raised ceiling
        { agent: 'analyst', rss_mb: 1100, procs: 1 },  // over global warn — should still flag
      ],
      mem_total_mb: 13000, mem_available_mb: 6000, available_pct: 46,
    };
    const ladderFor = (agent: string) => agentRssLadderFromEnv(agent, d, {
      CTX_MEM_AGENT_WARN_MB_ENGINEER: '1600',
      CTX_MEM_AGENT_ELEVATED_MB_ENGINEER: '1900',
      CTX_MEM_AGENT_CRITICAL_MB_ENGINEER: '2200',
    });
    const anoms = evaluateMemoryAnomalies(snap, d, ladderFor).filter(a => a.scope === 'agent');
    expect(anoms.map(a => a.agent)).toEqual(['analyst']);
    expect(anoms[0]).toMatchObject({ tier: 'warning', threshold_mb: d.agent_warn_mb });
  });

  it('without a resolver, the global ladder applies to every agent (back-compat)', () => {
    const snap: MemorySnapshot = {
      agents: [{ agent: 'engineer', rss_mb: d.agent_warn_mb + 1, procs: 1 }],
      mem_total_mb: 13000, mem_available_mb: 6000, available_pct: 46,
    };
    const anoms = evaluateMemoryAnomalies(snap, d).filter(a => a.scope === 'agent');
    expect(anoms.map(a => a.agent)).toEqual(['engineer']);
  });
});

describe('agent-memory — evaluateMemoryAnomalies', () => {
  const snap = (agents: { agent: string; rss_mb: number }[], total = 4000, avail = 2000): MemorySnapshot => ({
    agents: agents.map(a => ({ ...a, procs: 1 })),
    mem_total_mb: total,
    mem_available_mb: avail,
    available_pct: Math.round((avail / total) * 100),
  });

  it('no anomalies when all under thresholds + healthy headroom', () => {
    expect(evaluateMemoryAnomalies(snap([{ agent: 'a', rss_mb: 500 }], 4000, 2000))).toEqual([]);
  });

  it('per-agent ladder: warn / elevated / critical', () => {
    const d = DEFAULT_MEMORY_THRESHOLDS;
    const warn = evaluateMemoryAnomalies(snap([{ agent: 'a', rss_mb: d.agent_warn_mb + 1 }]))[0];
    expect(warn).toMatchObject({ scope: 'agent', tier: 'warning', severity: 'warning', agent: 'a' });
    const elev = evaluateMemoryAnomalies(snap([{ agent: 'a', rss_mb: d.agent_elevated_mb + 1 }]))[0];
    expect(elev).toMatchObject({ tier: 'elevated', severity: 'warning' });
    const crit = evaluateMemoryAnomalies(snap([{ agent: 'a', rss_mb: d.agent_critical_mb + 1 }]))[0];
    expect(crit).toMatchObject({ tier: 'critical', severity: 'critical' });
  });

  it('headroom ladder: low MemAvailable flags (box-relative OOM signal)', () => {
    // 4000 total, 200 avail = 5% → below critical (7%)
    const a = evaluateMemoryAnomalies(snap([{ agent: 'a', rss_mb: 100 }], 4000, 200));
    const headroom = a.find(x => x.scope === 'headroom');
    expect(headroom).toMatchObject({ scope: 'headroom', tier: 'critical', severity: 'critical' });
    // 4000 total, 520 avail = 13% → warning band (<15, >=10)
    const w = evaluateMemoryAnomalies(snap([{ agent: 'a', rss_mb: 100 }], 4000, 520)).find(x => x.scope === 'headroom');
    expect(w).toMatchObject({ tier: 'warning' });
  });

  it('does not emit a headroom anomaly when MemTotal is unknown (0)', () => {
    const s: MemorySnapshot = { agents: [], mem_total_mb: 0, mem_available_mb: 0, available_pct: 0 };
    expect(evaluateMemoryAnomalies(s)).toEqual([]);
  });

  it('flags multiple over-threshold agents independently', () => {
    const d = DEFAULT_MEMORY_THRESHOLDS;
    const a = evaluateMemoryAnomalies(snap([
      { agent: 'x', rss_mb: d.agent_warn_mb + 1 },
      { agent: 'y', rss_mb: d.agent_critical_mb + 1 },
      { agent: 'z', rss_mb: 100 },
    ], 4000, 3000));
    const agentAnoms = a.filter(x => x.scope === 'agent');
    expect(agentAnoms.map(x => x.agent).sort()).toEqual(['x', 'y']);
  });
});

describe('agent-memory — collectAgentMemory (fake /proc)', () => {
  let dir: string;
  afterEach(() => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ } });

  it('buckets VmRSS by CTX_AGENT_NAME across PIDs + reads meminfo', () => {
    dir = mkdtempSync(join(tmpdir(), 'proc-'));
    writeFileSync(join(dir, 'meminfo'), 'MemTotal: 4000000 kB\nMemAvailable: 1000000 kB\n');
    const mkproc = (pid: string, agent: string | null, rssKb: number) => {
      const p = join(dir, pid); mkdirSync(p);
      writeFileSync(join(p, 'environ'), (agent ? `CTX_AGENT_NAME=${agent}\0` : '') + 'PATH=/x');
      writeFileSync(join(p, 'status'), `Name:\tclaude\nVmRSS:\t ${rssKb} kB\n`);
    };
    mkproc('100', 'chief', 300000);   // chief claude
    mkproc('101', 'chief', 100000);   // chief node child → sums to 400000kB ≈ 391MB
    mkproc('200', 'analyst', 450000); // analyst
    mkproc('300', null, 999999);      // non-agent process → ignored
    // non-numeric dir ignored
    mkdirSync(join(dir, 'self'));

    const snap = collectAgentMemory(dir);
    expect(snap.mem_total_mb).toBe(Math.round(4000000 / 1024));
    expect(snap.available_pct).toBe(25);
    const chief = snap.agents.find(a => a.agent === 'chief');
    expect(chief).toBeDefined();
    expect(chief!.procs).toBe(2);
    expect(chief!.rss_mb).toBe(Math.round(400000 / 1024));
    expect(snap.agents.find(a => a.agent === 'analyst')!.rss_mb).toBe(Math.round(450000 / 1024));
    // sorted desc by rss
    expect(snap.agents[0].agent).toBe('analyst');
  });

  it('returns zeroed snapshot when procDir is absent (non-Linux / no proc)', () => {
    const snap = collectAgentMemory('/no/such/proc/path');
    expect(snap).toEqual({ agents: [], mem_total_mb: 0, mem_available_mb: 0, available_pct: 0 });
  });
});
