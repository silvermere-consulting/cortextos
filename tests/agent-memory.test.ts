import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  parseVmRssKb,
  parsePssKb,
  parseMeminfoKb,
  parseAgentFromEnviron,
  memoryThresholdsFromEnv,
  evaluateMemoryAnomalies,
  collectAgentMemory,
  collectSessionPss,
  DEFAULT_MEMORY_THRESHOLDS,
  type MemorySnapshot,
} from '../src/bus/agent-memory.js';

describe('agent-memory — pure parsers', () => {
  it('parseVmRssKb extracts VmRSS, null when absent', () => {
    expect(parseVmRssKb('VmPeak:\t 700000 kB\nVmRSS:\t  550280 kB\nVmData: 1 kB')).toBe(550280);
    expect(parseVmRssKb('Name:\tclaude\nState:\tS')).toBeNull();
  });

  it('parsePssKb extracts Pss from smaps_rollup, null when absent', () => {
    expect(parsePssKb('Rss:\t 600000 kB\nPss:\t  412345 kB\nShared_Clean: 1 kB')).toBe(412345);
    expect(parsePssKb('Rss:\t 600000 kB\nShared_Clean: 1 kB')).toBeNull();
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

describe('agent-memory — evaluateMemoryAnomalies (session_pss + host-constrained arm)', () => {
  // The per-agent arm gates on session_pss_mb (the true per-session footprint) AND
  // host pressure (available_pct < headroom_warn_pct), fixed 2026-08-02 for the
  // rss_mb_is_a_tree_sum class. This matrix is analyst-specced: it proves the arm
  // DISCRIMINATES on both axes, not merely that it can be silenced — an FP-only set
  // is indistinguishable from a permanently-disabled arm (the known-positive rule).
  //
  // headroom bands (8000 total): <7% critical, <10% elevated, <15% warning.
  //   640 avail = 8% (tight); 4320 = 54% (fine); 6000 = 75% (fine).
  const snap = (
    agents: { agent: string; rss_mb: number; session_pss_mb?: number }[],
    total = 8000, avail = 4320,
  ): MemorySnapshot => ({
    agents: agents.map(a => ({ procs: 1, ...a })),
    mem_total_mb: total,
    mem_available_mb: avail,
    available_pct: Math.round((avail / total) * 100),
  });
  const agentAnoms = (r: ReturnType<typeof evaluateMemoryAnomalies>) => r.anomalies.filter(x => x.scope === 'agent');
  const hasHeadroom = (r: ReturnType<typeof evaluateMemoryAnomalies>) => r.anomalies.some(x => x.scope === 'headroom');

  // ── Case 1: the 4 real FPs (tree-sum high, session_pss healthy, host healthy) ──
  it('4 real FPs → NO per-agent anomaly (the noise this fix removes)', () => {
    const r = evaluateMemoryAnomalies(snap([
      { agent: 'research',  rss_mb: 1261, session_pss_mb: 320 },
      { agent: 'engineer',  rss_mb: 1077, session_pss_mb: 278 },
      { agent: 'engineer2', rss_mb: 1100, session_pss_mb: 293 },
      { agent: 'engineer3', rss_mb: 1158, session_pss_mb: 349 },
    ], 8000, 6000)); // ~75% free — the ">7GB free" the real FPs had
    expect(agentAnoms(r)).toEqual([]);
    expect(hasHeadroom(r)).toBe(false);
    expect(r.sessionPssAbsent).toEqual([]);
  });

  // ── Case 2: NAMED fire — the arm's only observable job is naming the culprit ──
  it('named fire: high session_pss + host tight → per-agent anomaly NAMING the agent', () => {
    const r = evaluateMemoryAnomalies(snap([{ agent: 'engineer', rss_mb: 1400, session_pss_mb: 700 }], 8000, 640));
    // Assert the NAME, not just "something fired": at 8% the headroom ladder also
    // fires and would cover for a dead per-agent arm (the coattails trap).
    expect(agentAnoms(r)[0]).toMatchObject({ scope: 'agent', agent: 'engineer', tier: 'warning', session_pss_mb: 700 });
    expect(hasHeadroom(r)).toBe(true); // present, but did NOT stand in for the name above
  });

  // ── Case 3: silent MIRROR — proves AND, not OR ──
  it('silent mirror: high session_pss + host FINE → NO per-agent anomaly', () => {
    const r = evaluateMemoryAnomalies(snap([{ agent: 'engineer', rss_mb: 1400, session_pss_mb: 700 }], 8000, 4320));
    expect(agentAnoms(r)).toEqual([]);   // host fine → no pressure, even at 700
    expect(hasHeadroom(r)).toBe(false);
  });

  // ── Case 4: NO over-attribution — many mediums, no single culprit ──
  it('no over-attribution: host tight + all sessions healthy → headroom fires, per-agent names NOBODY', () => {
    const r = evaluateMemoryAnomalies(snap([
      { agent: 'a', rss_mb: 900,  session_pss_mb: 300 },
      { agent: 'b', rss_mb: 1200, session_pss_mb: 340 },
      { agent: 'c', rss_mb: 800,  session_pss_mb: 290 },
    ], 8000, 640));
    expect(agentAnoms(r)).toEqual([]);  // no healthy session blamed for a box squeeze
    expect(hasHeadroom(r)).toBe(true);  // the box IS under pressure — headroom catches it
  });

  // ── Case 5: absent session_pss is SKIPPED (never tree-fallback) AND observable ──
  it('absent-skip: missing session_pss → skipped (not tree-fallback), recorded, headroom still fires', () => {
    const r = evaluateMemoryAnomalies(snap([{ agent: 'engineer', rss_mb: 1500 /* no session_pss_mb */ }], 8000, 640));
    expect(agentAnoms(r)).toEqual([]);          // NOT tree-fallback despite rss 1500
    expect(r.sessionPssAbsent).toEqual(['engineer']); // the skip is OBSERVABLE, not silent
    expect(hasHeadroom(r)).toBe(true);          // box coverage unaffected
  });

  // ── Case 6: the gate flips on BOTH axes independently ──
  it('gate flips on both axes: threshold and host, independently', () => {
    const d = DEFAULT_MEMORY_THRESHOLDS;
    const fireCfg = snap([{ agent: 'engineer', rss_mb: 1400, session_pss_mb: 700 }], 8000, 640); // host tight
    // baseline: fires with defaults
    expect(agentAnoms(evaluateMemoryAnomalies(fireCfg, d)).length).toBe(1);
    // threshold axis: raise warn above 700 → silent (host still tight)
    const tHigh = { ...d, agent_warn_mb: 800 };
    expect(agentAnoms(evaluateMemoryAnomalies(fireCfg, tHigh))).toEqual([]);
    // host axis: same 700 over default warn, but host fine → silent
    const hostFine = snap([{ agent: 'engineer', rss_mb: 1400, session_pss_mb: 700 }], 8000, 4320);
    expect(agentAnoms(evaluateMemoryAnomalies(hostFine, d))).toEqual([]);
  });

  // ── Tier coverage (host tight): warn / elevated / critical, gated on session_pss ──
  it('per-agent tiers on session_pss (host tight): warn / elevated / critical', () => {
    const d = DEFAULT_MEMORY_THRESHOLDS;
    // rss_mb is a huge tree-sum but IGNORED — proves the gate is session_pss, not rss.
    const at = (pss: number) =>
      agentAnoms(evaluateMemoryAnomalies(snap([{ agent: 'a', rss_mb: 9999, session_pss_mb: pss }], 8000, 640), d))[0];
    expect(at(d.agent_warn_mb + 1)).toMatchObject({ tier: 'warning', severity: 'warning', session_pss_mb: d.agent_warn_mb + 1 });
    expect(at(d.agent_elevated_mb + 1)).toMatchObject({ tier: 'elevated', severity: 'warning' });
    expect(at(d.agent_critical_mb + 1)).toMatchObject({ tier: 'critical', severity: 'critical' });
  });

  // ── Headroom ladder unchanged (primary, box-relative OOM signal) ──
  it('headroom ladder: low MemAvailable flags regardless of per-agent state', () => {
    const crit = evaluateMemoryAnomalies(snap([{ agent: 'a', rss_mb: 100, session_pss_mb: 50 }], 8000, 400)); // 5% → critical
    expect(crit.anomalies.find(x => x.scope === 'headroom')).toMatchObject({ tier: 'critical', severity: 'critical' });
    const warn = evaluateMemoryAnomalies(snap([{ agent: 'a', rss_mb: 100, session_pss_mb: 50 }], 8000, 1040)); // 13% → warning
    expect(warn.anomalies.find(x => x.scope === 'headroom')).toMatchObject({ tier: 'warning' });
  });

  it('no headroom anomaly when MemTotal is unknown (0); empty result carries an empty absent-list', () => {
    const s: MemorySnapshot = { agents: [], mem_total_mb: 0, mem_available_mb: 0, available_pct: 0 };
    expect(evaluateMemoryAnomalies(s)).toEqual({ anomalies: [], sessionPssAbsent: [] });
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

describe('agent-memory — collectSessionPss (fake /proc)', () => {
  let dir: string;
  afterEach(() => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ } });

  const mkpid = (pid: string, opts: { pss?: number; rssKb?: number }) => {
    const p = join(dir, pid); mkdirSync(p);
    if (opts.pss != null) writeFileSync(join(p, 'smaps_rollup'), `Rss:\t 900000 kB\nPss:\t ${opts.pss} kB\n`);
    if (opts.rssKb != null) writeFileSync(join(p, 'status'), `Name:\tclaude\nVmRSS:\t ${opts.rssKb} kB\n`);
  };

  it('measures the session pid PSS, not a tree-sum', () => {
    dir = mkdtempSync(join(tmpdir(), 'proc-'));
    mkpid('100', { pss: 409600, rssKb: 800000 }); // session anchor: PSS 400MB
    // A heavy TRANSIENT child would inflate a tree-sum but is never the anchor;
    // collectSessionPss only reads the anchor pid, so it can't be pulled in.
    mkpid('101', { pss: 999999, rssKb: 999999 });
    const out = collectSessionPss(new Map([['chief', '100:12345']]), dir);
    expect(out.get('chief')).toBe(Math.round(409600 / 1024)); // 400, from the anchor only
  });

  it('falls back to VmRSS for the SAME anchor pid when smaps_rollup is unreadable', () => {
    dir = mkdtempSync(join(tmpdir(), 'proc-'));
    mkpid('200', { rssKb: 512000 }); // no smaps_rollup → VmRSS fallback (500MB)
    const out = collectSessionPss(new Map([['analyst', '200:777']]), dir);
    expect(out.get('analyst')).toBe(Math.round(512000 / 1024));
  });

  it('omits agents with an empty session_key or a gone pid', () => {
    dir = mkdtempSync(join(tmpdir(), 'proc-'));
    mkpid('300', { pss: 102400 });
    const out = collectSessionPss(new Map([
      ['has-pid', '300:1'],
      ['no-key', ''],       // unresolved anchor → omitted
      ['gone', '999999:2'], // pid does not exist → omitted
    ]), dir);
    expect(out.get('has-pid')).toBe(Math.round(102400 / 1024));
    expect(out.has('no-key')).toBe(false);
    expect(out.has('gone')).toBe(false);
  });
});
