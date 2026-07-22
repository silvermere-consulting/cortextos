import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { checkRecipient, buildRefusal, priorityBodyMismatch } from '../../../src/bus/recipient-check';
import { sendMessage, checkInbox } from '../../../src/bus/message';
import type { BusPaths } from '../../../src/types';

// The 2026-07-22 send-path fix: 87 messages to nonexistent recipients sat unread
// for 69 days because the old path warned "may never be read" AND QUEUED ANYWAY.
// These tests hold the fail-closed contract: refuse means the message does not
// queue, and the refusal teaches the correct tool at the moment of error.

describe('checkRecipient', () => {
  let projectRoot: string;

  beforeEach(() => {
    projectRoot = mkdtempSync(join(tmpdir(), 'cortextos-recipient-test-'));
    mkdirSync(join(projectRoot, 'orgs', 'acme', 'agents', 'chief'), { recursive: true });
    mkdirSync(join(projectRoot, 'orgs', 'acme', 'agents', 'engineer'), { recursive: true });
    mkdirSync(join(projectRoot, 'orgs', 'family', 'agents', 'jones'), { recursive: true });
  });

  afterEach(() => rmSync(projectRoot, { recursive: true, force: true }));

  it('known-positive: an existing agent in any org passes', () => {
    expect(checkRecipient(projectRoot, 'chief').exists).toBe(true);
    expect(checkRecipient(projectRoot, 'jones').exists).toBe(true); // cross-org
  });

  it('known-negative: a typed name with no agent dir refuses', () => {
    expect(checkRecipient(projectRoot, 'perkins').exists).toBe(false);
  });

  it('a STOPPED agent (dir exists, not running) is still a valid recipient — its inbox is consumed at next boot', () => {
    // Existence criterion is the dir, deliberately: nothing about running state.
    mkdirSync(join(projectRoot, 'orgs', 'acme', 'agents', 'othe'), { recursive: true });
    expect(checkRecipient(projectRoot, 'othe').exists).toBe(true);
  });

  it('human-alias names are flagged for message sharpening but classified identically (refused)', () => {
    for (const name of ['human', 'steven', 'steve', 'user', 'admin']) {
      const c = checkRecipient(projectRoot, name);
      expect(c.exists).toBe(false);
      expect(c.looksHuman).toBe(true);
    }
    // An unlisted human name still fails safe: generic refusal, same outcome.
    const c = checkRecipient(projectRoot, 'perkins');
    expect(c.exists).toBe(false);
    expect(c.looksHuman).toBe(false);
  });

  it('missing orgs dir refuses everything (fail closed, never fail open)', () => {
    const empty = mkdtempSync(join(tmpdir(), 'cortextos-noorgs-'));
    try {
      expect(checkRecipient(empty, 'chief').exists).toBe(false);
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });
});

describe('buildRefusal', () => {
  const check = { exists: false, looksHuman: true, knownAgents: ['chief', 'engineer'] };

  it('names BOTH redirections — human path and force-queue — regardless of classification', () => {
    for (const c of [check, { ...check, looksHuman: false }]) {
      const text = buildRefusal('steven', c);
      expect(text).toContain('NOT queued');
      expect(text).toContain('create-task "[HUMAN]');
      expect(text).toContain('--force-queue');
      expect(text).toContain('chief, engineer');
    }
  });

  it('human-alias refusal carries the measured cost so the redirect is load-bearing, not scolding', () => {
    expect(buildRefusal('steven', check)).toContain('87 messages');
  });
});

describe('priorityBodyMismatch', () => {
  it('fires when body asserts urgency the envelope does not carry', () => {
    expect(priorityBodyMismatch('normal', 'please handle [high] item')).toContain('envelope');
    expect(priorityBodyMismatch('low', '[urgent] fix now')).toContain('envelope');
    expect(priorityBodyMismatch('normal', '[HUMAN] needs Steve')).toContain('create-task');
  });

  it('stays silent when envelope and body agree — a quiet fleet must not read as faulty', () => {
    expect(priorityBodyMismatch('high', 'please handle [high] item')).toBeNull();
    expect(priorityBodyMismatch('urgent', '[urgent] fix now')).toBeNull();
    expect(priorityBodyMismatch('normal', 'ordinary message, no tags')).toBeNull();
  });
});

describe('value-bearing round-trip (the presentation-layer fixture)', () => {
  // A value corrupted by formatting looks delivered. This fixture holds the BUS
  // layer's half of that contract: underscored credential names and shell
  // metacharacters survive sendMessage -> on-disk file -> checkInbox verbatim.
  let testDir: string;
  let paths: BusPaths;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'cortextos-roundtrip-'));
    paths = {
      ctxRoot: testDir,
      inbox: join(testDir, 'inbox', 'receiver'),
      inflight: join(testDir, 'inflight', 'receiver'),
      processed: join(testDir, 'processed', 'receiver'),
      logDir: join(testDir, 'logs', 'receiver'),
      stateDir: join(testDir, 'state', 'receiver'),
      taskDir: join(testDir, 'tasks'),
      approvalDir: join(testDir, 'approvals'),
      analyticsDir: join(testDir, 'analytics'),
      deliverablesDir: join(testDir, 'deliverables'),
    } as BusPaths;
  });

  afterEach(() => rmSync(testDir, { recursive: true, force: true }));

  it('underscored credential names + metachar command block survive intact', () => {
    const payload = [
      'Rotate GITHUB_PAT and GITHUB_PAT_SILVERMERE_CONSULTING today.',
      'Verify with: journalctl -u thing 2>&1 | grep -c "ok" && echo done > /tmp/out',
      'Backticks `like this` and $VARS and [brackets] must not change.',
    ].join('\n');
    sendMessage(paths, 'sender', 'receiver', 'normal', payload);
    // Byte layer: the stored file carries the exact text.
    const files = readdirSync(paths.inbox);
    expect(files.length).toBe(1);
    const stored = JSON.parse(readFileSync(join(paths.inbox, files[0]), 'utf-8'));
    expect(stored.text).toBe(payload);
    // Read layer: checkInbox returns it verbatim.
    const messages = checkInbox(paths);
    expect(messages.length).toBe(1);
    expect(messages[0].text).toBe(payload);
  });
});
