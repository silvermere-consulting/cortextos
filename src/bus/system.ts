import { execSync, execFileSync } from 'child_process';
import { existsSync, readFileSync, statSync, appendFileSync, writeFileSync } from 'fs';
import { join, extname } from 'path';
import { readdirSync } from 'fs';
import { ensureDir } from '../utils/atomic.js';
import { TelegramAPI } from '../telegram/api.js';
import type { BusPaths } from '../types/index.js';

// --- Types ---

export interface AutoCommitReport {
  // 'failed' means: candidate changes existed but nothing could be staged.
  // Previously that case returned 'nothing_to_stage', which reads as success —
  // that conflation is what let the staging bug hide for months.
  status: 'staged' | 'committed' | 'clean' | 'nothing_to_stage' | 'dry_run' | 'failed';
  staged: string[];
  blocked: string[];
  diff_stat?: string;
  commit?: string;
  repo?: string;
  reason?: string;
}

export interface AgentGoalStatus {
  agent: string;
  org: string;
  status: 'fresh' | 'stale' | 'missing' | 'no_timestamp' | 'parse_error';
  updated?: string;
  age_days?: number;
  stale: boolean;
  reason?: string;
}

export interface GoalStalenessReport {
  summary: { total: number; stale: number; fresh: number; threshold_days: number };
  agents: AgentGoalStatus[];
}

// --- Blocked file patterns ---

const BINARY_TEMP_EXTENSIONS = new Set([
  '.log', '.tmp', '.pid', '.pyc', '.pyo', '.class', '.o', '.so', '.dylib',
]);

// Database dumps and snapshots. NEVER version these: they carry production data
// and they are large. Caught 2026-07-09 — a 5.5 MB pg_dump of the live silvermere
// Odoo tenant sat in an agent workspace/, passed the 10 MB gate, and was committed
// into that agent's snapshot repo. It was one `git bundle` away from riding the
// nightly off-site email backup.
const DATA_DUMP_EXTENSIONS = new Set([
  '.dump', '.sql', '.sqlite', '.sqlite3', '.db', '.bak', '.pgdump', '.mdb',
]);

const EXCLUDED_DIR_PREFIXES = [
  'telegram-images/',
  'node_modules/',
  '__pycache__/',
  '.venv/',
];

// Value-bearing credential shapes only. The previous pattern matched bare
// substrings (`sk-`, `key=`) and so blocked ordinary prose: "task-list",
// "disk-beats-memory" and "risk-free" all contain "sk-". Measured 2026-07-09:
// it blocked 22 of 54 agent memory files, MEMORY.md among them, while zero of
// those files held a real credential. A filter that silently drops 41% of the
// input and reports success is the failure mode auto-commit already had once.
// Each alternative below requires an actual secret-shaped VALUE, not a word.
// Literal key shapes are case-SENSITIVE by definition (AIza…, AKIA…, sk-…).
const CREDENTIAL_KEY_SHAPES = new RegExp(
  [
    'AIza[0-9A-Za-z_\\-]{35}',    // Google API key
    '\\bsk-[A-Za-z0-9]{20,}',     // OpenAI-style key
    '\\bghp_[A-Za-z0-9]{20,}',    // GitHub PAT
    '\\bxoxb-[0-9A-Za-z-]{10,}',  // Slack bot token
    '\\bAKIA[0-9A-Z]{16}\\b',     // AWS access key id
  ].join('|'),
);

// An assignment carrying an opaque value: token=…, api_key: "…", SECRET=…
// The {6,} floor is measured, not guessed: across all 54 agent memory files a
// floor of 4 false-positives on the prose "UPDATE password=NULL", while 6 gives
// zero false positives and still blocks a short real value like token=abc123.
const CREDENTIAL_ASSIGNMENT =
  /\b(?:token|api[_-]?key|password|secret)\s*[=:]\s*["']?[A-Za-z0-9_\-]{6,}/i;

// htpasswd / basicAuth hashes. A DIFFERENT shape entirely: no `key=` prefix and
// no vendor prefix, so neither of the patterns above can see it. Measured
// 2026-07-09: a value-bearing scan pronounced a Traefik routes.yml "clean" while
// it held six of these, and the same blind spot let apr1 hashes reach agent
// memory files — which ship off-box in the nightly backup email.
// Two distinct layouts, and a single character class cannot express both:
//   apr1:   $apr1$<salt>$<hash>
//   bcrypt: $2y$<cost>$<salt+hash>   <- the `10$` cost field breaks a naive class
// A redacted marker like `$apr1$<REDACTED>` matches neither, by design, so
// memory files stay committable once their hash bodies are stripped.
const CREDENTIAL_HTPASSWD =
  /\$apr1\$[A-Za-z0-9./]{6,}|\$2[aby]\$\d{2}\$[A-Za-z0-9./]{20,}/;

function hasCredential(content: string): boolean {
  return (
    CREDENTIAL_KEY_SHAPES.test(content) ||
    CREDENTIAL_ASSIGNMENT.test(content) ||
    CREDENTIAL_HTPASSWD.test(content)
  );
}

const SCRIPT_EXTENSIONS = new Set(['.sh', '.py', '.js']);

const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB

// --- Functions ---

/**
 * Plan a self-restart. Creates a marker file and logs the reason.
 * The daemon handles the actual restart via IPC.
 * Mirrors bash bus/self-restart.sh.
 */
export function selfRestart(paths: BusPaths, agentName: string, reason?: string): void {
  const resolvedReason = reason || 'no reason specified';

  // Create restart marker
  ensureDir(paths.stateDir);
  writeFileSync(join(paths.stateDir, '.restart-planned'), resolvedReason + '\n', 'utf-8');

  // Append to restarts.log
  ensureDir(paths.logDir);
  const timestamp = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
  const logLine = `[${timestamp}] SELF-RESTART: ${resolvedReason}\n`;
  appendFileSync(join(paths.logDir, 'restarts.log'), logLine, 'utf-8');
}

/**
 * Plan a hard restart (fresh session, no --continue).
 * Creates .force-fresh marker file; daemon checks this on next restart.
 * Mirrors bash bus/hard-restart.sh.
 */
export function hardRestart(paths: BusPaths, agentName: string, reason?: string): void {
  const resolvedReason = reason || 'no reason specified';

  // Create force-fresh marker (agent-process.ts checks this on restart)
  ensureDir(paths.stateDir);
  writeFileSync(join(paths.stateDir, '.force-fresh'), resolvedReason + '\n', 'utf-8');

  // Also create restart marker so crash-alert knows it was planned
  writeFileSync(join(paths.stateDir, '.restart-planned'), resolvedReason + '\n', 'utf-8');

  // Append to restarts.log
  ensureDir(paths.logDir);
  const timestamp = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
  const logLine = `[${timestamp}] HARD-RESTART: ${resolvedReason}\n`;
  appendFileSync(join(paths.logDir, 'restarts.log'), logLine, 'utf-8');
}

/**
 * Auto-commit safe files in a project directory.
 * Filters out dangerous files (credentials, env, large, binary).
 *
 * When `agentPathPrefix` is provided (e.g. `orgs/silvermere-tech/agents/engineer/`),
 * only files under that prefix are staged. Files outside the prefix go to
 * `blocked` with reason `outside_agent_dir` — they stay visible as orphans
 * for the responsible agent to commit consciously. This prevents one agent's
 * scheduled auto-commit from silently claiming authorship of another agent's
 * orphans or framework-level changes.
 *
 * Never pushes. Mirrors bash bus/auto-commit.sh.
 */
export function autoCommit(projectDir: string, dryRun: boolean = false, agentPathPrefix?: string): AutoCommitReport {
  // Check if git repo
  try {
    execSync('git rev-parse --is-inside-work-tree', { cwd: projectDir, stdio: 'pipe' });
  } catch {
    return { status: 'clean', staged: [], blocked: [] };
  }

  // Get changed files
  let porcelainOutput: string;
  try {
    porcelainOutput = execSync('git status --porcelain', { cwd: projectDir, encoding: 'utf-8' });
  } catch {
    return { status: 'clean', staged: [], blocked: [] };
  }

  if (!porcelainOutput.trim()) {
    return { status: 'clean', staged: [], blocked: [] };
  }

  const changedFiles = porcelainOutput
    .split('\n')
    .filter(line => line.trim())
    .map(line => line.slice(3)); // cut from column 4 (0-indexed col 3)

  const staged: string[] = [];
  const blocked: string[] = [];

  // Normalise the agent path prefix: strip leading "./", ensure trailing "/"
  // so prefix-matching is unambiguous (e.g. "orgs/foo/agents/bar/" matches
  // "orgs/foo/agents/bar/x" but not "orgs/foo/agents/bar-other/x").
  let normalisedPrefix: string | undefined;
  if (agentPathPrefix && agentPathPrefix.trim()) {
    normalisedPrefix = agentPathPrefix.replace(/^\.\//, '');
    if (!normalisedPrefix.endsWith('/')) normalisedPrefix += '/';
  }

  for (const file of changedFiles) {
    if (!file) continue;

    // Path-filter: when a prefix is set, files outside it stay orphan + visible.
    // Today's case (2026-06-01): analyst auto-commit nearly claimed authorship
    // of an engineer-territory framework patch left in the working tree.
    if (normalisedPrefix && !file.startsWith(normalisedPrefix)) {
      blocked.push(`${file}:outside_agent_dir`);
      continue;
    }

    // Block .env files
    if (file.endsWith('.env') || file.includes('/.env')) {
      blocked.push(`${file}:contains_credentials`);
      continue;
    }

    // Block .cortextos-env
    if (file === '.cortextos-env' || file.endsWith('/.cortextos-env')) {
      blocked.push(`${file}:runtime_env`);
      continue;
    }

    // Block binary/temp extensions
    const ext = extname(file);
    if (BINARY_TEMP_EXTENSIONS.has(ext)) {
      blocked.push(`${file}:binary_or_temp`);
      continue;
    }

    // Block excluded directories
    if (EXCLUDED_DIR_PREFIXES.some(prefix => file.startsWith(prefix))) {
      blocked.push(`${file}:excluded_directory`);
      continue;
    }

    const fullPath = join(projectDir, file);

    // Block files over 10MB
    if (existsSync(fullPath)) {
      try {
        const stat = statSync(fullPath);
        if (stat.isFile() && stat.size > MAX_FILE_SIZE) {
          blocked.push(`${file}:over_10MB`);
          continue;
        }
      } catch {
        // If can't stat, still try to stage
      }
    }

    // Check credential patterns in non-script file content
    if (existsSync(fullPath) && !SCRIPT_EXTENSIONS.has(ext)) {
      try {
        const stat = statSync(fullPath);
        if (stat.isFile() && stat.size < MAX_FILE_SIZE) {
          const content = readFileSync(fullPath, 'utf-8');
          if (hasCredential(content)) {
            blocked.push(`${file}:credential_pattern_detected`);
            continue;
          }
        }
      } catch {
        // Binary files may throw on utf-8 read - skip credential check
      }
    }

    staged.push(file);
  }

  if (staged.length === 0) {
    return { status: 'nothing_to_stage', staged: [], blocked };
  }

  if (dryRun) {
    return { status: 'dry_run', staged, blocked };
  }

  // Stage safe files
  for (const file of staged) {
    try {
      execFileSync('git', ['add', file], { cwd: projectDir, stdio: 'pipe' });
    } catch {
      // Ignore individual add failures
    }
  }

  // Get diff stat
  let diffStat: string | undefined;
  try {
    const stat = execSync('git diff --cached --stat', { cwd: projectDir, encoding: 'utf-8' });
    const lines = stat.trim().split('\n');
    diffStat = lines[lines.length - 1]?.trim() || undefined;
  } catch {
    // Ignore
  }

  return { status: 'staged', staged, blocked, diff_stat: diffStat };
}

/**
 * Screen one candidate file. Returns a block reason, or null if safe to stage.
 * Same rules the shared-tree autoCommit applies, in one place so the two paths
 * cannot drift apart.
 */
export function screenFile(fullPath: string, relPath: string): string | null {
  if (relPath.endsWith('.env') || relPath.includes('/.env')) return 'contains_credentials';
  if (relPath === '.cortextos-env' || relPath.endsWith('/.cortextos-env')) return 'runtime_env';

  const ext = extname(relPath).toLowerCase();
  if (BINARY_TEMP_EXTENSIONS.has(ext)) return 'binary_or_temp';
  if (DATA_DUMP_EXTENSIONS.has(ext)) return 'data_dump';
  if (EXCLUDED_DIR_PREFIXES.some(p => relPath.startsWith(p) || relPath.includes(`/${p}`))) {
    return 'excluded_directory';
  }

  if (!existsSync(fullPath)) return null;
  try {
    const stat = statSync(fullPath);
    if (!stat.isFile()) return null;
    if (stat.size > MAX_FILE_SIZE) return 'over_10MB';
    if (!SCRIPT_EXTENSIONS.has(ext) && stat.size < MAX_FILE_SIZE) {
      if (hasCredential(readFileSync(fullPath, 'utf-8'))) {
        return 'credential_pattern_detected';
      }
    }
  } catch {
    // unreadable/binary — fall through and allow; the ext + size gates already ran
  }
  return null;
}

/**
 * Paths inside an agent dir that the per-agent snapshot repo versions.
 * MEMORY.md is listed explicitly: long-term memory lives at the agent-dir root,
 * NOT under memory/ (which holds the daily files), so a memory/-only scope
 * silently omits the single most important file.
 */
const AGENT_REPO_PATHS = ['memory', 'workspace', 'MEMORY.md'];

/** Never let these into the snapshot repo, even via an explicit add. */
const AGENT_REPO_EXCLUDE = [
  '.env', '.cortextos-env', '*.log', 'local/', '.cache/',
  'telegram-images/', '__pycache__/', '.venv/', 'node_modules/',
];

/**
 * Ensure a per-agent snapshot repo exists at agentDir.
 *
 * Deliberately a SEPARATE repo from the shared framework tree:
 *  - the framework .gitignore excludes `orgs/` wholesale, so this nested .git
 *    is invisible to the shared tree — no fleet-wide status/diff pollution;
 *  - a separate repo has its own HEAD, so it cannot strand the shared working
 *    tree that every agent checks out of;
 *  - NO remote is ever configured, so it is structurally incapable of pushing
 *    rather than merely forbidden from it.
 */
export function ensureAgentRepo(agentDir: string): boolean {
  if (!existsSync(agentDir)) return false;
  const gitDir = join(agentDir, '.git');
  if (!existsSync(gitDir)) {
    execFileSync('git', ['init', '-q'], { cwd: agentDir, stdio: 'pipe' });
    execFileSync('git', ['config', 'user.name', 'cortextos-agent'], { cwd: agentDir, stdio: 'pipe' });
    execFileSync('git', ['config', 'user.email', 'agent@cortextos.local'], { cwd: agentDir, stdio: 'pipe' });
  }
  // Belt: strip any remote someone added by hand. This repo must never push.
  try {
    const remotes = execSync('git remote', { cwd: agentDir, encoding: 'utf-8' }).trim();
    for (const r of remotes.split('\n').filter(Boolean)) {
      execFileSync('git', ['remote', 'remove', r], { cwd: agentDir, stdio: 'pipe' });
    }
  } catch {
    // no remotes configured — the expected case
  }
  writeFileSync(join(gitDir, 'info', 'exclude'), AGENT_REPO_EXCLUDE.join('\n') + '\n');
  return true;
}

/**
 * Snapshot an agent's memory/ + workspace/ into its own local repo.
 *
 * Staging uses explicit paths with -f because the agent dir ships a .gitignore
 * listing `memory/` — a plain `git add -A` stages workspace/ and silently drops
 * memory/, reproducing the very no-op this function exists to fix.
 *
 * Returns 'failed' (not 'nothing_to_stage') when candidates existed but every
 * one was filtered out: a zero-staged result must never read as success.
 */
export function autoCommitAgentRepo(agentDir: string, dryRun: boolean = false): AutoCommitReport {
  if (!ensureAgentRepo(agentDir)) {
    return { status: 'failed', staged: [], blocked: [], reason: `agent dir not found: ${agentDir}` };
  }

  const present = AGENT_REPO_PATHS.filter(p => existsSync(join(agentDir, p)));
  if (present.length === 0) {
    return { status: 'clean', staged: [], blocked: [], repo: agentDir };
  }

  // Force past the agent-dir .gitignore, then inspect what actually landed.
  execFileSync('git', ['add', '-f', '--', ...present], { cwd: agentDir, stdio: 'pipe' });

  const candidates = execSync('git diff --cached --name-only', { cwd: agentDir, encoding: 'utf-8' })
    .split('\n').map(l => l.trim()).filter(Boolean);

  if (candidates.length === 0) {
    execFileSync('git', ['reset', '-q'], { cwd: agentDir, stdio: 'pipe' });
    return { status: 'clean', staged: [], blocked: [], repo: agentDir };
  }

  const staged: string[] = [];
  const blocked: string[] = [];

  for (const file of candidates) {
    const reason = screenFile(join(agentDir, file), file);
    if (reason) blocked.push(`${file}:${reason}`);
    else staged.push(file);
  }

  // Unstage anything screened out, so a blocked file can never ride the commit.
  for (const entry of blocked) {
    const file = entry.slice(0, entry.lastIndexOf(':'));
    try {
      execFileSync('git', ['restore', '--staged', '--', file], { cwd: agentDir, stdio: 'pipe' });
    } catch {
      execFileSync('git', ['reset', '-q', 'HEAD', '--', file], { cwd: agentDir, stdio: 'pipe' });
    }
  }

  if (staged.length === 0) {
    execFileSync('git', ['reset', '-q'], { cwd: agentDir, stdio: 'pipe' });
    return {
      status: 'failed',
      staged: [],
      blocked,
      repo: agentDir,
      reason: `${candidates.length} changed file(s) but 0 stageable — all screened out`,
    };
  }

  if (dryRun) {
    execFileSync('git', ['reset', '-q'], { cwd: agentDir, stdio: 'pipe' });
    return { status: 'dry_run', staged, blocked, repo: agentDir };
  }

  let diffStat: string | undefined;
  try {
    const stat = execSync('git diff --cached --stat', { cwd: agentDir, encoding: 'utf-8' });
    const lines = stat.trim().split('\n');
    diffStat = lines[lines.length - 1]?.trim() || undefined;
  } catch {
    // non-fatal
  }

  const stamp = new Date().toISOString().replace('T', ' ').slice(0, 16);
  const msg = `snapshot: ${staged.length} file(s) — ${stamp}Z`;
  execFileSync('git', ['commit', '-q', '-m', msg], { cwd: agentDir, stdio: 'pipe' });
  const commit = execSync('git rev-parse --short HEAD', { cwd: agentDir, encoding: 'utf-8' }).trim();

  return { status: 'committed', staged, blocked, diff_stat: diffStat, commit, repo: agentDir };
}

/**
 * Check goal staleness for all agents across all orgs.
 * Mirrors bash bus/check-goal-staleness.sh.
 */
export function checkGoalStaleness(
  projectRoot: string,
  thresholdDays: number = 7,
): GoalStalenessReport {
  const agents: AgentGoalStatus[] = [];
  const thresholdMs = thresholdDays * 86400 * 1000;
  const now = Date.now();

  const orgsDir = join(projectRoot, 'orgs');
  if (!existsSync(orgsDir)) {
    return {
      summary: { total: 0, stale: 0, fresh: 0, threshold_days: thresholdDays },
      agents: [],
    };
  }

  let orgNames: string[];
  try {
    orgNames = readdirSync(orgsDir).filter(name => {
      try {
        return statSync(join(orgsDir, name)).isDirectory();
      } catch {
        return false;
      }
    });
  } catch {
    orgNames = [];
  }

  for (const orgName of orgNames) {
    const agentsDir = join(orgsDir, orgName, 'agents');
    if (!existsSync(agentsDir)) continue;

    let agentNames: string[];
    try {
      agentNames = readdirSync(agentsDir).filter(name => {
        // Validate agent name (lowercase, numbers, hyphens, underscores)
        if (!/^[a-z0-9_-]+$/.test(name)) return false;
        try {
          return statSync(join(agentsDir, name)).isDirectory();
        } catch {
          return false;
        }
      });
    } catch {
      continue;
    }

    for (const agentName of agentNames) {
      const goalsFile = join(agentsDir, agentName, 'GOALS.md');

      if (!existsSync(goalsFile)) {
        agents.push({
          agent: agentName,
          org: orgName,
          status: 'missing',
          stale: true,
          reason: 'no GOALS.md file',
        });
        continue;
      }

      // Read and parse GOALS.md
      let content: string;
      try {
        content = readFileSync(goalsFile, 'utf-8');
      } catch {
        agents.push({
          agent: agentName,
          org: orgName,
          status: 'missing',
          stale: true,
          reason: 'could not read GOALS.md',
        });
        continue;
      }

      // Find "## Updated" section and get the next line
      const lines = content.split('\n');
      let updatedLine: string | null = null;
      for (let i = 0; i < lines.length; i++) {
        if (lines[i].trim().startsWith('## Updated')) {
          // Get next non-empty line
          for (let j = i + 1; j < lines.length; j++) {
            const trimmed = lines[j].trim();
            if (trimmed && !trimmed.startsWith('##')) {
              updatedLine = trimmed;
              break;
            }
          }
          break;
        }
      }

      if (!updatedLine) {
        agents.push({
          agent: agentName,
          org: orgName,
          status: 'no_timestamp',
          stale: true,
          reason: 'no Updated timestamp in GOALS.md',
        });
        continue;
      }

      // Parse ISO 8601 timestamp
      const parsedDate = new Date(updatedLine);
      if (isNaN(parsedDate.getTime())) {
        agents.push({
          agent: agentName,
          org: orgName,
          status: 'parse_error',
          updated: updatedLine,
          stale: true,
          reason: 'could not parse timestamp',
        });
        continue;
      }

      const ageMs = now - parsedDate.getTime();
      const ageDays = Math.floor(ageMs / 86400000);
      const isStale = ageMs > thresholdMs;

      agents.push({
        agent: agentName,
        org: orgName,
        status: isStale ? 'stale' : 'fresh',
        updated: updatedLine,
        age_days: ageDays,
        stale: isStale,
        reason: isStale
          ? `${ageDays} days since last update (threshold: ${thresholdDays})`
          : undefined,
      });
    }
  }

  const total = agents.length;
  const staleCount = agents.filter(a => a.stale).length;
  const freshCount = agents.filter(a => !a.stale).length;

  return {
    summary: {
      total,
      stale: staleCount,
      fresh: freshCount,
      threshold_days: thresholdDays,
    },
    agents,
  };
}

/**
 * Post a message to the org's Telegram activity channel.
 *
 * Returns false if not configured (silent fail — callers can ignore the
 * return value and treat activity-channel posting as best-effort).
 *
 * `replyMarkup` is an optional Telegram inline keyboard (or any reply
 * markup shape). When provided, the message ships with the keyboard
 * attached — used for interactive workflows like approval Approve/Deny
 * buttons posted alongside approval creation. Leaving it undefined
 * preserves the prior one-way notification shape exactly.
 *
 * Mirrors bash bus/post-activity.sh.
 */
export async function postActivity(
  orgDir: string,
  ctxRoot: string,
  org: string,
  message: string,
  replyMarkup?: object,
): Promise<boolean> {
  // Look for activity-channel.env
  const candidates = [
    join(orgDir, 'activity-channel.env'),
    join(ctxRoot, 'orgs', org, 'activity-channel.env'),
  ];

  let configPath: string | null = null;
  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      configPath = candidate;
      break;
    }
  }

  if (!configPath) {
    return false;
  }

  // Parse the env file
  let botToken: string | undefined;
  let chatId: string | undefined;

  try {
    const content = readFileSync(configPath, 'utf-8');
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eqIdx = trimmed.indexOf('=');
      if (eqIdx <= 0) continue;
      const key = trimmed.slice(0, eqIdx).trim();
      const value = trimmed.slice(eqIdx + 1).trim();
      if (key === 'ACTIVITY_BOT_TOKEN') botToken = value;
      if (key === 'ACTIVITY_CHAT_ID') chatId = value;
    }
  } catch {
    return false;
  }

  if (!botToken || !chatId) {
    return false;
  }

  try {
    const api = new TelegramAPI(botToken);
    await api.sendMessage(chatId, message, replyMarkup);
    return true;
  } catch {
    return false;
  }
}
