import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { readOrgContext, applyOrgContext } from '../../../src/utils/env.js';
import type { CtxEnv } from '../../../src/types/index.js';

// Guard for the 2026-07-14 arm-4 class: the daemon hand-builds each agent's
// CtxEnv and skips resolveEnv, so the context.json read that populates user-tz /
// day-window fields never ran for spawned agents — CTX_USER_TIMEZONE injected
// empty and the whole arm was a SILENT NO-OP that passed 2000 unit tests because
// nothing tested the daemon WIRING seam. These tests cover that seam, including
// the failure modes (absent / malformed / BOM), and encode the pre-fix behaviour
// as an explicit control so the test demonstrably discriminates fixed-from-broken.

let root: string;
const ORG = 'silvermere-tech';
function writeContext(obj: unknown, raw?: string) {
  mkdirSync(join(root, 'orgs', ORG), { recursive: true });
  writeFileSync(join(root, 'orgs', ORG, 'context.json'), raw ?? JSON.stringify(obj), 'utf-8');
}
const baseEnv = (): CtxEnv => ({
  instanceId: 'default', ctxRoot: '/x', frameworkRoot: root, agentName: 'engineer',
  agentDir: join(root, 'orgs', ORG, 'agents', 'engineer'), org: ORG, projectRoot: root,
});

beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'cortextos-orgctx-')); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

describe('readOrgContext — the single shared reader', () => {
  it('maps snake_case context.json keys to camelCase env fields', () => {
    writeContext({
      timezone: 'Asia/Dubai', orchestrator: 'chief',
      user_timezone: 'Europe/London', user_timezone_until: '2026-07-21',
      day_mode_start: '08:00', day_mode_end: '22:00',
    });
    expect(readOrgContext(root, ORG)).toEqual({
      timezone: 'Asia/Dubai', orchestrator: 'chief',
      userTimezone: 'Europe/London', userTimezoneUntil: '2026-07-21',
      dayModeStart: '08:00', dayModeEnd: '22:00',
    });
  });

  it('FAILURE MODE — absent context.json → {} (never throws)', () => {
    expect(readOrgContext(root, ORG)).toEqual({});
  });

  it('FAILURE MODE — malformed JSON → {} (never throws)', () => {
    writeContext(null, '{ this is not json ');
    expect(readOrgContext(root, ORG)).toEqual({});
  });

  it('FAILURE MODE — UTF-8 BOM (Windows tooling) is stripped, JSON still parses', () => {
    writeContext(null, '﻿' + JSON.stringify({ user_timezone: 'Europe/London' }));
    expect(readOrgContext(root, ORG).userTimezone).toBe('Europe/London');
  });

  it('empty projectRoot or org → {} (no path to read)', () => {
    expect(readOrgContext('', ORG)).toEqual({});
    expect(readOrgContext(root, '')).toEqual({});
  });

  it('missing individual keys → undefined for those, present ones set', () => {
    writeContext({ user_timezone: 'Europe/London' }); // no day_mode_*, no until
    const c = readOrgContext(root, ORG);
    expect(c.userTimezone).toBe('Europe/London');
    expect(c.userTimezoneUntil).toBeUndefined();
    expect(c.dayModeStart).toBeUndefined();
  });
});

describe('applyOrgContext — the daemon env-build SEAM (the thing that broke)', () => {
  it('populates userTimezone/day-window on a daemon-style hand-built env', () => {
    writeContext({ user_timezone: 'Europe/London', user_timezone_until: '2026-07-21', day_mode_start: '08:00' });
    const env = applyOrgContext(baseEnv());
    expect(env.userTimezone).toBe('Europe/London');
    expect(env.userTimezoneUntil).toBe('2026-07-21');
    expect(env.dayModeStart).toBe('08:00');
  });

  it('existing env values WIN over context.json (precedence: override/env var first)', () => {
    writeContext({ user_timezone: 'Europe/London', timezone: 'Asia/Dubai' });
    const env = applyOrgContext({ ...baseEnv(), userTimezone: 'America/New_York' });
    expect(env.userTimezone).toBe('America/New_York'); // not overwritten by context
    expect(env.timezone).toBe('Asia/Dubai'); // filled from context (was empty)
  });

  it('absent context → user-tz stays undefined → isDayMode falls back to agent tz (no regression)', () => {
    const env = applyOrgContext(baseEnv()); // no context.json written
    expect(env.userTimezone).toBeUndefined();
  });

  // ── RED-ON-OLD CONTROL ──────────────────────────────────────────────────────
  // Reproduce the pre-fix daemon: it hand-built the env and did NOT apply context.
  // This control proves the seam test above actually discriminates — the exact
  // arm-4 no-op (CTX_USER_TIMEZONE would inject empty) is what an un-applied env
  // produces, and it FAILS the same assertion the fixed path passes.
  it('CONTROL: the pre-fix hand-built env (no applyOrgContext) reproduces the no-op', () => {
    writeContext({ user_timezone: 'Europe/London' });
    const preFixEnv = baseEnv();                 // exactly what the daemon built before the fix
    expect(preFixEnv.userTimezone).toBeUndefined(); // → CTX_USER_TIMEZONE absent = the arm-4 silent no-op
    // and the fix flips it:
    expect(applyOrgContext(preFixEnv).userTimezone).toBe('Europe/London');
  });
});
