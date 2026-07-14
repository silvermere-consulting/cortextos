import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { execSync } from 'child_process';
import { selfRestart, hardRestart, autoCommit, autoCommitAgentRepo, checkGoalStaleness, postActivity, classifyBlockedText } from '../../../src/bus/system';
import type { BusPaths } from '../../../src/types';

function makePaths(testDir: string, agent: string = 'test-agent'): BusPaths {
  return {
    ctxRoot: testDir,
    inbox: join(testDir, 'inbox', agent),
    inflight: join(testDir, 'inflight', agent),
    processed: join(testDir, 'processed', agent),
    logDir: join(testDir, 'logs', agent),
    stateDir: join(testDir, 'state', agent),
    taskDir: join(testDir, 'tasks'),
    approvalDir: join(testDir, 'approvals'),
    analyticsDir: join(testDir, 'analytics'),
    heartbeatDir: join(testDir, 'heartbeats'),
  };
}

describe('Bus System', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'cortextos-system-test-'));
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  describe('selfRestart', () => {
    it('creates marker file and appends to restarts.log', () => {
      const paths = makePaths(testDir);
      selfRestart(paths, 'test-agent', 'config reload needed');

      // Check marker file
      const markerPath = join(paths.stateDir, '.restart-planned');
      expect(existsSync(markerPath)).toBe(true);
      const markerContent = readFileSync(markerPath, 'utf-8').trim();
      expect(markerContent).toBe('config reload needed');

      // Check restarts.log
      const logPath = join(paths.logDir, 'restarts.log');
      expect(existsSync(logPath)).toBe(true);
      const logContent = readFileSync(logPath, 'utf-8');
      expect(logContent).toContain('SELF-RESTART: config reload needed');
      expect(logContent).toMatch(/\[\d{4}-\d{2}-\d{2}T/);
    });

    it('uses default reason when none provided', () => {
      const paths = makePaths(testDir);
      selfRestart(paths, 'test-agent');

      const logPath = join(paths.logDir, 'restarts.log');
      const logContent = readFileSync(logPath, 'utf-8');
      expect(logContent).toContain('SELF-RESTART: no reason specified');
    });
  });

  describe('hardRestart', () => {
    it('creates .force-fresh and .restart-planned markers', () => {
      const paths = makePaths(testDir);
      hardRestart(paths, 'test-agent', 'context handoff');

      expect(existsSync(join(paths.stateDir, '.force-fresh'))).toBe(true);
      expect(existsSync(join(paths.stateDir, '.restart-planned'))).toBe(true);
      const logContent = readFileSync(join(paths.logDir, 'restarts.log'), 'utf-8');
      expect(logContent).toContain('HARD-RESTART: context handoff');
    });

    it('uses default reason when none provided', () => {
      const paths = makePaths(testDir);
      hardRestart(paths, 'test-agent');
      const logContent = readFileSync(join(paths.logDir, 'restarts.log'), 'utf-8');
      expect(logContent).toContain('HARD-RESTART: no reason specified');
    });
  });

  describe('autoCommit', () => {
    let gitDir: string;

    beforeEach(() => {
      gitDir = mkdtempSync(join(tmpdir(), 'cortextos-autocommit-test-'));
      execSync('git init', { cwd: gitDir, stdio: 'pipe' });
      execSync('git config user.email "test@test.com"', { cwd: gitDir, stdio: 'pipe' });
      execSync('git config user.name "Test"', { cwd: gitDir, stdio: 'pipe' });
      // Create initial commit so git status works properly
      writeFileSync(join(gitDir, '.gitkeep'), '');
      execSync('git add .gitkeep && git commit -m "init"', { cwd: gitDir, stdio: 'pipe' });
    });

    afterEach(() => {
      rmSync(gitDir, { recursive: true, force: true });
    });

    it('filters out .env files', () => {
      writeFileSync(join(gitDir, 'app.env'), 'SECRET=abc');
      writeFileSync(join(gitDir, 'safe.txt'), 'hello');

      const report = autoCommit(gitDir, true);
      expect(report.status).toBe('dry_run');
      expect(report.staged).toContain('safe.txt');
      expect(report.blocked.some(b => b.includes('app.env'))).toBe(true);
    });

    it('filters out files with credential patterns', () => {
      writeFileSync(join(gitDir, 'config.json'), '{"token=abc123"}');
      writeFileSync(join(gitDir, 'readme.md'), 'just a readme');

      const report = autoCommit(gitDir, true);
      expect(report.blocked.some(b => b.includes('config.json') && b.includes('credential'))).toBe(true);
      expect(report.staged).toContain('readme.md');
    });

    it('allows script files even with credential-like patterns', () => {
      writeFileSync(join(gitDir, 'deploy.sh'), '#!/bin/bash\ntoken=get_from_env');
      writeFileSync(join(gitDir, 'app.py'), 'password=input("Enter:")');
      writeFileSync(join(gitDir, 'main.js'), 'const secret=process.env.SECRET');

      const report = autoCommit(gitDir, true);
      expect(report.staged).toContain('deploy.sh');
      expect(report.staged).toContain('app.py');
      expect(report.staged).toContain('main.js');
    });

    it('filters out binary/temp files', () => {
      writeFileSync(join(gitDir, 'output.log'), 'log data');
      writeFileSync(join(gitDir, 'cache.tmp'), 'temp');
      writeFileSync(join(gitDir, 'app.pid'), '12345');

      const report = autoCommit(gitDir, true);
      expect(report.blocked.some(b => b.includes('output.log'))).toBe(true);
      expect(report.blocked.some(b => b.includes('cache.tmp'))).toBe(true);
      expect(report.blocked.some(b => b.includes('app.pid'))).toBe(true);
    });

    it('dry-run does not stage files', () => {
      writeFileSync(join(gitDir, 'newfile.txt'), 'content');

      const report = autoCommit(gitDir, true);
      expect(report.status).toBe('dry_run');

      // Verify nothing is staged
      const staged = execSync('git diff --cached --name-only', { cwd: gitDir, encoding: 'utf-8' });
      expect(staged.trim()).toBe('');
    });

    it('returns clean when no changes', () => {
      const report = autoCommit(gitDir);
      expect(report.status).toBe('clean');
    });

    it('stages safe files when not dry-run', () => {
      writeFileSync(join(gitDir, 'newfile.txt'), 'content');

      const report = autoCommit(gitDir, false);
      expect(report.status).toBe('staged');
      expect(report.staged).toContain('newfile.txt');

      // Verify file is actually staged
      const staged = execSync('git diff --cached --name-only', { cwd: gitDir, encoding: 'utf-8' });
      expect(staged.trim()).toContain('newfile.txt');
    });

    it('returns nothing_to_stage when all files blocked', () => {
      writeFileSync(join(gitDir, 'secrets.env'), 'API_KEY=123');

      const report = autoCommit(gitDir);
      expect(report.status).toBe('nothing_to_stage');
      expect(report.blocked.length).toBeGreaterThan(0);
    });

    describe('agent path-filter', () => {
      it('blocks files outside the agent dir with outside_agent_dir reason', () => {
        // Mimic the silvermere-tech repo layout: agent dir + framework file outside
        mkdirSync(join(gitDir, 'orgs', 'silvermere-tech', 'agents', 'engineer'), { recursive: true });
        mkdirSync(join(gitDir, 'orgs', 'silvermere-tech', 'agents', 'analyst'), { recursive: true });
        mkdirSync(join(gitDir, 'scripts'), { recursive: true });
        // Seed tracked .gitkeep so untracked siblings list individually.
        writeFileSync(join(gitDir, 'orgs', 'silvermere-tech', 'agents', 'engineer', '.gitkeep'), '');
        writeFileSync(join(gitDir, 'orgs', 'silvermere-tech', 'agents', 'analyst', '.gitkeep'), '');
        writeFileSync(join(gitDir, 'scripts', '.gitkeep'), '');
        execSync('git add -A && git commit -m "seed"', { cwd: gitDir, stdio: 'pipe' });
        writeFileSync(join(gitDir, 'orgs', 'silvermere-tech', 'agents', 'engineer', 'notes.md'), 'engineer note');
        writeFileSync(join(gitDir, 'orgs', 'silvermere-tech', 'agents', 'analyst', 'notes.md'), 'analyst note');
        writeFileSync(join(gitDir, 'scripts', 'framework-helper.js'), '// framework code');

        const report = autoCommit(gitDir, true, 'orgs/silvermere-tech/agents/engineer/');

        expect(report.staged).toContain('orgs/silvermere-tech/agents/engineer/notes.md');
        expect(report.blocked.some(b => b.includes('orgs/silvermere-tech/agents/analyst/notes.md') && b.includes('outside_agent_dir'))).toBe(true);
        expect(report.blocked.some(b => b.includes('scripts/framework-helper.js') && b.includes('outside_agent_dir'))).toBe(true);
      });

      it('prefix-match is strict (analyst does not match analyst-foo)', () => {
        // Seed tracked .gitkeep in each subdir so subsequent untracked files
        // within are listed individually by git status (otherwise git collapses
        // untracked-only dirs to a single "?? dir/" entry).
        mkdirSync(join(gitDir, 'orgs', 'o', 'agents', 'analyst'), { recursive: true });
        mkdirSync(join(gitDir, 'orgs', 'o', 'agents', 'analyst-foo'), { recursive: true });
        writeFileSync(join(gitDir, 'orgs', 'o', 'agents', 'analyst', '.gitkeep'), '');
        writeFileSync(join(gitDir, 'orgs', 'o', 'agents', 'analyst-foo', '.gitkeep'), '');
        execSync('git add -A && git commit -m "seed"', { cwd: gitDir, stdio: 'pipe' });
        writeFileSync(join(gitDir, 'orgs', 'o', 'agents', 'analyst', 'a.md'), 'a');
        writeFileSync(join(gitDir, 'orgs', 'o', 'agents', 'analyst-foo', 'b.md'), 'b');

        const report = autoCommit(gitDir, true, 'orgs/o/agents/analyst/');

        expect(report.staged).toContain('orgs/o/agents/analyst/a.md');
        expect(report.blocked.some(b => b.includes('analyst-foo/b.md') && b.includes('outside_agent_dir'))).toBe(true);
      });

      it('no prefix = unfiltered (backward-compat for callers without agent context)', () => {
        writeFileSync(join(gitDir, 'a.md'), 'a');
        writeFileSync(join(gitDir, 'b.md'), 'b');

        const report = autoCommit(gitDir, true);

        expect(report.staged).toContain('a.md');
        expect(report.staged).toContain('b.md');
        expect(report.blocked.some(b => b.includes('outside_agent_dir'))).toBe(false);
      });

      it('normalises prefix without trailing slash', () => {
        mkdirSync(join(gitDir, 'agents', 'foo'), { recursive: true });
        writeFileSync(join(gitDir, 'agents', 'foo', '.gitkeep'), '');
        execSync('git add -A && git commit -m "seed"', { cwd: gitDir, stdio: 'pipe' });
        writeFileSync(join(gitDir, 'agents', 'foo', 'x.md'), 'x');
        writeFileSync(join(gitDir, 'other.md'), 'other');

        // Pass prefix WITHOUT trailing slash — function should normalise.
        const report = autoCommit(gitDir, true, 'agents/foo');

        expect(report.staged).toContain('agents/foo/x.md');
        expect(report.blocked.some(b => b.includes('other.md') && b.includes('outside_agent_dir'))).toBe(true);
      });

      it('blocks-then-other-checks: a file outside the dir is blocked even if it would also fail other rules', () => {
        // outside-dir block fires first; we should see outside_agent_dir reason,
        // not credential_pattern_detected or .env, because the path-filter is
        // the cheapest first-pass gate.
        writeFileSync(join(gitDir, 'config.json'), '{"token=abc"}');

        const report = autoCommit(gitDir, true, 'agents/foo/');

        expect(report.blocked.some(b => b.includes('config.json') && b.includes('outside_agent_dir'))).toBe(true);
        expect(report.blocked.some(b => b.includes('config.json') && b.includes('credential_pattern_detected'))).toBe(false);
      });
    });
  });

  describe('checkGoalStaleness', () => {
    it('identifies stale goals', () => {
      // Create org/agent structure with old timestamp
      const agentDir = join(testDir, 'orgs', 'myorg', 'agents', 'worker');
      mkdirSync(agentDir, { recursive: true });

      const oldDate = new Date(Date.now() - 10 * 86400 * 1000).toISOString();
      writeFileSync(join(agentDir, 'GOALS.md'), `# Goals\n\n## Updated\n${oldDate}\n\nSome goal`);

      const report = checkGoalStaleness(testDir, 7);
      expect(report.summary.total).toBe(1);
      expect(report.summary.stale).toBe(1);
      expect(report.agents[0].status).toBe('stale');
      expect(report.agents[0].agent).toBe('worker');
      expect(report.agents[0].org).toBe('myorg');
      expect(report.agents[0].stale).toBe(true);
    });

    it('identifies fresh goals', () => {
      const agentDir = join(testDir, 'orgs', 'myorg', 'agents', 'worker');
      mkdirSync(agentDir, { recursive: true });

      const recentDate = new Date().toISOString();
      writeFileSync(join(agentDir, 'GOALS.md'), `# Goals\n\n## Updated\n${recentDate}\n\nSome goal`);

      const report = checkGoalStaleness(testDir, 7);
      expect(report.summary.fresh).toBe(1);
      expect(report.agents[0].status).toBe('fresh');
      expect(report.agents[0].stale).toBe(false);
    });

    it('handles missing GOALS.md', () => {
      const agentDir = join(testDir, 'orgs', 'myorg', 'agents', 'worker');
      mkdirSync(agentDir, { recursive: true });
      // No GOALS.md created

      const report = checkGoalStaleness(testDir);
      expect(report.agents[0].status).toBe('missing');
      expect(report.agents[0].stale).toBe(true);
      expect(report.agents[0].reason).toContain('no GOALS.md');
    });

    it('handles missing timestamp in GOALS.md', () => {
      const agentDir = join(testDir, 'orgs', 'myorg', 'agents', 'worker');
      mkdirSync(agentDir, { recursive: true });
      writeFileSync(join(agentDir, 'GOALS.md'), '# Goals\n\nJust some text without updated section');

      const report = checkGoalStaleness(testDir);
      expect(report.agents[0].status).toBe('no_timestamp');
      expect(report.agents[0].stale).toBe(true);
    });

    it('handles unparseable timestamp', () => {
      const agentDir = join(testDir, 'orgs', 'myorg', 'agents', 'worker');
      mkdirSync(agentDir, { recursive: true });
      writeFileSync(join(agentDir, 'GOALS.md'), '# Goals\n\n## Updated\nnot-a-date\n');

      const report = checkGoalStaleness(testDir);
      expect(report.agents[0].status).toBe('parse_error');
      expect(report.agents[0].stale).toBe(true);
    });

    it('returns empty report when no orgs directory', () => {
      const report = checkGoalStaleness(testDir);
      expect(report.summary.total).toBe(0);
      expect(report.agents).toEqual([]);
    });

    it('scans multiple orgs and agents', () => {
      // Create two orgs with agents
      for (const org of ['org1', 'org2']) {
        const agentDir = join(testDir, 'orgs', org, 'agents', 'bot');
        mkdirSync(agentDir, { recursive: true });
        const date = new Date().toISOString();
        writeFileSync(join(agentDir, 'GOALS.md'), `# Goals\n\n## Updated\n${date}\n`);
      }

      const report = checkGoalStaleness(testDir);
      expect(report.summary.total).toBe(2);
    });
  });

  describe('postActivity', () => {
    it('returns false when not configured', async () => {
      const result = await postActivity(
        join(testDir, 'nonexistent'),
        testDir,
        'myorg',
        'hello',
      );
      expect(result).toBe(false);
    });

    it('returns false when env file has no token', async () => {
      const orgDir = join(testDir, 'orgdir');
      mkdirSync(orgDir, { recursive: true });
      writeFileSync(join(orgDir, 'activity-channel.env'), 'ACTIVITY_CHAT_ID=123\n');

      const result = await postActivity(orgDir, testDir, 'myorg', 'hello');
      expect(result).toBe(false);
    });

    it('returns false when env file has no chat ID', async () => {
      const orgDir = join(testDir, 'orgdir');
      mkdirSync(orgDir, { recursive: true });
      writeFileSync(join(orgDir, 'activity-channel.env'), 'ACTIVITY_BOT_TOKEN=abc123\n');

      const result = await postActivity(orgDir, testDir, 'myorg', 'hello');
      expect(result).toBe(false);
    });
  });

  describe('autoCommitAgentRepo', () => {
    let agentDir: string;

    beforeEach(() => {
      agentDir = mkdtempSync(join(tmpdir(), 'cortextos-agentrepo-test-'));
      // Reproduce the real agent dir: its own .gitignore hides memory/.
      writeFileSync(join(agentDir, '.gitignore'), 'local/\n.env\nmemory/\n*.log\n.cache/\n');
      mkdirSync(join(agentDir, 'memory'), { recursive: true });
      mkdirSync(join(agentDir, 'workspace'), { recursive: true });
    });

    afterEach(() => {
      rmSync(agentDir, { recursive: true, force: true });
    });

    it('stages memory/ and MEMORY.md despite the agent .gitignore hiding memory/', () => {
      writeFileSync(join(agentDir, 'memory', '2026-07-09.md'), 'daily log');
      writeFileSync(join(agentDir, 'MEMORY.md'), 'long-term memory');

      const report = autoCommitAgentRepo(agentDir, true);
      expect(report.status).toBe('dry_run');
      expect(report.staged).toContain('memory/2026-07-09.md');
      expect(report.staged).toContain('MEMORY.md');
    });

    it('never stages .env even though it sits in the agent dir', () => {
      writeFileSync(join(agentDir, '.env'), 'BOT_TOKEN=supersecretvalue');
      writeFileSync(join(agentDir, 'workspace', 'note.md'), 'safe');

      const report = autoCommitAgentRepo(agentDir, true);
      expect(report.staged).toContain('workspace/note.md');
      expect(report.staged.some(f => f.endsWith('.env'))).toBe(false);
    });

    it('does not block prose containing "task-list" or "disk-beats-memory"', () => {
      // The old unanchored /sk-/ blocked 22 of 54 real memory files on these words.
      writeFileSync(
        join(agentDir, 'memory', 'prose.md'),
        'the task-list truncates ids; see disk-beats-memory. risk-free.',
      );

      const report = autoCommitAgentRepo(agentDir, true);
      expect(report.staged).toContain('memory/prose.md');
      expect(report.blocked.some(b => b.includes('credential'))).toBe(false);
    });

    it('STILL blocks a real sk- key and a real token= assignment', () => {
      writeFileSync(join(agentDir, 'memory', 'leak.md'), 'sk-abcdefghij0123456789ABCDEFGH');
      writeFileSync(join(agentDir, 'memory', 'leak2.md'), 'token=abc123');
      writeFileSync(join(agentDir, 'memory', 'clean.md'), 'nothing sensitive');

      const report = autoCommitAgentRepo(agentDir, true);
      expect(report.blocked.some(b => b.includes('leak.md') && b.includes('credential'))).toBe(true);
      expect(report.blocked.some(b => b.includes('leak2.md') && b.includes('credential'))).toBe(true);
      expect(report.staged).toContain('memory/clean.md');
    });

    it('returns failed (not clean) when changes exist but everything is screened out', () => {
      writeFileSync(join(agentDir, 'memory', 'only.md'), 'sk-abcdefghij0123456789ABCDEFGH');

      const report = autoCommitAgentRepo(agentDir, true);
      expect(report.status).toBe('failed');
      expect(report.staged).toHaveLength(0);
      expect(report.reason).toMatch(/0 stageable/);
    });

    it('blocks database dumps — they carry production data and must never be versioned', () => {
      mkdirSync(join(agentDir, 'workspace', 'snapshots'), { recursive: true });
      writeFileSync(join(agentDir, 'workspace', 'snapshots', 'tenant.dump'), 'PGDMP fake');
      writeFileSync(join(agentDir, 'workspace', 'snapshots', 'old.sql'), 'DROP TABLE x;');
      writeFileSync(join(agentDir, 'workspace', 'notes.md'), 'safe');

      const report = autoCommitAgentRepo(agentDir, true);
      expect(report.blocked.some(b => b.includes('tenant.dump') && b.includes('data_dump'))).toBe(true);
      expect(report.blocked.some(b => b.includes('old.sql') && b.includes('data_dump'))).toBe(true);
      expect(report.staged).toContain('workspace/notes.md');
    });

    it('blocks apr1/bcrypt htpasswd hashes — the shape the value-bearing scan misses', () => {
      writeFileSync(join(agentDir, 'memory', 'leak.md'), 'users: liwa:$apr1$SYNTH000$0000000000000000000000');
      writeFileSync(join(agentDir, 'memory', 'leak2.md'), 'hash: $2y$10$abcdefghijklmnopqrstuv');

      const report = autoCommitAgentRepo(agentDir, true);
      expect(report.blocked.some(b => b.includes('leak.md') && b.includes('credential'))).toBe(true);
      expect(report.blocked.some(b => b.includes('leak2.md') && b.includes('credential'))).toBe(true);
    });

    it('still stages MEMORY.md once its hashes are redacted', () => {
      // Redaction keeps the $apr1$ marker so the lesson reads, but drops the body.
      writeFileSync(join(agentDir, 'MEMORY.md'), 'we used $apr1$<REDACTED> for basic auth');

      const report = autoCommitAgentRepo(agentDir, true);
      expect(report.staged).toContain('MEMORY.md');
      expect(report.blocked.some(b => b.includes('MEMORY.md'))).toBe(false);
    });

    it('commits for real and reports a hash, with no remote configured', () => {
      writeFileSync(join(agentDir, 'MEMORY.md'), 'long-term memory');

      const report = autoCommitAgentRepo(agentDir, false);
      expect(report.status).toBe('committed');
      expect(report.commit).toMatch(/^[0-9a-f]{7,}$/);

      const logged = execSync('git log --name-only --format= -1', { cwd: agentDir, encoding: 'utf-8' });
      expect(logged).toContain('MEMORY.md');
      // Structurally incapable of pushing.
      expect(execSync('git remote', { cwd: agentDir, encoding: 'utf-8' }).trim()).toBe('');
    });

    // ── Three-zone allowlist (2026-07-14, task_1783990536465) ────────────────
    // Before this, only memory/ + workspace/ + MEMORY.md were versioned and the
    // operating definition had no history — and, because screening happens at
    // staging, no credential screen either (the two exemptions hid each other).

    it('stages the operating definition: root *.md, config.json, goals.json', () => {
      writeFileSync(join(agentDir, 'GUARDRAILS.md'), 'red flag table');
      writeFileSync(join(agentDir, 'config.json'), '{"timezone":"Asia/Dubai"}');
      writeFileSync(join(agentDir, 'goals.json'), '{"goals":[]}');

      const report = autoCommitAgentRepo(agentDir, true);
      expect(report.staged).toContain('GUARDRAILS.md');
      expect(report.staged).toContain('config.json');
      expect(report.staged).toContain('goals.json');
    });

    it('stages .claude skills and experiments (zone 3 — where the dead-token payload lived)', () => {
      mkdirSync(join(agentDir, '.claude', 'skills', 'comms'), { recursive: true });
      writeFileSync(join(agentDir, '.claude', 'skills', 'comms', 'SKILL.md'), 'message handling');
      mkdirSync(join(agentDir, 'experiments'), { recursive: true });
      writeFileSync(join(agentDir, 'experiments', 'learnings.md'), 'notes');

      const report = autoCommitAgentRepo(agentDir, true);
      expect(report.staged).toContain('.claude/skills/comms/SKILL.md');
      expect(report.staged).toContain('experiments/learnings.md');
    });

    it('an operating file with a credential-shaped value is BLOCKED and lands in blocked_text', () => {
      writeFileSync(join(agentDir, 'GUARDRAILS.md'), 'never do token=abc123def456 again');
      writeFileSync(join(agentDir, 'MEMORY.md'), 'clean');

      const report = autoCommitAgentRepo(agentDir, true);
      expect(report.blocked.some(b => b.includes('GUARDRAILS.md'))).toBe(true);
      expect(report.blocked_text.some(b => b.includes('GUARDRAILS.md'))).toBe(true);
      expect(report.staged).toContain('MEMORY.md');
    });

    it('policy blocks (dumps/binaries) do NOT land in blocked_text — a blocked .png is policy, a blocked .md is an incident', () => {
      mkdirSync(join(agentDir, 'workspace', 'snaps'), { recursive: true });
      writeFileSync(join(agentDir, 'workspace', 'snaps', 'db.dump'), 'PGDMP fake');
      writeFileSync(join(agentDir, 'workspace', 'note.md'), 'safe');

      const report = autoCommitAgentRepo(agentDir, true);
      expect(report.blocked.some(b => b.includes('db.dump'))).toBe(true);
      expect(report.blocked_text).toHaveLength(0); // healthy steady state is VISIBLE as empty, not inferred from status
    });

    it('reports its denominator: covered_paths present, absent_paths named (never silently skipped)', () => {
      writeFileSync(join(agentDir, 'MEMORY.md'), 'x');
      const report = autoCommitAgentRepo(agentDir, false);
      expect(report.covered_paths).toContain('MEMORY.md');
      expect(report.covered_paths).toContain('memory');
      expect(report.absent_paths).toContain('GUARDRAILS.md'); // this fixture agent has none — named, not omitted
    });
  });

  describe('classifyBlockedText', () => {
    it('keeps credential-class entries, drops policy-class, tolerates odd shapes', () => {
      expect(classifyBlockedText([
        'a.md:credential_pattern_detected',
        'b.pyc:binary_or_temp',
        'c.dump:data_dump',
        'd.md:some_future_reason',
      ])).toEqual(['a.md:credential_pattern_detected', 'd.md:some_future_reason']);
      expect(classifyBlockedText([])).toEqual([]);
    });
  });
});
