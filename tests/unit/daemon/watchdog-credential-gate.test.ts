import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { FrozenTurnWatchdog } from '../../../src/daemon/frozen-turn-watchdog';
import {
  CredentialRefresher,
  buildCredentialGate,
  accountsPath,
  credentialsPath,
  type TokenFamily,
} from '../../../src/daemon/credential-refresh';

// F2: the credential gate. A restart cannot mint a credential, so when the
// credential is provably dead the watchdog HOLDS — no restart, no attempt
// slot, no in-band escalation to an equally-dead orchestrator; the refresher
// owns the paging. CANNOT_TELL and gate errors fail OPEN toward recovery: a
// wrong restart costs a wasted rung; a wrong hold costs an unrecovered
// agent (chief's asymmetry, 2026-07-21).
//
// The final test is chief's acceptance test: REPLAY LAST NIGHT against this
// code — 8 agents frozen on a dead credential must produce zero respawns,
// zero in-band escalations, one refresher page, one common-mode page.

const T0 = Date.parse('2026-07-20T23:44:00Z');
const MIN = 60_000;
const ORG = 'silvermere-tech';

let ctxRoot: string;
let home: string;

function iso(ms: number): string {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function writeFires(agent: string, fireMs: number[]): void {
  const dir = join(ctxRoot, '.cortextOS', 'state', 'agents', agent);
  mkdirSync(dir, { recursive: true });
  const rows = fireMs.map((ms) => ({ ts: iso(ms), cron: 'heartbeat', status: 'fired', attempt: 1, duration_ms: 5, error: null }));
  writeFileSync(join(dir, 'cron-execution.log'), rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
}

function writeHeartbeat(agent: string, lastHeartbeatMs: number): void {
  const dir = join(ctxRoot, 'state', agent);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'heartbeat.json'), JSON.stringify({
    agent, org: ORG, status: 'working', current_task: '', mode: 'night',
    last_heartbeat: iso(lastHeartbeatMs), loop_interval: '1h',
  }));
}

function freezeAgentAt(agent: string, freezeMs: number): void {
  writeFires(agent, [freezeMs - 30 * MIN, freezeMs - 15 * MIN]);
  writeHeartbeat(agent, freezeMs - 60 * MIN);
}

function writeDeadCredential(expiredAtMs: number): TokenFamily {
  const family: TokenFamily = {
    access_token: 'sk-ant-oat01-DEAD',
    refresh_token: 'sk-ant-ort01-DEAD',
    expires_at: expiredAtMs,
  };
  mkdirSync(join(ctxRoot, 'state', 'oauth'), { recursive: true });
  writeFileSync(accountsPath(ctxRoot), JSON.stringify({
    active: 'primary',
    accounts: { primary: { label: 'primary', ...family, last_refreshed: iso(expiredAtMs - 8 * 60 * MIN) } },
    rotation_log: [],
  }));
  mkdirSync(join(home, '.claude'), { recursive: true });
  writeFileSync(credentialsPath(home), JSON.stringify({
    claudeAiOauth: { accessToken: family.access_token, refreshToken: family.refresh_token, expiresAt: family.expires_at },
  }));
  return family;
}

beforeEach(() => {
  ctxRoot = mkdtempSync(join(tmpdir(), 'wd-gate-ctx-'));
  home = mkdtempSync(join(tmpdir(), 'wd-gate-home-'));
});
afterEach(() => {
  rmSync(ctxRoot, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
});

interface Harness {
  wd: FrozenTurnWatchdog;
  restarts: string[];
  escalations: string[];
  pages: string[];
  events: { event: string; meta: Record<string, unknown> }[];
  setNow: (ms: number) => void;
}

function mkWatchdog(agents: string[], opts: {
  gate?: () => Promise<{ ok: boolean; reason: string }>;
  now?: number;
}): Harness {
  let nowMs = opts.now ?? T0;
  const restarts: string[] = [];
  const escalations: string[] = [];
  const pages: string[] = [];
  const events: { event: string; meta: Record<string, unknown> }[] = [];
  const wd = new FrozenTurnWatchdog({
    ctxRoot,
    getRunningAgents: () => agents,
    resolveOrg: () => ORG,
    restartAgent: async (a) => { restarts.push(a); },
    escalate: (d) => { escalations.push(d.agent); },
    pageOperator: (m) => { pages.push(m); return true; },
    recordEvent: (e) => { events.push({ event: e.event, meta: e.meta }); },
    credentialGate: opts.gate,
    logger: () => {},
    now: () => nowMs,
  });
  return { wd, restarts, escalations, pages, events, setNow: (ms) => { nowMs = ms; } };
}

describe('watchdog credential gate', () => {
  it('gate ok:false → HOLD: no restart, no attempt slot, event emitted', async () => {
    freezeAgentAt('engineer', T0);
    const h = mkWatchdog(['engineer'], { gate: async () => ({ ok: false, reason: 'credential expired' }) });
    await h.wd.tick();
    expect(h.restarts).toHaveLength(0);
    const holds = h.events.filter((e) => e.event === 'watchdog_hold_credential');
    expect(holds).toHaveLength(1);
    expect(holds[0].meta.reason).toContain('expired');
  });

  it('held rungs are NOT burned: when the credential returns, recovery starts at rung 1', async () => {
    freezeAgentAt('engineer', T0);
    let credDead = true;
    const h = mkWatchdog(['engineer'], { gate: async () => credDead ? { ok: false, reason: 'dead' } : { ok: true, reason: 'ok' } });

    await h.wd.tick(); // held
    h.setNow(T0 + 6 * MIN); // past the verify window
    await h.wd.tick(); // held again
    expect(h.restarts).toHaveLength(0);

    credDead = false;
    h.setNow(T0 + 12 * MIN);
    await h.wd.tick();
    expect(h.restarts).toEqual(['engineer']); // rung 1, not rung 3
    const restartEvents = h.events.filter((e) => e.event === 'watchdog_auto_restart');
    expect(restartEvents[0].meta.attempt).toBe(1); // no slots were burned by the holds
  });

  it('gate ok:true → normal ladder (rung 1 restart)', async () => {
    freezeAgentAt('engineer', T0);
    const h = mkWatchdog(['engineer'], { gate: async () => ({ ok: true, reason: 'token verified' }) });
    await h.wd.tick();
    expect(h.restarts).toEqual(['engineer']);
  });

  it('gate THROWS → fail open toward recovery (restart happens)', async () => {
    freezeAgentAt('engineer', T0);
    const h = mkWatchdog(['engineer'], { gate: async () => { throw new Error('gate exploded'); } });
    await h.wd.tick();
    expect(h.restarts).toEqual(['engineer']);
  });

  it('no gate wired → behaviour unchanged', async () => {
    freezeAgentAt('engineer', T0);
    const h = mkWatchdog(['engineer'], {});
    await h.wd.tick();
    expect(h.restarts).toEqual(['engineer']);
  });

  it('common-mode arm pages REGARDLESS of the gate holding every rung', async () => {
    const agents = ['chief', 'engineer', 'writer'];
    for (const a of agents) freezeAgentAt(a, T0);
    const h = mkWatchdog(agents, { gate: async () => ({ ok: false, reason: 'credential expired' }) });
    await h.wd.tick();
    expect(h.restarts).toHaveLength(0); // gate held everything
    expect(h.pages).toHaveLength(1); // and the fleet-wide alarm still fired
    expect(h.pages[0]).toContain('COMMON-MODE');
  });
});

describe('buildCredentialGate', () => {
  it('expired-on-disk family → ok:false without probing (probe must not be called)', async () => {
    writeDeadCredential(T0 - 60 * MIN);
    const gate = buildCredentialGate({
      ctxRoot, homeDir: home, now: () => T0,
      probe: async () => { throw new Error('probe must not be called for an expired family'); },
    });
    const r = await gate();
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('expired');
  });

  it('healthy expiry + TOKEN_BAD probe → ok:false; CANNOT_TELL → ok:true (fail open)', async () => {
    writeDeadCredential(T0 + 60 * MIN); // valid-looking expiry
    const bad = buildCredentialGate({ ctxRoot, homeDir: home, now: () => T0, probe: async () => ({ verdict: 'TOKEN_BAD', detail: '401' }) });
    expect((await bad()).ok).toBe(false);
    const blip = buildCredentialGate({ ctxRoot, homeDir: home, now: () => T0, probe: async () => ({ verdict: 'CANNOT_TELL', detail: '429' }) });
    const r = await blip();
    expect(r.ok).toBe(true);
    expect(r.reason).toContain('failing open');
  });

  it('memoizes: eight callers in one window cost one probe', async () => {
    writeDeadCredential(T0 + 60 * MIN);
    let probes = 0;
    const gate = buildCredentialGate({
      ctxRoot, homeDir: home, now: () => T0,
      probe: async () => { probes++; return { verdict: 'VALID', detail: 'ok' }; },
    });
    for (let i = 0; i < 8; i++) await gate();
    expect(probes).toBe(1);
  });

  it('no stores at all → ok:true (nothing to judge; recovery proceeds)', async () => {
    const gate = buildCredentialGate({ ctxRoot, homeDir: home, now: () => T0 });
    expect((await gate()).ok).toBe(true);
  });
});

describe('THE REPLAY (chief acceptance): last night against the built system', () => {
  it('8 agents frozen on a dead credential → 0 respawns, 0 in-band escalations, 1 refresher page, 1 common-mode page', async () => {
    // The real population: 8 agents, all frozen by ~21:20Z credential expiry.
    const agents = ['chief', 'engineer', 'analyst', 'business-analyst', 'research', 'writer', 'othe', 'jones'];
    for (const a of agents) freezeAgentAt(a, T0);
    writeDeadCredential(Date.parse('2026-07-20T21:20:00Z'));

    // The gate exactly as the daemon wires it (real reader + real ladder;
    // probe irrelevant — expiry short-circuits it).
    const gate = buildCredentialGate({ ctxRoot, homeDir: home, now: () => T0 });

    const h = mkWatchdog(agents, { gate });
    // The refresher exactly as the daemon wires it, exchange failing the way
    // it provably did all night (~16 fresh boots never self-refreshed).
    const refresherPages: string[] = [];
    const refresher = new CredentialRefresher({
      ctxRoot, homeDir: home, now: () => T0, log: () => {},
      page: (m) => { refresherPages.push(m); return true; },
      exchange: async () => { throw new Error('invalid_grant'); },
      probe: async () => ({ verdict: 'CANNOT_TELL', detail: 'unused' }),
    });

    // One watchdog pass + one refresher pass = the first cycle of the night.
    await h.wd.tick();
    await refresher.tick();

    // Last night: ~16 respawns, 64 escalations (40 into chief's dead
    // session), 24 pages at the wrong human, 8 hours of silence to Steven.
    // Under the built system:
    expect(h.restarts).toHaveLength(0);                          // zero pointless respawns
    expect(h.escalations).toHaveLength(0);                       // zero in-band escalations
    expect(h.pages).toHaveLength(1);                             // one common-mode page…
    expect(h.pages[0]).toContain('8 of 8');                      // …naming the whole fleet
    expect(refresherPages).toHaveLength(1);                      // one refresher page…
    expect(refresherPages[0]).toContain('CREDENTIAL DEAD');      // …naming the exact state
    expect(refresherPages[0]).toContain('/login');               // …and the fix
    const holds = h.events.filter((e) => e.event === 'watchdog_hold_credential');
    expect(holds).toHaveLength(8);                               // every hold is on the record
  });
});
