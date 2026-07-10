import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execSync } from 'child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { autoCommit, screenFile } from '../../../src/bus/system.js';

/**
 * PARITY GATE between the two screening paths.
 *
 * screenFile() states it holds "the same rules the shared-tree autoCommit applies,
 * in one place so the two paths cannot drift apart." That comment was the drift
 * detector, and it was wrong the day it was written: autoCommit() never consulted
 * DATA_DUMP_EXTENSIONS, and called extname() without .toLowerCase().
 *
 * The agent-repo path routes through screenFile(), which is why the 2026-07-09
 * pg_dump fix appeared to hold. The shared-tree path never had it. A comment
 * cannot enforce parity; this file does.
 */
describe('autoCommit / screenFile parity: data dumps and case-folding', () => {
  let gitDir: string;

  beforeEach(() => {
    gitDir = mkdtempSync(join(tmpdir(), 'cortextos-parity-test-'));
    execSync('git init', { cwd: gitDir, stdio: 'pipe' });
    execSync('git config user.email t@t.t', { cwd: gitDir, stdio: 'pipe' });
    execSync('git config user.name t', { cwd: gitDir, stdio: 'pipe' });
  });
  afterEach(() => rmSync(gitDir, { recursive: true, force: true }));

  it('autoCommit blocks a database dump (it previously staged one)', () => {
    writeFileSync(join(gitDir, 'tenant.dump'), 'PGDMP fake dump body\n');
    writeFileSync(join(gitDir, 'readme.md'), 'ordinary notes');

    const report = autoCommit(gitDir, true);
    expect(report.blocked.some(b => b.includes('tenant.dump') && b.includes('data_dump'))).toBe(true);
    expect(report.staged).toContain('readme.md');
  });

  it.each(['tenant.DUMP', 'dead.PYC', 'build.LOG', 'db.SQL'])(
    'autoCommit case-folds the extension gate: %s must not walk past', (name) => {
      writeFileSync(join(gitDir, name), 'x');
      const report = autoCommit(gitDir, true);
      expect(report.staged).not.toContain(name);
      expect(report.blocked.some(b => b.startsWith(name))).toBe(true);
    },
  );

  it.each([
    ['tenant.dump', 'data_dump'],
    ['tenant.DUMP', 'data_dump'],
    ['x.sqlite3', 'data_dump'],
    ['dead.pyc', 'binary_or_temp'],
    ['dead.PYC', 'binary_or_temp'],
  ])('both paths agree on %s -> %s', (name, reason) => {
    writeFileSync(join(gitDir, name), 'x');

    // screenFile is the single-file oracle; autoCommit is the batch path.
    expect(screenFile(join(gitDir, name), name)).toBe(reason);

    const report = autoCommit(gitDir, true);
    expect(report.blocked.some(b => b === `${name}:${reason}`)).toBe(true);
  });
});
