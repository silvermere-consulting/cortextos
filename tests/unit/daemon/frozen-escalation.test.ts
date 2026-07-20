import { describe, it, expect } from 'vitest';
import {
  deriveFrozenEscalationTarget,
  escalateFrozenTurnImpl,
  FrozenEscalationDeps,
} from '../../../src/daemon/index';
import type { FrozenTurnDetail } from '../../../src/daemon/frozen-turn-watchdog';

// Regression guard for the 2026-07-19 blind spot: rung-3 freeze escalation
// early-returned when the wedged agent WAS the org's orchestrator, so the one
// agent that routes every decision to the human (chief) was the one agent the
// alarm could not report. Every input must now map to a target — orchestrator
// bus message normally, direct operator page when the orchestrator is the
// subject or unresolvable. There is no drop arm.

function detail(agent: string): FrozenTurnDetail {
  return { agent, attempt: 3, cold: false, unansweredFires: 4, lastRealHeartbeat: '2026-07-19T20:00:00Z' };
}

interface Recorded {
  busSends: Array<{ org: string; to: string; text: string }>;
  pages: string[];
  logs: string[];
}

function mkDeps(opts: { orchestrator?: string; pageOk?: boolean }): { deps: FrozenEscalationDeps; rec: Recorded } {
  const rec: Recorded = { busSends: [], pages: [], logs: [] };
  const deps: FrozenEscalationDeps = {
    resolveOrchestrator: () => opts.orchestrator,
    sendToAgent: (org, to, text) => rec.busSends.push({ org, to, text }),
    pageOperator: (message) => { rec.pages.push(message); return opts.pageOk ?? true; },
    log: (msg) => rec.logs.push(msg),
  };
  return { deps, rec };
}

describe('deriveFrozenEscalationTarget', () => {
  it('routes a normal frozen agent to the orchestrator', () => {
    expect(deriveFrozenEscalationTarget('chief', 'engineer'))
      .toEqual({ kind: 'orchestrator', orchestrator: 'chief' });
  });

  it('routes a frozen orchestrator to the operator page — never back to itself', () => {
    expect(deriveFrozenEscalationTarget('chief', 'chief'))
      .toEqual({ kind: 'operator', reason: 'subject-is-orchestrator' });
  });

  it('routes to the operator page when no orchestrator resolves', () => {
    expect(deriveFrozenEscalationTarget(undefined, 'chief'))
      .toEqual({ kind: 'operator', reason: 'no-orchestrator' });
  });

  it('has no drop arm: every input yields a target', () => {
    for (const orch of ['chief', '', undefined]) {
      for (const agent of ['chief', 'engineer']) {
        const t = deriveFrozenEscalationTarget(orch, agent);
        expect(['orchestrator', 'operator']).toContain(t.kind);
      }
    }
  });
});

describe('escalateFrozenTurnImpl — watched-fire of both branches', () => {
  it('normal agent: bus message reaches the orchestrator, operator NOT paged', () => {
    const { deps, rec } = mkDeps({ orchestrator: 'chief' });
    const target = escalateFrozenTurnImpl(detail('engineer'), 'silvermere-tech', deps);

    expect(target.kind).toBe('orchestrator');
    expect(rec.busSends).toHaveLength(1);
    expect(rec.busSends[0].to).toBe('chief');
    expect(rec.busSends[0].org).toBe('silvermere-tech');
    expect(rec.busSends[0].text).toContain('engineer');
    expect(rec.busSends[0].text).toContain('4 unanswered heartbeat fires');
    expect(rec.pages).toHaveLength(0);
  });

  it('frozen ORCHESTRATOR: operator page fires — the pre-fix silent-drop branch', () => {
    const { deps, rec } = mkDeps({ orchestrator: 'chief' });
    const target = escalateFrozenTurnImpl(detail('chief'), 'silvermere-tech', deps);

    expect(target).toEqual({ kind: 'operator', reason: 'subject-is-orchestrator' });
    expect(rec.busSends).toHaveLength(0); // never consult the wedged party
    expect(rec.pages).toHaveLength(1);
    expect(rec.pages[0]).toContain('chief');
    expect(rec.pages[0]).toContain('IS the orchestrator');
    expect(rec.pages[0]).toContain('cortextos restart chief');
  });

  it('org unresolvable: operator page fires instead of the old silent return', () => {
    const { deps, rec } = mkDeps({ orchestrator: 'chief' });
    const target = escalateFrozenTurnImpl(detail('stray'), undefined, deps);

    expect(target).toEqual({ kind: 'operator', reason: 'no-orchestrator' });
    expect(rec.busSends).toHaveLength(0);
    expect(rec.pages).toHaveLength(1);
  });

  it('no orchestrator in context.json: operator page fires', () => {
    const { deps, rec } = mkDeps({ orchestrator: undefined });
    const target = escalateFrozenTurnImpl(detail('engineer'), 'some-org', deps);

    expect(target).toEqual({ kind: 'operator', reason: 'no-orchestrator' });
    expect(rec.pages).toHaveLength(1);
  });

  it('operator page delivery failure is LOUD, not silent', () => {
    const { deps, rec } = mkDeps({ orchestrator: 'chief', pageOk: false });
    escalateFrozenTurnImpl(detail('chief'), 'silvermere-tech', deps);

    expect(rec.logs.some((l) => l.includes('OPERATOR PAGE FAILED'))).toBe(true);
  });
});
