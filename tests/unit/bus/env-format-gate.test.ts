import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execSync } from 'child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { autoCommit, screenFile, isEnvFormatFile } from '../../../src/bus/system.js';

/**
 * ENV-FORMAT GATE (task_1784622395738, fix #1 — fail-closed the sole gate).
 *
 * Auto-commit's commit happens inside the call, so the content screen is the
 * ONLY thing standing between a staged file and history — the documented
 * post-stage agent review is structurally post-commit and can only detect,
 * never prevent.
 *
 * On a NAME=value-shaped file, the credential matcher's zero is double-
 * meaning: "no secrets" and "no shapes I know" print the same 0 (analyst,
 * 2026-07-21: her matcher returned 0 on three daemon env snapshots, and was
 * right only because the snapshots carried value LENGTHS, not values — a
 * future snapshot WITH values returns the same 0). A file class that exists
 * to carry secrets cannot be cleared by failing to match; it must be refused
 * as a class. Fail-closed: over-blocking a benign env-shaped file is visible
 * in blocked[] and can be exempted deliberately; under-blocking is silent.
 */

const ENV_SNAPSHOT_UNSEEABLE_VALUES = [
  // Every value here is INVISIBLE to the credential arms by construction:
  // digit-only (no alpha), alphabetic-only (the banked known-false-negative
  // class), or too short. If any line matched, this fixture would block as
  // credential_pattern_detected and prove nothing about the env gate.
  'ANTHROPIC_API_KEY=108',
  'TELEGRAM_BOT_TOKEN=46',
  'SHARED_PASSPHRASE=correcthorsebattery',
  'GATEWAY_SSH_PASSWORD=winterthorn',
  'CTX_AGENT_NAME=engineer',
  'CTX_ORG=silvermere',
  'EMBEDDING_BACKEND=local',
].join('\n') + '\n';

describe('isEnvFormatFile: the shape classifier', () => {
  it('classifies a daemon env snapshot (names + unseeable values) as env-format', () => {
    expect(isEnvFormatFile(ENV_SNAPSHOT_UNSEEABLE_VALUES)).toBe(true);
  });

  it('ignores blank lines and # comments when computing the ratio', () => {
    const content = '# daemon env snapshot\n\n' + ENV_SNAPSHOT_UNSEEABLE_VALUES + '\n# end\n';
    expect(isEnvFormatFile(content)).toBe(true);
  });

  it('does NOT classify prose with a few inline env examples', () => {
    const prose = Array.from({ length: 20 }, (_, i) => `Ordinary note line ${i} about the day.`);
    prose.push('FOO_EXAMPLE=abc', 'BAR_EXAMPLE=def');
    expect(isEnvFormatFile(prose.join('\n'))).toBe(false);
  });

  it('does NOT classify shell scripts (export VAR=... does not match the bare NAME= shape)', () => {
    const script = [
      '#!/bin/bash',
      'set -euo pipefail',
      'export XDG_RUNTIME_DIR=/run/user/1001',
      'export DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/1001/bus',
      'systemctl --user daemon-reload',
      'systemctl --user enable --now myunit',
    ].join('\n');
    expect(isEnvFormatFile(script)).toBe(false);
  });

  it('does NOT classify JSON', () => {
    expect(isEnvFormatFile('{\n  "a": 1,\n  "b": "x",\n  "c": true,\n  "d": null,\n  "e": 2\n}\n')).toBe(false);
  });

  // STATED LIMITATION, asserted so it cannot drift silently: below the
  // 4-matching-line floor the gate stays out of the way — tiny env-shaped
  // fragments in prose are common, and the credential arms still screen
  // every line of them. The floor is a trade, not an oversight.
  it('stated floor: 3 env lines do not trip the class gate', () => {
    expect(isEnvFormatFile('A_ONE=x\nB_TWO=y\nC_THREE=z\n')).toBe(false);
  });
});

describe('env-format gate: both screening paths refuse the class', () => {
  let gitDir: string;

  beforeEach(() => {
    gitDir = mkdtempSync(join(tmpdir(), 'cortextos-envgate-test-'));
    execSync('git init', { cwd: gitDir, stdio: 'pipe' });
    execSync('git config user.email t@t.t', { cwd: gitDir, stdio: 'pipe' });
    execSync('git config user.name t', { cwd: gitDir, stdio: 'pipe' });
  });
  afterEach(() => rmSync(gitDir, { recursive: true, force: true }));

  it('screenFile blocks an env snapshot whose values the credential arms cannot see', () => {
    const p = join(gitDir, 'daemon-env-snapshot.txt');
    writeFileSync(p, ENV_SNAPSHOT_UNSEEABLE_VALUES);
    expect(screenFile(p, 'daemon-env-snapshot.txt')).toBe('env_format');
  });

  it('autoCommit (shared-tree path) agrees — parity, not a comment', () => {
    writeFileSync(join(gitDir, 'daemon-env-snapshot.txt'), ENV_SNAPSHOT_UNSEEABLE_VALUES);
    writeFileSync(join(gitDir, 'readme.md'), 'ordinary notes');

    const report = autoCommit(gitDir, true);
    expect(report.blocked).toContain('daemon-env-snapshot.txt:env_format');
    expect(report.staged).toContain('readme.md');
    expect(report.staged).not.toContain('daemon-env-snapshot.txt');
  });

  it('a real .env still blocks by NAME first (env_format never masks the name gate)', () => {
    const p = join(gitDir, '.env');
    writeFileSync(p, ENV_SNAPSHOT_UNSEEABLE_VALUES);
    expect(screenFile(p, '.env')).toBe('contains_credentials');
  });

  it('env_format is policy-class: it does not raise a blocked_text incident row', () => {
    writeFileSync(join(gitDir, 'daemon-env-snapshot.txt'), ENV_SNAPSHOT_UNSEEABLE_VALUES);
    writeFileSync(join(gitDir, 'readme.md'), 'ordinary notes');

    const report = autoCommit(gitDir, true);
    expect(report.blocked).toContain('daemon-env-snapshot.txt:env_format');
    expect(report.blocked_text.some(e => e.endsWith(':env_format'))).toBe(false);
  });
});

describe('size-boundary fail-open: a file of exactly MAX_FILE_SIZE must still be screened', () => {
  // Before this gate, `size > MAX` blocked and `size < MAX` screened — a file of
  // EXACTLY 10MB passed both conditions untouched and staged unscreened. The
  // screen's coverage must be total: over the cap blocks as over_10MB,
  // everything else gets its content read.
  const MAX_FILE_SIZE = 10 * 1024 * 1024; // mirror of src/bus/system.ts:383

  let gitDir: string;

  beforeEach(() => {
    gitDir = mkdtempSync(join(tmpdir(), 'cortextos-sizeedge-test-'));
    execSync('git init', { cwd: gitDir, stdio: 'pipe' });
    execSync('git config user.email t@t.t', { cwd: gitDir, stdio: 'pipe' });
    execSync('git config user.name t', { cwd: gitDir, stdio: 'pipe' });
  });
  afterEach(() => rmSync(gitDir, { recursive: true, force: true }));

  function exactlyMaxSizeWithCredential(): Buffer {
    const cred = 'api_token=abc123def456ghi789\n';
    const pad = Buffer.alloc(MAX_FILE_SIZE - cred.length, 0x61); // 'a'
    return Buffer.concat([Buffer.from(cred), pad]);
  }

  it('screenFile screens a file of exactly MAX_FILE_SIZE (credential inside must block)', () => {
    const p = join(gitDir, 'exactly-10mb.txt');
    writeFileSync(p, exactlyMaxSizeWithCredential());
    expect(screenFile(p, 'exactly-10mb.txt')).toBe('credential_pattern_detected');
  });

  it('autoCommit screens a file of exactly MAX_FILE_SIZE too (parity)', () => {
    writeFileSync(join(gitDir, 'exactly-10mb.txt'), exactlyMaxSizeWithCredential());
    const report = autoCommit(gitDir, true);
    expect(report.blocked).toContain('exactly-10mb.txt:credential_pattern_detected');
    expect(report.staged).not.toContain('exactly-10mb.txt');
  });
});
