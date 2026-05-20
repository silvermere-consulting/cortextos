import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

// We test the parseFrontMatter + getActiveProjects logic by constructing a
// temporary framework root with project-state.md files, then patching
// getFrameworkRoot and getOrgs to point at it.

const testRoot = join(tmpdir(), `active-projects-test-${Date.now()}`);

// Patch config module before importing the module under test
vi.mock('@/lib/config', () => ({
  getFrameworkRoot: () => testRoot,
  getOrgs: () => ['test-org'],
}));

// Import after mocking
const { getActiveProjects } = await import('@/lib/data/projects');

function writeProjectState(orgName: string, projectName: string, fm: Record<string, string>) {
  const dir = join(testRoot, 'orgs', orgName, 'projects', projectName, 'docs');
  mkdirSync(dir, { recursive: true });
  const lines = Object.entries(fm).map(([k, v]) => `${k}: ${v}`).join('\n');
  writeFileSync(join(dir, 'project-state.md'), `---\n${lines}\n---\n\n# Content\n`);
}

describe('getActiveProjects', () => {
  beforeEach(() => {
    mkdirSync(testRoot, { recursive: true });
  });

  afterEach(() => {
    try { rmSync(testRoot, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('returns only ACTIVE projects', () => {
    writeProjectState('test-org', 'alpha', {
      project: 'alpha',
      status: 'ACTIVE',
      current_phase: 'Brief',
      current_stage: 'Stage 1',
    });
    writeProjectState('test-org', 'beta', {
      project: 'beta',
      status: 'CLOSED',
      current_phase: 'Done',
      current_stage: 'N/A',
    });

    const result = getActiveProjects();
    expect(result).toHaveLength(1);
    expect(result[0].project).toBe('alpha');
    expect(result[0].currentPhase).toBe('Brief');
    expect(result[0].currentStage).toBe('Stage 1');
  });

  it('returns empty array when no projects exist', () => {
    mkdirSync(join(testRoot, 'orgs', 'test-org', 'projects'), { recursive: true });
    expect(getActiveProjects()).toEqual([]);
  });

  it('silently excludes projects with no project-state.md', () => {
    mkdirSync(join(testRoot, 'orgs', 'test-org', 'projects', 'ghost'), { recursive: true });
    writeProjectState('test-org', 'real', { project: 'real', status: 'ACTIVE', current_phase: 'Spec', current_stage: 'Stage 2' });

    const result = getActiveProjects();
    expect(result).toHaveLength(1);
    expect(result[0].project).toBe('real');
  });

  it('silently excludes projects with malformed front matter', () => {
    const dir = join(testRoot, 'orgs', 'test-org', 'projects', 'broken', 'docs');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'project-state.md'), 'no front matter here\n');

    expect(getActiveProjects()).toEqual([]);
  });

  it('filters to specified org only', () => {
    writeProjectState('test-org', 'proj', { project: 'proj', status: 'ACTIVE', current_phase: 'Build', current_stage: 'Stage 1' });

    const withOrg = getActiveProjects('test-org');
    expect(withOrg).toHaveLength(1);

    const withWrongOrg = getActiveProjects('other-org');
    expect(withWrongOrg).toEqual([]);
  });

  it('absolutePath is the path to the project-state.md file', () => {
    writeProjectState('test-org', 'check-path', { project: 'check-path', status: 'ACTIVE', current_phase: 'Brief', current_stage: 'Stage 1' });
    const result = getActiveProjects();
    expect(result[0].absolutePath).toContain('project-state.md');
    expect(result[0].absolutePath).toContain('check-path');
  });
});
