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
  // 'committed_partial': the commit succeeded but blocked[] is NON-EMPTY, so the
  // snapshot is incomplete. A partial snapshot reporting 'committed' is a success
  // badge on an unfinished job — the same inversion as a stale bundle re-shipped
  // as fresh. Callers must be able to tell the two apart without reading blocked[].
  status: 'staged' | 'committed' | 'committed_partial' | 'clean' | 'nothing_to_stage' | 'dry_run' | 'failed';
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
// Vendor shapes are never prefixed, so `\b` would in fact serve here; this spells
// the same intent explicitly. The REAL `\b` defect is on the ASSIGNMENT key below,
// where the guard is simply ABSENT — `\bTOKEN` can never fire inside `BOT_TOKEN`
// because `_` is a word character, so no boundary exists between `_` and `T`.
// Measured 2026-07-10: a mutation of THIS constant left the suite green, which is
// how I learned it was not the line doing the work. The isolating case is
// `xxxpassword=abc123def456`, which only the assignment key can catch.
const NOT_IDENT_BEFORE = '(?:^|[^A-Za-z0-9_])';

// A Telegram bot token is <bot_id>:<35-char secret>. It carries NO vendor prefix
// and it is not an assignment, so none of the other patterns can see it. This is
// the exact shape that reached a MEMORY.md on 2026-07-09.
const BARE_TELEGRAM_TOKEN = new RegExp(
  `${NOT_IDENT_BEFORE}\\d{6,12}:[A-Za-z0-9_-]{35}(?![A-Za-z0-9_-])`,
);

const CREDENTIAL_KEY_SHAPES = new RegExp(
  [
    'AIza[0-9A-Za-z_\\-]{35}',                        // Google API key
    `${NOT_IDENT_BEFORE}sk-[A-Za-z0-9]{20,}`,         // OpenAI-style key
    `${NOT_IDENT_BEFORE}github_pat_[A-Za-z0-9_]{20,}`, // GitHub fine-grained PAT
    `${NOT_IDENT_BEFORE}ghp_[A-Za-z0-9]{20,}`,        // GitHub classic PAT
    `${NOT_IDENT_BEFORE}xoxb-[0-9A-Za-z-]{10,}`,      // Slack bot token
    `${NOT_IDENT_BEFORE}AKIA[0-9A-Z]{16}(?![A-Z0-9])`, // AWS access key id
    // A JWT is DOTTED, and looksLikeSecretValue() excuses dotted values as
    // property access. It must be caught as a shape or it slips that exemption.
    `${NOT_IDENT_BEFORE}eyJ[A-Za-z0-9_-]{8,}\\.[A-Za-z0-9_-]{8,}\\.[A-Za-z0-9_-]{8,}`,
    BARE_TELEGRAM_TOKEN.source,                        // Telegram bot token
  ].join('|'),
);

// An assignment carrying an opaque value: token=…, api_key: "…", BOT_TOKEN=…
//
// THE KEY IS NOT THE DISCRIMINATOR. THE VALUE IS.
// The old pattern gated on `\b<key>\s*[=:]\s*<6 word chars>`, which is satisfied
// by ordinary English. Measured 2026-07-10, all three BLOCKED on the live screen:
//     "The bot token = single point of failure"     -> token = single
//     "Status of the token: REVOKED as of ..."      -> token: REVOKED
//     "Treat the secret = permanent once ..."       -> secret = permanent
// A screen that cannot tell a credential from PROSE ABOUT a credential drops
// exactly the files that document the incident it exists to prevent.
//
// So: the key gets LOOSER (any identifier prefix — BOT_TOKEN, GITHUB_TOKEN,
// xxxpassword), and the VALUE must look like a secret rather than like a word.
const ASSIGNMENT_CANDIDATE =
  /(?:token|api[_-]?key|passwd|password|secret)\s*[=:]\s*(?:"([^"\r\n]{1,256})"|'([^'\r\n]{1,256})'|([A-Za-z0-9_\-./+:]{1,256}))/gi;

/**
 * Does this assigned value look like a secret, as opposed to a WORD or a CODE
 * REFERENCE?
 *
 * The corpus that defines this function is not hypothetical. It is
 * memory/phase2-diffs/8719612.patch — a TypeScript lexer diff that the old
 * screen ate on 2026-06-02 and that nobody missed for three weeks, because the
 * status said "committed". It matched on `token: string`, `token: process…`,
 * `token = parsed…`. Its three sibling .patch files, larger and tracked, matched
 * nothing. Content was the only discriminator. So the false positives that
 * matter are not prose about secrets — they are ORDINARY SOURCE CODE containing
 * the word `token`. Any agent committing a diff, a grammar, a tokeniser, a JWT
 * helper or an OAuth snippet loses that file silently.
 *
 * Rules, in order:
 *   - a vendor or bare-token SHAPE is a secret whatever its length     -> block
 *   - a value containing `.` or `/` is a property access, module path
 *     or filesystem path (`crypto.randomBytes`, `process.env.KEY`)     -> stage
 *   - otherwise it must carry BOTH a letter and a digit, at >=6 chars   -> block
 *
 * The digit is what saves `string`, `parsed`, `process`, `single`, `REVOKED`,
 * `permanent` — every value the old screen actually ate, none of which has one.
 *
 * STATED LIMITATIONS, because an unstated one is worse than a stated one:
 *   - an all-alphabetic secret stages, short or long (`password = letmein`,
 *     `secret = correcthorsebatterystaple`);
 *   - a digit-bearing IDENTIFIER blocks (`const token = sha256Hash`), a false
 *     positive shared with `token=abc123`, which this repo has always required
 *     to block. The two are indistinguishable by content and a length floor
 *     cannot separate them — raising it to 12 to spare `sha256Hash` unblocks
 *     `token=abc123`. Measured: it broke two existing tests.
 * Every credential this fleet actually handles — Telegram, Google, GitHub, AWS,
 * Slack, JWT, bcrypt, apr1 — is caught by its own SHAPE rule above and does not
 * depend on this heuristic at all.
 */
export function looksLikeSecretValue(value: string): boolean {
  // A vendor/bare-token shape is a secret regardless of length or charset.
  // Checked FIRST, because a JWT is dotted and would be excused as a path below.
  if (new RegExp(CREDENTIAL_KEY_SHAPES.source).test(value)) return true;

  // Interpolation, placeholder, or redaction marker — never a literal secret:
  //   "${GEMINI_API_KEY:-}"  shell/CI expansion   (memory/phase2-diffs/a89cee2.patch:372)
  //   "<REDACTED>"           deliberate redaction, must stay committable
  // Loosening the key so `GEMINI_API_KEY=` matches is what surfaced these; the
  // value side has to know a reference from a literal.
  if (/[$<>{}]/.test(value)) return false;

  // Property access, module path, or file path -> a reference, not a literal.
  //   crypto.randomBytes · process.env.OPENAI_API_KEY · req.body.password
  if (/[./]/.test(value)) return false;

  // THE DIGIT IS THE DISCRIMINATOR, NOT THE LENGTH.
  // The values the old screen ate are English words and bare identifiers —
  // `string`, `parsed`, `process`, `single`, `REVOKED`, `permanent` — and not one
  // of them carries a digit. The values it must catch — `abc123`, `abc123def456` —
  // all do. The pre-existing {6,} floor is kept, so `token=abc123` still blocks
  // exactly as tests/unit/bus/system.test.ts has always asserted.
  //
  // A length floor CANNOT do this job: raising it to 12 to spare an invented
  // `sha256Hash` silently unblocks `token=abc123`. Measured 2026-07-10 — it broke
  // two existing tests, which is the only reason I found out.
  const hasAlpha = /[A-Za-z]/.test(value);
  const hasDigit = /[0-9]/.test(value);
  return hasAlpha && hasDigit && value.length >= 6;
}

function hasCredentialAssignment(content: string): boolean {
  ASSIGNMENT_CANDIDATE.lastIndex = 0; // /g regexes carry state between calls
  let m: RegExpExecArray | null;
  while ((m = ASSIGNMENT_CANDIDATE.exec(content)) !== null) {
    const value = m[1] ?? m[2] ?? m[3] ?? '';
    if (looksLikeSecretValue(value)) return true;
  }
  return false;
}

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

export function hasCredential(content: string): boolean {
  return (
    CREDENTIAL_KEY_SHAPES.test(content) ||
    hasCredentialAssignment(content) ||
    CREDENTIAL_HTPASSWD.test(content)
  );
}

/**
 * Can this file's bytes be screened at all?
 *
 * Classify by DECODABILITY, never by extension. An extension blocklist is a
 * proxy that always lags the thing it proxies: it needs .webp, .heic, .avif,
 * .odt, .parquet appended forever, and it still mis-files a cleartext PDF as
 * unscreenable when the regexes read it perfectly well.
 *
 * Measured 2026-07-10 against the live screen:
 *   PDF, secret in cleartext        -> regexes SAW it  (so PDFs are screenable)
 *   PDF, secret DEFLATE-compressed  -> regexes saw nothing, file staged
 *   PNG, secret in a tEXt chunk     -> depends purely on the bytes around it
 *
 * So binaryness was never the property that mattered. ENCODING is. A file whose
 * bytes do not decode as text cannot be meaningfully screened, and staging it
 * with a clean bill of health is the same success-badge inversion as reporting
 * "committed" over a non-empty blocked[].
 */
export function isUnscreenableBinary(buf: Buffer): boolean {
  const n = Math.min(buf.length, 8192);
  if (n === 0) return false;
  for (let i = 0; i < n; i++) {
    if (buf[i] === 0) return true; // a NUL byte is never text
  }
  const decoded = buf.subarray(0, n).toString('utf-8');
  let replacements = 0;
  for (const ch of decoded) {
    if (ch === '�') replacements++;
  }
  return decoded.length > 0 && replacements / decoded.length > 0.02;
}

// RETIRED 2026-07-10. `.sh`, `.py` and `.js` were exempted from the credential
// check entirely (old system.ts:256 and :325), so a .md holding
// `password=abc123def456` was blocked while a .py holding THE SAME BYTES was
// staged. Scripts are the likeliest place on this box for a hardcoded
// credential. This was a SCOPE gap; no regex could have closed it.
//
// The exemption existed because source code trips the assignment pattern
// (`token: string`). That is now handled where it belongs — in
// looksLikeSecretValue() — so the scope fix and the value fix must ship
// together. Shipping scope without value would block most scripts on the fleet.

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

    // Screen EVERY file's content — scripts included. Classify by decodability,
    // and never let an unreadable file through wearing a clean bill of health.
    if (existsSync(fullPath)) {
      try {
        const stat = statSync(fullPath);
        if (stat.isFile() && stat.size < MAX_FILE_SIZE) {
          const buf = readFileSync(fullPath);
          if (isUnscreenableBinary(buf)) {
            blocked.push(`${file}:unscreenable_binary`);
            continue;
          }
          if (hasCredential(buf.toString('utf-8'))) {
            blocked.push(`${file}:credential_pattern_detected`);
            continue;
          }
        }
      } catch {
        // A file we cannot even read is a file we cannot screen. Name it.
        blocked.push(`${file}:unreadable`);
        continue;
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
    if (stat.size < MAX_FILE_SIZE) {
      const buf = readFileSync(fullPath);
      if (isUnscreenableBinary(buf)) return 'unscreenable_binary';
      if (hasCredential(buf.toString('utf-8'))) return 'credential_pattern_detected';
    }
  } catch {
    // A file we cannot read is a file we cannot screen. Refusing to stage it is
    // the only honest answer; "fall through and allow" reported a check it never ran.
    return 'unreadable';
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

  // A commit that left files behind is NOT a completed snapshot. Reporting
  // 'committed' over a non-empty blocked[] is why memory/phase2-diffs/8719612.patch
  // went missing on 2026-07-09 and nobody noticed for three weeks: the badge said
  // the job was done. Same inversion as a stale bundle re-shipped as fresh.
  const status = blocked.length > 0 ? 'committed_partial' : 'committed';
  return { status, staged, blocked, diff_stat: diffStat, commit, repo: agentDir };
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
