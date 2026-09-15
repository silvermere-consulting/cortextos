import { describe, it, expect } from 'vitest';
import {
  evaluateSlope, applySlopeToAnomalies, evaluateAllSlopes,
  DEFAULT_SLOPE_THRESHOLDS, slopeThresholdsFromEnv,
  type MemorySample, type SlopeVerdict,
} from '../../../src/bus/memory-slope.js';
import type { MemoryAnomaly, MemorySnapshot } from '../../../src/bus/agent-memory.js';

// The slope arm gates on session_pss_mb (2026-09-15 swap, class rss_mb_is_a_tree_sum; tuple by
// analyst, task_1784816241829). These fixtures are the ship-gate, all through the evaluator's own
// path: a sustained PSS riser MUST fire (WARNING with headroom, CRITICAL when constrained), while
// three distinct negatives — low-rate, rate-gates-despite-rise>100, and a last-sample spike whose
// regression slope PASSES so only the spike-guard stops it — MUST stay silent. Each gate is proven
// independently. No agent name appears in any predicate. Series values are session_pss_mb (MB); the
// arm REBASELINES by dropping the first post-restart sample, so a fixture needs min_samples+1 raw
// points to leave min_samples after the drop.

function series(agent: string, key: string, startIso: string, stepH: number, pss: number[]): MemorySample[] {
  const t0 = Date.parse(startIso);
  return pss.map((mb, i) => ({
    ts: new Date(t0 + i * stepH * 3_600_000).toISOString(),
    agent, rss_mb: mb, session_key: key, session_pss_mb: mb,
  }));
}

describe('evaluateSlope — known-positive', () => {
  it('FIRES on a sustained PSS riser: 25 MB/h across a session (rebaselined, spread across samples)', () => {
    // 5 raw samples @ 2h; drop the first (340) -> [390,440,490,540] over 6h: rise 150 (>=100),
    // regression slope 25 (>=20), max single delta 50 = 33% of rise (< 50% spike-guard) -> rising.
    const s = series('research', '123:456', '2026-07-14T00:00:00Z', 2, [340, 390, 440, 490, 540]);
    const v = evaluateSlope(s)!;
    expect(v.verdict).toBe('rising');
    expect(v.rate_mb_per_h).toBeGreaterThanOrEqual(20);
    expect(v.rise_mb).toBeGreaterThanOrEqual(100);
  });

  it('fires on a real-envelope PSS leak (session sitting mid-band, climbing steadily)', () => {
    // 340->540 is entirely within the observed PSS envelope (boot ~285, peak <=548); the point is a
    // sustained climb is caught regardless of absolute level — the band the old tree-sum arm drowned.
    const s = series('engineer', '9:9', '2026-07-14T00:00:00Z', 1, [300, 350, 400, 450, 500, 540]);
    const v = evaluateSlope(s)!;
    expect(v.verdict).toBe('rising');
  });
});

describe('evaluateSlope — known-negatives', () => {
  it('does NOT fire on a flat-high PSS baseline (~500MB +/- jitter)', () => {
    const s = series('engineer', '1:1', '2026-07-14T00:00:00Z', 1,
      [500, 510, 495, 505, 515, 500, 490, 508, 502]);
    const v = evaluateSlope(s)!;
    expect(v.verdict).toBe('flat');
  });

  it('does NOT fire on the daily-restart sawtooth: rising day resets with a NEW session key', () => {
    // Session A climbs, restart, session B starts fresh with only 2 samples. Keyed to the LATEST
    // session: 2 raw -> 1 after the rebaseline drop -> insufficient; never stitched across the restart.
    const a = series('engineer', 'A:100', '2026-07-14T00:00:00Z', 1, [400, 500, 550, 560]);
    const b = series('engineer', 'B:999', '2026-07-14T05:00:00Z', 1, [300, 350]);
    const v = evaluateSlope([...a, ...b])!;
    expect(v.verdict).toBe('insufficient');
    expect(v.session_key).toBe('B:999');
  });

  it('RATE GATES despite rise>100: a long benign session at 13.6 MB/h stays silent (rate ANDed with rise)', () => {
    // 6 raw @ 2.5h; drop first (300) -> [350,384,418,452,486] over 10h: rebaselined rise 136 (>=100)
    // but regression slope 13.6 (<20). If this fired, rate would not be gating.
    const s = series('writer', '2:2', '2026-07-14T00:00:00Z', 2.5, [300, 350, 384, 418, 452, 486]);
    const v = evaluateSlope(s)!;
    expect(v.verdict).toBe('flat');
    expect(v.rise_mb).toBeGreaterThanOrEqual(100);      // rise clears its floor...
    expect(v.rate_mb_per_h).toBeLessThan(20);           // ...and rate is what holds it silent
  });

  it('SPIKE-GUARD rejects a last-sample spike whose regression slope PASSES (guard is load-bearing)', () => {
    // 5 raw @ 2h; drop first (398) -> [400,402,404,704] over 6h: rise 304, regression slope ~46 (>=20,
    // so the RATE gate passes) but the last delta 300 is ~99% of the rise (>50%) -> spike-guard rejects.
    // Only the spike-guard stops this; the rate gate alone would fire (the research-FP shape).
    const s = series('research', '4:4', '2026-07-14T00:00:00Z', 2, [398, 400, 402, 404, 704]);
    const v = evaluateSlope(s)!;
    expect(v.verdict).not.toBe('rising');
    expect(v.rate_mb_per_h).toBeGreaterThanOrEqual(20); // rate PASSED — proves only the spike-guard rejected it
  });

  it('does NOT fire on spike-then-recede: a mid-series peak that recedes is not a leak', () => {
    // The OLD rss-contract suite covered this via a stillNearPeak guard; under the PSS logic the
    // rise-uses-LAST (not max) handles it: drop first (350) -> [450,540,400,410], rise = 410-450 = -40
    // (below floor) and regression slope negative -> flat. Kept so the negative coverage does not drop
    // when the guard mechanism changed.
    const s = series('writer', '2:2', '2026-07-14T00:00:00Z', 1, [350, 450, 540, 400, 410]);
    const v = evaluateSlope(s)!;
    expect(v.verdict).not.toBe('rising');
  });

  it('GLITCH FILTER: a phantom sub-50 PSS reading cannot manufacture a rising verdict', () => {
    // Without the filter, dropping series[0]=520 would anchor the rebaseline on the 33 glitch and read
    // a ~490MB phantom rise. Filtering PSS<50 first leaves a flat session -> flat.
    const s = series('othe', '5:5', '2026-07-14T00:00:00Z', 1, [520, 33, 510, 515, 520, 525]);
    const v = evaluateSlope(s)!;
    expect(v.verdict).not.toBe('rising');
  });

  it('refuses a verdict on insufficient samples or span (no invented flat)', () => {
    const few = series('jones', '3:3', '2026-07-14T00:00:00Z', 1, [500, 800]); // 2 raw -> 1 post-drop
    expect(evaluateSlope(few)!.verdict).toBe('insufficient');
    const narrow = series('jones', '3:3', '2026-07-14T00:00:00Z', 0.2, [500, 520, 540, 560, 580]); // 5 raw, 0.8h span
    expect(evaluateSlope(narrow)!.verdict).toBe('insufficient');
  });

  it('ignores samples with unknown session keys (no series across the unknown)', () => {
    const s = series('othe', '', '2026-07-14T00:00:00Z', 1, [400, 460, 520, 580, 640, 700]);
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

  it('PRESSURE-tiers the slope severity: WARNING with headroom, CRITICAL when host-constrained', () => {
    const relaxed = applySlopeToAnomalies([], [rising('research')], false).anomalies[0];
    expect(relaxed.kind).toBe('memory_slope');
    expect(relaxed.severity).toBe('warning'); // early warning — a PSS leak has days of runway
    const constrained = applySlopeToAnomalies([], [rising('research')], true).anomalies[0];
    expect(constrained.kind).toBe('memory_slope');
    expect(constrained.severity).toBe('critical'); // rising AND the box is tight = act now
  });
});

describe('evaluateAllSlopes + env thresholds', () => {
  it('evaluates each snapshot agent against its own history only', () => {
    const snap: MemorySnapshot = {
      agents: [{ agent: 'a1', rss_mb: 700, procs: 1 }, { agent: 'a2', rss_mb: 500, procs: 1 }],
      mem_total_mb: 16000, mem_available_mb: 8000, available_pct: 50,
    };
    const hist = [
      // 5 raw each so 4 survive the rebaseline drop. a1 climbs 50 MB/h -> rising; a2 flat.
      ...series('a1', 'k1', '2026-07-14T00:00:00Z', 1, [350, 400, 450, 500, 550]),
      ...series('a2', 'k2', '2026-07-14T00:00:00Z', 1, [500, 500, 501, 500, 500]),
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
