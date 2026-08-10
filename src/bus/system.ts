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
  /**
   * Blocked TEXT files — every blocked entry whose reason is NOT a by-design
   * policy block (binary_or_temp / data_dump). A BLOCKED .png IS POLICY; A
   * BLOCKED .md IS AN INCIDENT (chief, 2026-07-14). 2026-07-13: chief's
   * MEMORY.md sat unversioned for 18 hours inside a `committed_partial` whose
   * blocked[] held ~120 by-design binary rows — the one line that mattered was
   * furniture in a field that is non-empty EVERY night. Measured N=2: a
   * perfectly healthy snapshot also reads `committed_partial` (engineer,
   * ce15462, zero text blocks, 4 policy rows), so the status carries NO health
   * information and "report if failed" can never fire. THIS field is the
   * signal: empty = healthy steady state regardless of status; non-empty =
   * someone's operating file or memory is silently unversioned RIGHT NOW.
   * First in the struct so it is first in every serialized report.
   */
  blocked_text: string[];
  staged: string[];
  blocked: string[];
  /** Allowlist paths present in this agent dir (the snapshot's DENOMINATOR — a
   *  versioning arm that checks one file must not assert a category). */
  covered_paths?: string[];
  /** Allowlist paths absent in this agent dir (named, not silently skipped). */
  absent_paths?: string[];
  diff_stat?: string;
  commit?: string;
  repo?: string;
  reason?: string;
}

/**
 * AGE axis, read from goals.json `updated_at`.
 *   ok           — within the threshold
 *   aged         — older than the threshold
 *   no_timestamp — goals.json exists but has no usable updated_at (e.g. never cascaded)
 *   missing      — no goals.json at all
 */
export type GoalAgeStatus = 'ok' | 'aged' | 'no_timestamp' | 'missing';

/**
 * CURRENCY axis. Deliberately NOT a fresh/stale binary. A script cannot verify
 * that a free-text goal still reflects reality, so this check NEVER certifies a
 * goal as "current". It reports only what it can stand behind:
 *   has_dead_goal — at least one goal names a COMPLETED ticket (dead at any age)
 *   unverified    — currency could not be checked. A REFUSAL, not an all-clear:
 *                   a goal can be false and recent (age says nothing about truth).
 */
export type GoalCurrency = 'has_dead_goal' | 'unverified';

export interface DeadGoal {
  /** Truncated goal text. */
  goal: string;
  /** The completed ticket id from the goal's DECLARED done_when. */
  handle: string;
}

/**
 * A goal that DECLARES a done_when handle which did not resolve. Surfaced as its
 * own signal, not folded into 'unverified' — because a bad handle looks exactly
 * like a good one until something tries to resolve it, and an honest UNVERIFIED
 * would otherwise mask a real state (chief, 2026-07-13). The upstream fix is the
 * cascade refusing to WRITE an unresolvable handle; this is the read-side backstop.
 */
export interface UnresolvableHandle {
  goal: string;
  handle: string;
}

/**
 * Blocked-reason suffixes that are BY-DESIGN policy blocks: expected every
 * night, carrying no health signal. Everything else (credential shapes, etc.)
 * on a screened file is incident-class and lands in blocked_text.
 */
const POLICY_BLOCK_REASONS = new Set([
  'binary_or_temp',
  'data_dump',
  'env_format',
  // 'unscreenable_binary' means the CONTENT SNIFFER determined the file is
  // binary, so the credential screen cannot read it — structurally the same
  // situation as a .png blocked by extension (binary_or_temp), which this set
  // already treats as policy. It was landing in the incident class purely
  // because the classification keys off the reason string rather than the
  // question the reason answers ("is this redactable text?" — a binary never
  // is). Extension-blocked and sniffer-blocked binaries are one class.
  //
  // Measured cost of having it loud (2026-07-24): business-analyst's
  // auto-commit exits 1 EVERY night on 58 permanently-unscreenable PDFs in its
  // workspace. Blocking is per-file so coverage was never affected — but a
  // standing daily red on the exact instrument that carries config into git
  // trains every reader to wave off that instrument's status. An alarm that
  // fires every night for a condition that can never be fixed is not an alarm.
  //
  // The loud class stays loud for what it was built for: a SCREENED (i.e.
  // readable text) file whose content matched a credential shape — redactable,
  // actionable, genuinely incident-class.
  'unscreenable_binary',
]);

/** blocked[] entries are "<path>:<reason>"; keep only incident-class ones. */
export function classifyBlockedText(blocked: string[]): string[] {
  return blocked.filter(e => !POLICY_BLOCK_REASONS.has(e.slice(e.lastIndexOf(':') + 1)));
}

export interface AgentGoalStatus {
  agent: string;
  org: string;
  // AGE axis — measurable from goals.json updated_at.
  updated_at?: string;
  age_days?: number;
  age_status: GoalAgeStatus;
  // DEADNESS axis — reads ONLY a goal's declared structured done_when field.
  // Never scrapes ticket ids from goal prose: a goal that CITES a completed ticket
  // as context is not a goal whose done-when IS that ticket, and prose cannot tell
  // them apart (that was the fuzzy-matcher failure, one layer down).
  goals_total: number;
  goals_with_done_when: number;
  dead_goals: DeadGoal[];
  unresolvable_handles: UnresolvableHandle[];
  // CURRENCY axis — the refusal state. Never 'current'/'fresh'.
  currency: GoalCurrency;
  /**
   * Does a human need to look? Fires ONLY on the done_when axes (a dead goal or an
   * unresolvable handle) plus the two structural cases (missing / malformed goals.json).
   * The AGE arm was REMOVED 2026-08-10 (b): the fleet cascade touches every goals.json,
   * so mtime stays under threshold and `aged` cannot fire for an active agent — the same
   * writes that break age as a direction proxy keep it green. age_status/age_days remain
   * as DESCRIPTIVE fields. `unverified` currency does NOT flip this true.
   */
  needs_attention: boolean;
  /**
   * Could the check REACH a verdict? False when the agent has goals but none carries a
   * checkable done_when — with the age arm gone, no axis can fire, so `needs_attention:false`
   * means UNEVALUABLE, not healthy. Absence is not zero. (A missing/malformed goals.json is
   * assessable:true — "broken" IS a verdict.)
   */
  assessable: boolean;
  reason: string;
}

export interface GoalStalenessReport {
  summary: {
    total: number;
    needs_attention: number;
    /** Agents the check could NOT evaluate (goals present, 0 checkable done_when). Their
     *  needs_attention:false is UNEVALUABLE, not clean — read this before trusting a green. */
    cannot_assess: number;
    dead: number;
    aged: number;
    no_goals: number;
    unverified: number;
    unresolvable_handles: number;
    goals_total: number;
    goals_with_done_when: number;
    threshold_days: number;
    /** The refusal principle AND the honest denominator, stated in the output so
     *  a reader cannot mistake 'unverified' for 'all clear' — nor this tool for a
     *  fix to stale goals. */
    note: string;
  };
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
//   apr1:   $apr1$<salt 1-8>$<22-char digest>        (fixed-length MD5 output)
//   bcrypt: $2[aby]$<cost 2>$<53 chars: 22 salt + 31 digest>   (MCF layout;
//           the `10$` cost field breaks a naive class)
// STRUCTURAL, not prefix-loose (2026-07-18, task_1784312753310): the old
// `{6,}` / `{20,}` tails fired on the WORD `$apr1$…` in prose, so every
// memory file DOCUMENTING credential work tripped the screen nightly and had
// to be hand-masked to snapshot. A real hash has a fixed structure; prose and
// placeholders (`$apr1$REPLACEME`) don't. Exact digest lengths with a
// boundary lookahead: strictly stronger in BOTH directions — the old apr1 arm
// also MISSED hashes with salts shorter than 6 chars, which now block.
// A redacted marker like `$apr1$<REDACTED>` matches neither, by design, so
// memory files stay committable once their hash bodies are stripped.
const CREDENTIAL_HTPASSWD =
  /\$apr1\$[A-Za-z0-9./]{1,8}\$[A-Za-z0-9./]{22}(?![A-Za-z0-9./])|\$2[aby]\$\d{2}\$[A-Za-z0-9./]{53}(?![A-Za-z0-9./])/;

/**
 * The htpasswd arm ALONE, for callers that scan PROSE-heavy corpora
 * (analyst's nightly credential-at-rest pass, Step 2b): full hasCredential
 * also carries the key-shape + assignment arms, which correctly fire on
 * `token=…` prose that a hash detector must not re-flag. Exported as a
 * FUNCTION, not the RegExp — a shared RegExp object invites lastIndex and
 * mutation coupling; the predicate is the contract. Import this instead of
 * copying the pattern: a copy agrees with the gate only until either edits.
 */
export function hasCredentialHash(content: string): boolean {
  return CREDENTIAL_HTPASSWD.test(content);
}

export function hasCredential(content: string): boolean {
  return (
    CREDENTIAL_KEY_SHAPES.test(content) ||
    hasCredentialAssignment(content) ||
    CREDENTIAL_HTPASSWD.test(content)
  );
}

/**
 * Is this content an env-format file — dominantly bare `NAME=value` lines?
 *
 * Why a CLASS gate exists at all (task_1784622395738, fix #1): auto-commit's
 * commit happens inside the call, so this screen is the only pre-commit gate —
 * the documented post-stage review is structurally post-commit. On a
 * NAME=value-shaped file the credential arms' zero is double-meaning: "no
 * secrets" and "no shapes I know" print the same 0 (2026-07-21: the matcher
 * returned 0 on three daemon env snapshots, correctly only because they
 * carried value LENGTHS, not values — a snapshot WITH values returns the same
 * 0). A file class that exists to carry secrets cannot be cleared by failing
 * to match; the sole gate refuses the class. Over-block is visible in
 * blocked[]; under-block is silent — so the tie breaks closed.
 *
 * Shape: `^IDENT=` with no spaces (the .env convention) — `export FOO=…` and
 * `key = value` INI style deliberately do not match. Ratio over non-blank,
 * non-# lines, with a 4-matching-line floor so prose carrying a small inline
 * example stays committable (stated limitation, asserted in
 * tests/unit/bus/env-format-gate.test.ts so it cannot drift silently; the
 * credential arms still screen every line of sub-floor files).
 */
export function isEnvFormatFile(content: string): boolean {
  const lines = content
    .split(/\r?\n/)
    .map(l => l.trim())
    .filter(l => l.length > 0 && !l.startsWith('#'));
  if (lines.length === 0) return false;

  const envLines = lines.filter(l => /^[A-Za-z_][A-Za-z0-9_]*=/.test(l));
  return envLines.length >= 4 && envLines.length / lines.length >= 0.8;
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
    return { status: 'clean', blocked_text: [], staged: [], blocked: [] };
  }

  // Get changed files
  let porcelainOutput: string;
  try {
    porcelainOutput = execSync('git status --porcelain', { cwd: projectDir, encoding: 'utf-8' });
  } catch {
    return { status: 'clean', blocked_text: [], staged: [], blocked: [] };
  }

  if (!porcelainOutput.trim()) {
    return { status: 'clean', blocked_text: [], staged: [], blocked: [] };
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

    // screenFile() below carries a comment claiming it holds "the same rules the
    // shared-tree autoCommit applies, in one place so the two paths cannot drift
    // apart." They HAD drifted, and the drift was precisely the rule added after a
    // 5.5MB pg_dump of the live Odoo tenant was committed on 2026-07-09:
    //   - this path never consulted DATA_DUMP_EXTENSIONS at all;
    //   - it called extname() without .toLowerCase(), so `.DUMP` walked past the
    //     binary gate too — the same bug wearing a different case.
    // The agent-repo path routes through screenFile() and so got the 07-09 fix.
    // This one never had it. Fixed the instance, left the class open.
    //
    // Decodability does NOT subsume this rule and must not be thought to: a pg_dump
    // decodes as perfectly clean text, contains no credential, and is every customer
    // record we hold. "Can I read it?" and "does this belong in a snapshot?" are
    // different questions, and only the second one stops a dump.
    const ext = extname(file).toLowerCase();
    if (BINARY_TEMP_EXTENSIONS.has(ext)) {
      blocked.push(`${file}:binary_or_temp`);
      continue;
    }
    if (DATA_DUMP_EXTENSIONS.has(ext)) {
      blocked.push(`${file}:data_dump`);
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
    // Rules mirror screenFile(); tests/unit/bus/env-format-gate.test.ts and
    // autocommit-path-parity.test.ts hold the two paths together — a comment
    // could not (2026-07-10).
    if (existsSync(fullPath)) {
      try {
        const stat = statSync(fullPath);
        // `size <= MAX`, not `<`: the over-cap case blocked above, and the
        // EXACTLY-at-cap case used to pass both gates unscreened.
        if (stat.isFile() && stat.size <= MAX_FILE_SIZE) {
          const buf = readFileSync(fullPath);
          if (isUnscreenableBinary(buf)) {
            blocked.push(`${file}:unscreenable_binary`);
            continue;
          }
          const text = buf.toString('utf-8');
          if (hasCredential(text)) {
            blocked.push(`${file}:credential_pattern_detected`);
            continue;
          }
          if (isEnvFormatFile(text)) {
            blocked.push(`${file}:env_format`);
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
    return { status: 'nothing_to_stage', blocked_text: classifyBlockedText(blocked), staged: [], blocked };
  }

  if (dryRun) {
    return { status: 'dry_run', blocked_text: classifyBlockedText(blocked), staged, blocked };
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

  return { status: 'staged', blocked_text: classifyBlockedText(blocked), staged, blocked, diff_stat: diffStat };
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
    // No size condition here: `size < MAX` left a file of EXACTLY the cap
    // passing both gates unscreened (the boundary fail-open). Not over the
    // cap ⇒ content gets read, always.
    const buf = readFileSync(fullPath);
    if (isUnscreenableBinary(buf)) return 'unscreenable_binary';
    const text = buf.toString('utf-8');
    if (hasCredential(text)) return 'credential_pattern_detected';
    if (isEnvFormatFile(text)) return 'env_format';
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
 *
 * THREE-ZONE UNION (2026-07-14, task_1783990536465). Before this, only zone 1
 * existed and every agent's OPERATING DEFINITION — who it is, how it boots,
 * what it must never do — had no history at all. Worse, the coverage gaps hid
 * each other: a file exempt from versioning was thereby exempt from the
 * credential screen (screening happens at staging), so GUARDRAILS.md carried a
 * credential-shaped literal for days that a first commit would have caught.
 * Fleet redaction pre-step ran BEFORE this list grew (660 files, imported
 * hasCredential, controls both ways, 0 flagged) so the extension cannot land
 * as a fleet-wide silent block.
 *   zone 1: memory/ workspace/ MEMORY.md            (the original allowlist)
 *   zone 2: the operating definition + its data     (*.md at root, config.json, goals.json)
 *   zone 3: .claude/ (settings + skills) + experiments/
 */
const AGENT_REPO_PATHS = [
  // zone 1
  'memory', 'workspace', 'MEMORY.md',
  // zone 2 — operating definition
  'AGENTS.md', 'CLAUDE.md', 'GOALS.md', 'GUARDRAILS.md', 'HEARTBEAT.md',
  'IDENTITY.md', 'ONBOARDING.md', 'SOUL.md', 'SYSTEM.md', 'TOOLS.md', 'USER.md',
  'config.json', 'goals.json',
  // zone 3 — skills, settings, experiment learnings
  '.claude', 'experiments',
];

/** Never let these into the snapshot repo, even via an explicit add. */
const AGENT_REPO_EXCLUDE = [
  // '.env*' (not just '.env') so credential-bearing variants like
  // '.env.bak-<ts>' and '.env.save' can never ride a manual `git add -A`.
  '.env*', '.cortextos-env', '*.log', 'local/', '.cache/',
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
    return { status: 'failed', blocked_text: [], staged: [], blocked: [], reason: `agent dir not found: ${agentDir}` };
  }

  const present = AGENT_REPO_PATHS.filter(p => existsSync(join(agentDir, p)));
  const absent = AGENT_REPO_PATHS.filter(p => !present.includes(p));
  if (present.length === 0) {
    return { status: 'clean', blocked_text: [], staged: [], blocked: [], repo: agentDir, covered_paths: present, absent_paths: absent };
  }

  // Force past the agent-dir .gitignore, then inspect what actually landed.
  execFileSync('git', ['add', '-f', '--', ...present], { cwd: agentDir, stdio: 'pipe' });

  const candidates = execSync('git diff --cached --name-only', { cwd: agentDir, encoding: 'utf-8' })
    .split('\n').map(l => l.trim()).filter(Boolean);

  if (candidates.length === 0) {
    execFileSync('git', ['reset', '-q'], { cwd: agentDir, stdio: 'pipe' });
    return { status: 'clean', blocked_text: [], staged: [], blocked: [], repo: agentDir, covered_paths: present, absent_paths: absent };
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
      blocked_text: classifyBlockedText(blocked),
      staged: [],
      blocked,
      repo: agentDir,
      covered_paths: present,
      absent_paths: absent,
      reason: `${candidates.length} changed file(s) but 0 stageable — all screened out`,
    };
  }

  if (dryRun) {
    execFileSync('git', ['reset', '-q'], { cwd: agentDir, stdio: 'pipe' });
    return { status: 'dry_run', blocked_text: classifyBlockedText(blocked), staged, blocked, repo: agentDir, covered_paths: present, absent_paths: absent };
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
  return {
    status,
    blocked_text: classifyBlockedText(blocked),
    staged, blocked,
    covered_paths: present, absent_paths: absent,
    diff_stat: diffStat, commit, repo: agentDir,
  };
}

/**
 * Check goal staleness for all agents across all orgs.
 * Mirrors bash bus/check-goal-staleness.sh.
 */
export interface CheckGoalStalenessOptions {
  /** Override the clock (for testing). */
  now?: number;
  /**
   * Resolve a ticket id to its status string ('completed', 'in_progress', ...),
   * 'missing' if the ticket cannot be found, or null if the task store is
   * unavailable. Injected by the CLI, which holds the task-store paths.
   *
   * The deadness axis only ever declares a goal DEAD on a POSITIVE 'completed'.
   * If this is absent, or returns anything else, the goal stays UNVERIFIED — the
   * check never guesses a goal is dead, and never guesses it is current either.
   */
  resolveTaskStatus?: (taskId: string) => string | null;
}

/** A goal is either free text or an object that can declare a structured done_when. */
interface StructuredGoal {
  text: string;
  done_when?: { type?: string; id?: string };
}

function normalizeGoal(g: unknown): StructuredGoal {
  if (typeof g === 'string') return { text: g };
  if (g && typeof g === 'object') {
    const o = g as { text?: unknown; done_when?: unknown };
    return {
      text: typeof o.text === 'string' ? o.text : JSON.stringify(g),
      done_when:
        o.done_when && typeof o.done_when === 'object'
          ? (o.done_when as { type?: string; id?: string })
          : undefined,
    };
  }
  return { text: String(g) };
}

function goalStalenessNote(goalsTotal: number, goalsWithDoneWhen: number): string {
  return (
    'This check reports independent axes and NEVER certifies a goal as "fresh"/"current". ' +
    '(1) AGE from goals.json updated_at is DESCRIPTIVE ONLY — removed from needs_attention ' +
    '2026-08-10 (b): the fleet cascade touches every goals.json, so mtime stays under ' +
    'threshold and `aged` cannot fire for an active agent (a broken direction-age proxy). ' +
    '(2) DEADNESS reads ONLY a goal\'s declared ' +
    'structured done_when field — never ticket ids scraped from prose (a goal that cites a ' +
    'completed ticket as context is not a goal whose done-when IS that ticket). A done_when ' +
    'task that resolves to completed is dead at any age; a declared handle that does not ' +
    'resolve is surfaced as unresolvable, not guessed. (3) CURRENCY is UNVERIFIED wherever ' +
    'done-state cannot be checked — a REFUSAL, not an all-clear: a goal can be false and recent. ' +
    `DENOMINATOR: ${goalsWithDoneWhen}/${goalsTotal} goals declare a done_when handle, so ` +
    'deadness can only fire on those. With the age arm gone, an agent whose goals declare 0 ' +
    'checkable done_when is UNEVALUABLE: its needs_attention:false is surfaced as CANNOT_ASSESS, ' +
    'NOT clean (see summary.cannot_assess). This tool does NOT fix stale goals — it stops issuing ' +
    'verdicts it has not earned. Until goals carry a resolvable done_when, the fleet still has ' +
    'goals nothing can check; the numerator is honest and the denominator is what it is.'
  );
}

export function checkGoalStaleness(
  projectRoot: string,
  thresholdDays: number = 7,
  opts: CheckGoalStalenessOptions = {},
): GoalStalenessReport {
  const agents: AgentGoalStatus[] = [];
  const thresholdMs = thresholdDays * 86400 * 1000;
  const now = opts.now ?? Date.now();
  const resolveTaskStatus = opts.resolveTaskStatus;

  const orgsDir = join(projectRoot, 'orgs');
  if (!existsSync(orgsDir)) {
    return {
      summary: {
        total: 0, needs_attention: 0, cannot_assess: 0, dead: 0, aged: 0, no_goals: 0, unverified: 0,
        unresolvable_handles: 0, goals_total: 0, goals_with_done_when: 0,
        threshold_days: thresholdDays, note: goalStalenessNote(0, 0),
      },
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
      const goalsJson = join(agentsDir, agentName, 'goals.json');

      // Source of truth is goals.json, NOT the rendered GOALS.md. GOALS.md is a
      // generated view whose "## Updated" line carries a "(by <who>)" suffix that
      // `new Date()` rejects as Invalid Date — parsing the rendering was the
      // original bug: it failed CLOSED and reported every cascaded agent as stale
      // (only an un-cascaded agent, with a bare timestamp, ever parsed).
      if (!existsSync(goalsJson)) {
        agents.push({
          agent: agentName, org: orgName,
          updated_at: undefined, age_days: undefined, age_status: 'missing',
          goals_total: 0, goals_with_done_when: 0, dead_goals: [], unresolvable_handles: [],
          currency: 'unverified', needs_attention: true, assessable: true,
          reason: 'no goals.json',
        });
        continue;
      }

      let parsed: { updated_at?: unknown; goals?: unknown };
      try {
        parsed = JSON.parse(readFileSync(goalsJson, 'utf-8'));
      } catch {
        agents.push({
          agent: agentName, org: orgName,
          updated_at: undefined, age_days: undefined, age_status: 'missing',
          goals_total: 0, goals_with_done_when: 0, dead_goals: [], unresolvable_handles: [],
          currency: 'unverified', needs_attention: true, assessable: true,
          reason: 'goals.json unreadable or malformed',
        });
        continue;
      }

      const updatedAt = typeof parsed.updated_at === 'string' ? parsed.updated_at.trim() : '';
      const goals: StructuredGoal[] = Array.isArray(parsed.goals)
        ? parsed.goals.map(normalizeGoal)
        : [];

      // AGE axis — from the authoritative ISO timestamp in goals.json.
      let ageStatus: GoalAgeStatus;
      let ageDays: number | undefined;
      if (!updatedAt) {
        ageStatus = 'no_timestamp'; // e.g. never cascaded (empty updated_at)
      } else {
        const t = Date.parse(updatedAt);
        if (isNaN(t)) {
          ageStatus = 'no_timestamp';
        } else {
          ageDays = Math.floor((now - t) / 86400000);
          ageStatus = now - t > thresholdMs ? 'aged' : 'ok';
        }
      }

      // DEADNESS axis — reads ONLY a goal's DECLARED structured done_when field.
      // A done_when task that resolves to 'completed' is dead at any age. A declared
      // handle that does not resolve is surfaced (unresolvable_handles), not guessed.
      // Anything else — no done_when, a non-completed status, a done_when type we
      // cannot evaluate — leaves the goal UNVERIFIED. Prose is never scraped: a goal
      // that cites a completed ticket as context is NOT a goal whose done-when is it.
      const truncate = (s: string) => (s.length > 100 ? s.slice(0, 97) + '...' : s);
      const deadGoals: DeadGoal[] = [];
      const unresolvableHandles: UnresolvableHandle[] = [];
      let goalsWithDoneWhen = 0;
      for (const g of goals) {
        const dw = g.done_when;
        if (!dw) continue; // no declared done-when -> UNVERIFIED (never scrape prose)
        goalsWithDoneWhen++;
        if (dw.type !== 'task' || typeof dw.id !== 'string' || !dw.id) continue; // unevaluable type -> unverified
        if (!resolveTaskStatus) continue; // cannot verify here -> unverified
        const status = resolveTaskStatus(dw.id);
        if (status === 'completed') {
          deadGoals.push({ goal: truncate(g.text), handle: dw.id });
        } else if (status === 'missing' || status === null) {
          unresolvableHandles.push({ goal: truncate(g.text), handle: dw.id });
        }
        // else: a real status that is not completed -> the goal is verifiably NOT
        // done, i.e. legitimately live. Not dead; currency stays unverified (being
        // un-done does not make the goal the RIGHT goal — we do not certify that).
      }

      // CURRENCY axis — the refusal state. Never 'current'/'fresh'.
      const currency: GoalCurrency = deadGoals.length > 0 ? 'has_dead_goal' : 'unverified';
      // (b) 2026-08-10: AGE arm REMOVED from needs_attention — a broken proxy for
      // direction-age. The fleet cascade touches every goals.json, so mtime stays under
      // threshold and `aged` cannot fire for an active agent; the writes that break age
      // as a proxy are the same writes that keep it green. needs_attention now fires on the
      // done_when axes + an EMPTY goals[] read from the ARRAY (not mtime). age_status/age_days
      // remain descriptive fields.
      // EMPTY goals[] = no direction: the MOST assessable state there is, and a live orchestrator
      // duty (HEARTBEAT Step 6 — write goals for an empty file). Keyed on the ARRAY, never the
      // timestamp: this is the one file-check that stays reachable after the age arm is gone.
      const noGoals = goals.length === 0;
      const needsAttention =
        deadGoals.length > 0 ||
        unresolvableHandles.length > 0 ||
        noGoals;
      // ASSESSABLE: no-goals IS a verdict (no direction). Otherwise the done_when axes need a
      // handle; with none, the agent is UNEVALUABLE for staleness and needs_attention:false must
      // NOT be read as healthy. Absence is not zero.
      const assessable = noGoals || goalsWithDoneWhen > 0;

      const reasonParts: string[] = [];
      if (noGoals) {
        reasonParts.push(
          'empty goals[] — this agent has no direction. Expected if pre-onboarding; otherwise it has never been cascaded',
        );
      } else if (!assessable) {
        reasonParts.push(
          `CANNOT ASSESS — no goal carries a checkable done_when (${goalsWithDoneWhen}/${goals.length}); ` +
          `age arm removed as a broken proxy. needs_attention:false here means UNEVALUABLE, not healthy`,
        );
      }
      if (deadGoals.length > 0) {
        reasonParts.push(
          `${deadGoals.length} goal(s) whose done_when is a COMPLETED ticket (${deadGoals.map(d => d.handle).join(', ')}) — dead at any age`,
        );
      }
      if (unresolvableHandles.length > 0) {
        reasonParts.push(
          `${unresolvableHandles.length} declared done_when handle(s) did NOT resolve (${unresolvableHandles.map(h => h.handle).join(', ')}) — bad handle, surfaced not guessed`,
        );
      }
      // AGE is descriptive only now (age_status/age_days fields carry it); NOT a trigger.
      reasonParts.push(`age ${ageDays ?? '?'}d/${ageStatus} (descriptive — not a needs_attention trigger)`);
      if (currency === 'unverified') {
        reasonParts.push(
          `currency UNVERIFIED — ${goalsWithDoneWhen}/${goals.length} goals declare a done_when, the rest cannot be verified (not an all-clear)`,
        );
      }

      agents.push({
        agent: agentName, org: orgName,
        updated_at: updatedAt || undefined,
        age_days: ageDays,
        age_status: ageStatus,
        goals_total: goals.length,
        goals_with_done_when: goalsWithDoneWhen,
        dead_goals: deadGoals,
        unresolvable_handles: unresolvableHandles,
        currency,
        needs_attention: needsAttention,
        assessable,
        reason: reasonParts.join('; '),
      });
    }
  }

  const goalsTotal = agents.reduce((n, a) => n + a.goals_total, 0);
  const goalsWithDoneWhen = agents.reduce((n, a) => n + a.goals_with_done_when, 0);

  return {
    summary: {
      total: agents.length,
      needs_attention: agents.filter(a => a.needs_attention).length,
      cannot_assess: agents.filter(a => !a.assessable).length,
      dead: agents.filter(a => a.dead_goals.length > 0).length,
      aged: agents.filter(a => a.age_status === 'aged').length,
      no_goals: agents.filter(a => a.age_status === 'missing' || a.age_status === 'no_timestamp').length,
      unverified: agents.filter(a => a.currency === 'unverified').length,
      unresolvable_handles: agents.filter(a => a.unresolvable_handles.length > 0).length,
      goals_total: goalsTotal,
      goals_with_done_when: goalsWithDoneWhen,
      threshold_days: thresholdDays,
      note: goalStalenessNote(goalsTotal, goalsWithDoneWhen),
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
