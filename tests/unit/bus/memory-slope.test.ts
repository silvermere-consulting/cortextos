import { describe, it, expect } from 'vitest';
import {
  evaluateSlope, applySlopeToAnomalies, evaluateAllSlopes,
  DEFAULT_SLOPE_THRESHOLDS, slopeThresholdsFromEnv,
  type MemorySample, type SlopeVerdict,
} from '../../../src/bus/memory-slope.js';
import type { MemoryAnomaly, MemorySnapshot } from '../../../src/bus/agent-memory.js';

// The slope arm replaces an identity-keyed prose routing contract. These
// fixtures are the ship-gate (chief, 2026-07-14): the synthetic riser MUST
// fire, flat-high MUST NOT, the restart sawtooth MUST NOT, and a detector
// with insufficient history must refuse a verdict rather than invent one.
// No agent name appears in any predicate — the fixtures use several names to
// prove the behaviour is name-blind.

function series(agent: string, key: string, startIso: string, stepH: number, rss: number[]): MemorySample[] {
  const t0 = Date.parse(startIso);
  return rss.map((mb, i) => ({
    ts: new Date(t0 + i * stepH * 3_600_000).toISOString(),
    agent, rss_mb: mb, session_key: key,
  }));
}

describe('evaluateSlope — known-positive', () => {
  it('FIRES on a synthetic riser: +300MB over 5h in one session (any agent name)', () => {
    const s = series('research', '123:456', '2026-07-14T00:00:00Z', 1, [400, 460, 520, 580, 640, 700]);
    const v = evaluateSlope(s)!;
    expect(v.verdict).toBe('rising');
    expect(v.rise_mb).toBe(300);
    expect(v.rate_mb_per_h).toBeGreaterThanOrEqual(30);
  });

  it('fires INSIDE the warning band (1000-1300) — the band the prose contract hid', () => {
    const s = series('engineer', '9:9', '2026-07-14T00:00:00Z', 1, [1000, 1060, 1120, 1180, 1240, 1300]);
    const v = evaluateSlope(s)!;
    expect(v.verdict).toBe('rising'); // a leak living exactly where nobody was looking
  });
});

describe('evaluateSlope — known-negatives', () => {
  it('does NOT fire on a flat-high baseline (1100MB +/- jitter across 8h)', () => {
    const s = series('engineer', '1:1', '2026-07-14T00:00:00Z', 1,
      [1100, 1110, 1095, 1105, 1115, 1100, 1090, 1108, 1102]);
    const v = evaluateSlope(s)!;
    expect(v.verdict).toBe('flat');
  });

  it('does NOT fire on the daily-restart sawtooth: rising day resets with a NEW session key', () => {
    // Session A climbs 400->900, restart, session B starts back at 400 and has
    // only 2 samples. The series is keyed to the LATEST session: 2 samples is
    // insufficient — never a rise stitched across the restart.
    const a = series('engineer', 'A:100', '2026-07-14T00:00:00Z', 1, [400, 600, 800, 900]);
    const b = series('engineer', 'B:999', '2026-07-14T05:00:00Z', 1, [400, 450]);
    const v = evaluateSlope([...a, ...b])!;
    expect(v.verdict).toBe('insufficient');
    expect(v.session_key).toBe('B:999');
  });

  it('does NOT fire on spike-then-recede (transient peak is not a leak)', () => {
    const s = series('writer', '2:2', '2026-07-14T00:00:00Z', 1, [400, 900, 1400, 500, 620]);
    const v = evaluateSlope(s)!;
    expect(v.verdict).not.toBe('rising'); // last sample far below peak
  });

  it('refuses a verdict on insufficient samples or span (no invented flat)', () => {
    const few = series('jones', '3:3', '2026-07-14T00:00:00Z', 1, [500, 800]);
    expect(evaluateSlope(few)!.verdict).toBe('insufficient');
    const narrow = series('jones', '3:3', '2026-07-14T00:00:00Z', 0.2, [500, 550, 600, 660]); // 0.6h span
    expect(evaluateSlope(narrow)!.verdict).toBe('insufficient');
  });

  it('ignores samples with unknown session keys (no series across the unknown)', () => {
    const s = series('othe', '', '2026-07-14T00:00:00Z', 1, [400, 600, 800, 1000, 1200]);
    expect(evaluateSlope(s)!.verdict).toBe('insufficient');
  });
});

describe('applySlopeToAnomalies — identity-free routing', () => {
  const base = { mem_available_mb: 8000, mem_total_mb: 16000, available_pct: 50 };
  const warn = (agent: string): MemoryAnomaly =>
    ({ kind: 'memory', scope: 'agent', severity: 'warning', tier: 'warning', agent, rss_mb: 1100, threshold_mb: 1000, ...base });
  const flat = (agent: string): SlopeVerdict =>
    ({ agent, session_key: 'k', verdict: 'flat', samples: 8, span_h: 8, rise_mb: 5, rate_mb_per_h: 0.6 });
  const insufficient = (agent: string): SlopeVerdict =>
    ({ agent, session_key: 'k', verdict: 'insufficient', samples: 1, span_h: 0, rise_mb: 0, rate_mb_per_h: 0 });
  const rising = (agent: string): SlopeVerdict =>
    ({ agent, session_key: 'k', verdict: 'rising', samples: 6, span_h: 5, rise_mb: 300, rate_mb_per_h: 60 });

  it('suppresses warning-tier + FLAT for ANY agent (behaviour, not name)', () => {
    for (const name of ['engineer', 'research', 'writer']) {
      const { anomalies, suppressed_flat } = applySlopeToAnomalies([warn(name)], [flat(name)]);
      expect(suppressed_flat).toHaveLength(1);
      expect(anomalies).toHaveLength(0);
    }
  });

  it('passes warning-tier through when history is INSUFFICIENT (fail toward noise, never silence)', () => {
    const { anomalies, suppressed_flat } = applySlopeToAnomalies([warn('engineer')], [insufficient('engineer')]);
    expect(anomalies).toHaveLength(1);
    expect(suppressed_flat).toHaveLength(0);
  });

  it('NEVER suppresses elevated/critical/headroom, even when flat', () => {
    const elevated: MemoryAnomaly = { kind: 'memory', scope: 'agent', severity: 'warning', tier: 'elevated', agent: 'engineer', rss_mb: 1400, threshold_mb: 1300, ...base };
    const headroom: MemoryAnomaly = { kind: 'memory', scope: 'headroom', severity: 'critical', tier: 'critical', ...base };
    const { anomalies, suppressed_flat } = applySlopeToAnomalies([elevated, headroom], [flat('engineer')]);
    expect(anomalies).toHaveLength(2);
    expect(suppressed_flat).toHaveLength(0);
  });

  it('emits memory_slope for RISING even when NO level threshold is crossed', () => {
    const { anomalies } = applySlopeToAnomalies([], [rising('research')]);
    expect(anomalies).toHaveLength(1);
    expect(anomalies[0].kind).toBe('memory_slope');
  });
});

describe('evaluateAllSlopes + env thresholds', () => {
  it('evaluates each snapshot agent against its own history only', () => {
    const snap: MemorySnapshot = {
      agents: [{ agent: 'a1', rss_mb: 700, procs: 1 }, { agent: 'a2', rss_mb: 500, procs: 1 }],
      mem_total_mb: 16000, mem_available_mb: 8000, available_pct: 50,
    };
    const hist = [
      ...series('a1', 'k1', '2026-07-14T00:00:00Z', 1, [400, 500, 600, 700]),
      ...series('a2', 'k2', '2026-07-14T00:00:00Z', 1, [500, 500, 501, 500]),
    ];
    const vs = evaluateAllSlopes(hist, snap);
    expect(vs.find(v => v.agent === 'a1')!.verdict).toBe('rising');
    expect(vs.find(v => v.agent === 'a2')!.verdict).toBe('flat');
  });

  it('reads CTX_MEM_SLOPE_* env overrides and ignores junk', () => {
    const t = slopeThresholdsFromEnv({ CTX_MEM_SLOPE_MIN_RISE_MB: '50', CTX_MEM_SLOPE_MIN_SAMPLES: 'banana' } as NodeJS.ProcessEnv);
    expect(t.min_rise_mb).toBe(50);
    expect(t.min_samples).toBe(DEFAULT_SLOPE_THRESHOLDS.min_samples);
  });
});

// ── collectSessionKeys anchor (2026-07-22 fix) ────────────────────────────────
// The INHERITED-tag misattribution: "oldest tagged process" anchored an 18h
// series to the dashboard's npm wrapper, which survives agent restarts. The
// daemon now stamps state/<agent>/session.pid; the sampler prefers the stamp
// WHEN STILL TRUE (pid alive + tagged), else falls back to the heuristic.
// Acceptance is BOTH DIRECTIONS (analyst): agent restart -> key MUST change;
// infra-only restart -> key MUST NOT change.

import { mkdtempSync, rmSync, mkdirSync, writeFileSync as wf } from 'fs';
import { join as j } from 'path';
import { tmpdir } from 'os';
import { collectSessionKeys } from '../../../src/bus/memory-slope.js';

function fakeProc(root: string, pid: number, agent: string | null, starttime: number): void {
  const d = j(root, String(pid));
  mkdirSync(d, { recursive: true });
  wf(j(d, 'environ'), agent ? `HOME=/x\0CTX_AGENT_NAME=${agent}\0PATH=/bin` : 'HOME=/x\0PATH=/bin');
  wf(j(d, 'stat'), `${pid} (some proc) S 1 ${pid} ${pid} 0 -1 4194304 0 0 0 0 0 0 0 0 20 0 1 0 ${starttime} 1000 100 18446744073709551615`);
}

describe('collectSessionKeys — daemon stamp vs inherited-tag heuristic', () => {
  function setup() {
    const proc = mkdtempSync(j(tmpdir(), 'fakeproc-'));
    const ctx = mkdtempSync(j(tmpdir(), 'fakectx-'));
    // wrapper: OLD tagged process (the dashboard npm wrapper shape)
    fakeProc(proc, 100, 'engineer', 1000);
    // session: YOUNGER tagged process (the real claude session)
    fakeProc(proc, 200, 'engineer', 5000);
    return { proc, ctx, cleanup: () => { rmSync(proc, { recursive: true, force: true }); rmSync(ctx, { recursive: true, force: true }); } };
  }
  const stamp = (ctx: string, agent: string, pid: number) => {
    mkdirSync(j(ctx, 'state', agent), { recursive: true });
    wf(j(ctx, 'state', agent, 'session.pid'), `${pid}\n`);
  };

  it('WITHOUT a stamp, the heuristic anchors to the OLDEST tagged process — the measured defect, kept as documented fallback', () => {
    const { proc, ctx, cleanup } = setup();
    try {
      expect(collectSessionKeys(proc, ctx).get('engineer')).toBe('100:1000');
    } finally { cleanup(); }
  });

  it('a live, correctly-tagged stamp WINS over the older wrapper', () => {
    const { proc, ctx, cleanup } = setup();
    try {
      stamp(ctx, 'engineer', 200);
      expect(collectSessionKeys(proc, ctx).get('engineer')).toBe('200:5000');
    } finally { cleanup(); }
  });

  it('KNOWN-NEGATIVE (the 07:44Z natural experiment, unit form): infra-only restart must NOT move the anchor', () => {
    const { proc, ctx, cleanup } = setup();
    try {
      stamp(ctx, 'engineer', 200);
      const before = collectSessionKeys(proc, ctx).get('engineer');
      // dashboard wrapper restarts: old pid gone, new wrapper pid appears
      rmSync(j(proc, '100'), { recursive: true, force: true });
      fakeProc(proc, 300, 'engineer', 9000);
      const after = collectSessionKeys(proc, ctx).get('engineer');
      expect(after).toBe(before); // series would NOT reset
    } finally { cleanup(); }
  });

  it('KNOWN-POSITIVE: agent restart (stamped pid replaced) MUST move the anchor', () => {
    const { proc, ctx, cleanup } = setup();
    try {
      stamp(ctx, 'engineer', 200);
      const before = collectSessionKeys(proc, ctx).get('engineer');
      rmSync(j(proc, '200'), { recursive: true, force: true });
      fakeProc(proc, 400, 'engineer', 12000);
      stamp(ctx, 'engineer', 400); // daemon re-stamps on the new spawn
      const after = collectSessionKeys(proc, ctx).get('engineer');
      expect(after).not.toBe(before);
      expect(after).toBe('400:12000');
    } finally { cleanup(); }
  });

  it('a STALE stamp (dead pid) falls back to the heuristic rather than being trusted', () => {
    const { proc, ctx, cleanup } = setup();
    try {
      stamp(ctx, 'engineer', 999); // no such pid
      expect(collectSessionKeys(proc, ctx).get('engineer')).toBe('100:1000');
    } finally { cleanup(); }
  });

  it('a MISMATCHED stamp (pid alive but tagged as another agent) falls back — trust is verified per read', () => {
    const { proc, ctx, cleanup } = setup();
    try {
      fakeProc(proc, 500, 'chief', 7000);
      stamp(ctx, 'engineer', 500); // points at chief's process
      expect(collectSessionKeys(proc, ctx).get('engineer')).toBe('100:1000');
    } finally { cleanup(); }
  });
});
