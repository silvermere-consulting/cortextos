/**
 * check-deps — codified "verify-before-claim" for dependency questions.
 *
 * Given one or more dep names (e.g. `torch`, `kreuzberg`, `react`), reports
 * whether each is present in this repo's stack by checking three signals:
 *
 *   1. Python imports — `grep -ril "(from|import) <dep>" --include="*.py"`
 *      across the repo, skipping node_modules/.git/.next/dist/venv.
 *   2. Requirements files — any `requirements*.txt` or `pyproject.toml`
 *      naming the dep (regex on the line, not just substring).
 *   3. Installed in framework venv — `<venv>/bin/pip show <dep>` on the
 *      knowledge-base/venv (the only persistent Python env in the repo).
 *
 * A dep is "present" if ANY signal hits. Evidence is the first concrete
 * hit (file path or `pip-show: <version>`). Useful to settle "do we
 * already use X?" questions in seconds — no manual grep-and-eyeball cycle.
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'fs';
import { join, relative } from 'path';
import { spawnSync } from 'child_process';

export interface CheckDepsOptions {
  frameworkRoot: string;
  /** Also search node ecosystem (package.json + import in .ts/.js/.tsx). Default false. */
  includeNode?: boolean;
}

export interface DepResult {
  dep: string;
  present: boolean;
  /** Concrete evidence — file path of first hit, or `pip-show: <version>`. */
  evidence: string;
  /** Which signal fired first (python-import | requirements | pip-show | node-package | node-import). */
  signal: string | null;
}

const SKIP_DIRS = new Set([
  'node_modules', '.git', '.next', 'dist', 'build', '.cache',
  'venv', '.venv', '__pycache__', 'chromadb',
  '.claude', '.cortextos',
]);

function walk(dir: string, includeExt: Set<string>, hits: string[]): void {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of entries) {
    if (SKIP_DIRS.has(name)) continue;
    if (name.startsWith('.') && name !== '.env.example') {
      // skip dotfiles except specifically-allowed
      continue;
    }
    const full = join(dir, name);
    let s;
    try { s = statSync(full); } catch { continue; }
    if (s.isDirectory()) {
      walk(full, includeExt, hits);
    } else if (s.isFile()) {
      const idx = name.lastIndexOf('.');
      if (idx < 0) continue;
      const ext = name.slice(idx);
      if (includeExt.has(ext)) hits.push(full);
    }
  }
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function checkPythonImports(root: string, dep: string): string | null {
  const py: string[] = [];
  walk(root, new Set(['.py']), py);
  // Match `import dep`, `import dep.sub`, `from dep`, `from dep.sub`
  // Anchor: word boundary either side of dep, on a line that starts (after whitespace) with import/from.
  const safeDep = escapeRegex(dep);
  const re = new RegExp(`^\\s*(from|import)\\s+${safeDep}(\\.|\\s|$)`, 'm');
  for (const file of py) {
    let content;
    try { content = readFileSync(file, 'utf-8'); } catch { continue; }
    if (re.test(content)) return file;
  }
  return null;
}

function checkRequirements(root: string, dep: string): string | null {
  const reqFiles: string[] = [];
  walk(root, new Set(['.txt', '.toml']), reqFiles);
  const safeDep = escapeRegex(dep);
  // requirements*.txt: dep, dep==1.0, dep>=1.0, dep[extras] etc — match at start-of-line (ignoring leading whitespace)
  const reqRe = new RegExp(`^\\s*${safeDep}(\\[|==|>=|<=|~=|>|<|;|\\s*$)`, 'im');
  // pyproject.toml: "dep = ..." or in [tool.poetry.dependencies] or [project.dependencies]
  const tomlRe = new RegExp(`["'\`]?${safeDep}["'\`]?\\s*[=:]`, 'm');
  for (const file of reqFiles) {
    const base = file.split('/').pop() ?? '';
    const isReq = base.startsWith('requirements') && base.endsWith('.txt');
    const isToml = base === 'pyproject.toml';
    if (!isReq && !isToml) continue;
    let content;
    try { content = readFileSync(file, 'utf-8'); } catch { continue; }
    const re = isReq ? reqRe : tomlRe;
    if (re.test(content)) return file;
  }
  return null;
}

function checkPipShow(frameworkRoot: string, dep: string): { found: boolean; version?: string } {
  const isWin = process.platform === 'win32';
  const venvBin = isWin ? 'Scripts' : 'bin';
  const pip = join(frameworkRoot, 'knowledge-base', 'venv', venvBin, 'pip');
  if (!existsSync(pip)) return { found: false };
  const result = spawnSync(pip, ['show', dep], { encoding: 'utf-8', timeout: 10_000 });
  if (result.status !== 0) return { found: false };
  const ver = (result.stdout ?? '').match(/^Version:\s*(.+)$/m);
  return { found: true, version: ver?.[1].trim() };
}

function checkNodePackageJson(root: string, dep: string): string | null {
  // Top-level package.json + any nested package.json (e.g. dashboard/)
  const pjs: string[] = [];
  walk(root, new Set(['.json']), pjs);
  for (const file of pjs.filter(p => p.endsWith('/package.json'))) {
    let content;
    try { content = JSON.parse(readFileSync(file, 'utf-8')); } catch { continue; }
    for (const k of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
      if (content?.[k] && Object.prototype.hasOwnProperty.call(content[k], dep)) return file;
    }
  }
  return null;
}

function checkNodeImports(root: string, dep: string): string | null {
  const files: string[] = [];
  walk(root, new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs']), files);
  const safeDep = escapeRegex(dep);
  // import ... from 'dep' | import 'dep' | require('dep') | from 'dep/sub'
  const re = new RegExp(
    `(?:from\\s+['"\`]${safeDep}(?:/[^'"\`]*)?['"\`])|(?:import\\s+['"\`]${safeDep}(?:/[^'"\`]*)?['"\`])|(?:require\\(\\s*['"\`]${safeDep}(?:/[^'"\`]*)?['"\`]\\s*\\))`,
    'm',
  );
  for (const file of files) {
    let content;
    try { content = readFileSync(file, 'utf-8'); } catch { continue; }
    if (re.test(content)) return file;
  }
  return null;
}

export function checkDeps(deps: string[], options: CheckDepsOptions): DepResult[] {
  const { frameworkRoot, includeNode = false } = options;
  const results: DepResult[] = [];

  for (const dep of deps) {
    // Try cheapest signals first: pip show (1 process, fast)
    const pip = checkPipShow(frameworkRoot, dep);
    if (pip.found) {
      results.push({
        dep,
        present: true,
        evidence: `pip-show: ${pip.version ?? 'installed'}`,
        signal: 'pip-show',
      });
      continue;
    }

    // Then requirements files (single pass through small set of files)
    const req = checkRequirements(frameworkRoot, dep);
    if (req) {
      results.push({
        dep,
        present: true,
        evidence: relative(frameworkRoot, req) || req,
        signal: 'requirements',
      });
      continue;
    }

    // Python imports (broader scan)
    const pyImp = checkPythonImports(frameworkRoot, dep);
    if (pyImp) {
      results.push({
        dep,
        present: true,
        evidence: relative(frameworkRoot, pyImp) || pyImp,
        signal: 'python-import',
      });
      continue;
    }

    // Node ecosystem (opt-in — many bus calls are Python-shaped)
    if (includeNode) {
      const nodePkg = checkNodePackageJson(frameworkRoot, dep);
      if (nodePkg) {
        results.push({
          dep,
          present: true,
          evidence: relative(frameworkRoot, nodePkg) || nodePkg,
          signal: 'node-package',
        });
        continue;
      }
      const nodeImp = checkNodeImports(frameworkRoot, dep);
      if (nodeImp) {
        results.push({
          dep,
          present: true,
          evidence: relative(frameworkRoot, nodeImp) || nodeImp,
          signal: 'node-import',
        });
        continue;
      }
    }

    results.push({ dep, present: false, evidence: 'not found', signal: null });
  }

  return results;
}

export function formatDepsTable(results: DepResult[]): string {
  // Compact table: dep | present | evidence
  const header = ['dep', 'present', 'evidence'];
  const rows = results.map(r => [r.dep, r.present ? 'yes' : 'no', r.evidence]);
  const allRows = [header, ...rows];
  const widths = header.map((_, i) =>
    Math.max(...allRows.map(r => (r[i] ?? '').length)),
  );
  const fmt = (r: string[]) =>
    r.map((c, i) => (c ?? '').padEnd(widths[i])).join('  ');
  const sep = widths.map(w => '-'.repeat(w)).join('  ');
  return [fmt(header), sep, ...rows.map(fmt)].join('\n');
}
