import { execFileSync, spawnSync } from 'child_process';
import { existsSync, mkdirSync, readFileSync, statSync, readdirSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import type { BusPaths } from '../types/index.js';
import { normalizeOrgName } from '../utils/org.js';
import { hasCredential, isUnscreenableBinary } from './system.js';

/**
 * Knowledge base integration — calls mmrag.py directly (cross-platform,
 * no bash dependency).  Previously wrapped kb-*.sh bash scripts.
 */

/**
 * Resolve the Python interpreter inside the knowledge-base venv,
 * accounting for Windows vs Unix layout.
 */
function getVenvPython(frameworkRoot: string): string {
  const isWin = process.platform === 'win32';
  const venvBin = isWin ? 'Scripts' : 'bin';
  const pythonExe = isWin ? 'python.exe' : 'python3';
  return join(frameworkRoot, 'knowledge-base', 'venv', venvBin, pythonExe);
}

/**
 * Load .env and secrets.env files the same way the bash scripts did
 * (`set -o allexport && source …`).  Returns a flat key→value map.
 */
function loadSecretsEnv(frameworkRoot: string, org: string): Record<string, string> {
  const secretsPath = join(frameworkRoot, 'orgs', org, 'secrets.env');
  const dotenvPath = join(frameworkRoot, '.env');
  const vars: Record<string, string> = {};
  for (const p of [dotenvPath, secretsPath]) {
    if (existsSync(p)) {
      for (const line of readFileSync(p, 'utf-8').split('\n')) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const idx = trimmed.indexOf('=');
        if (idx > 0) {
          let val = trimmed.slice(idx + 1);
          // Strip surrounding quotes (single or double) that some .env files use
          if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
            val = val.slice(1, -1);
          }
          vars[trimmed.slice(0, idx)] = val;
        }
      }
    }
  }
  return vars;
}

/**
 * Check whether the knowledge base config file exists for a given env.
 *
 * The Python MMRAG tool loads its config from env.MMRAG_CONFIG
 * (`knowledge-base/config.json` under the org's state dir) and exits with
 * "Config not found. Run setup first" if the file is absent. When that
 * happens, execFileSync throws a non-zero-exit error which — if not caught
 * — produces a user-facing unhandled-throw stack dump on top of the
 * already-printed Python error. This helper lets callers detect the
 * missing-config state UP FRONT and respond gracefully (warn + return)
 * instead of relying on brittle stderr string matching after the throw.
 */
function kbConfigured(env: Record<string, string>): boolean {
  return existsSync(env.MMRAG_CONFIG);
}

/**
 * Build the full env object needed by mmrag.py calls.
 */
function buildKBEnv(
  frameworkRoot: string,
  org: string,
  instanceId: string,
  agent?: string,
): Record<string, string> {
  // Normalize org to its canonical filesystem casing BEFORE touching any
  // paths. Without this, a lowercase --org arg produces a ghost state dir
  // (~/.cortextos/<instance>/orgs/<lowercase>/knowledge-base/) with its own
  // MMRAG config.json, splitting KB state across two directories and
  // polluting dashboard sync with hits against a non-existent org.
  const canonicalOrg = normalizeOrgName(frameworkRoot, org);
  const kbRoot = join(homedir(), '.cortextos', instanceId, 'orgs', canonicalOrg, 'knowledge-base');
  const secrets = loadSecretsEnv(frameworkRoot, canonicalOrg);
  return {
    ...process.env as Record<string, string>,
    ...secrets,
    CTX_ORG: canonicalOrg,
    CTX_AGENT_NAME: agent || '',
    CTX_INSTANCE_ID: instanceId,
    CTX_FRAMEWORK_ROOT: frameworkRoot,
    MMRAG_DIR: kbRoot,
    MMRAG_CHROMADB_DIR: join(kbRoot, 'chromadb'),
    MMRAG_CONFIG: join(kbRoot, 'config.json'),
  };
}

export interface KBQueryResult {
  content: string;
  source_file: string;
  agent_name?: string;
  org: string;
  score: number;
  doc_type: string;
}

export interface KBQueryResponse {
  results: KBQueryResult[];
  total: number;
  query: string;
  collection: string;
}

/**
 * Query the knowledge base.
 * Returns parsed JSON results when --json is used internally.
 */
export function queryKnowledgeBase(
  paths: BusPaths,
  question: string,
  options: {
    org: string;
    agent?: string;
    scope?: 'shared' | 'private' | 'all';
    collection?: string;
    topK?: number;
    threshold?: number;
    frameworkRoot: string;
    instanceId: string;
  },
): KBQueryResponse {
  const { agent, scope = 'all', collection: collectionOverride, topK = 5, threshold = 0.5, frameworkRoot, instanceId } = options;
  // Normalize once at the top so every downstream path join, env var, and
  // ChromaDB collection name uses the canonical filesystem casing. Without
  // this, `shared-acmecorp` and `shared-AcmeCorp` become two
  // distinct ChromaDB collections and a case-drifted query silently hits
  // the wrong one.
  const org = normalizeOrgName(frameworkRoot, options.org);

  const env = buildKBEnv(frameworkRoot, org, instanceId, agent);

  // UX safety net: if the KB is not configured for this org (no config.json
  // on disk yet), skip the python probe entirely and return empty results
  // with a visible warning. Previously the inner runQuery() try/catch would
  // swallow the Config-not-found error silently and the operator would see
  // "0 results" with no hint about WHY — indistinguishable from a legitimate
  // empty query against a configured KB. The warn-and-empty shape makes the
  // distinction obvious and actionable.
  if (!kbConfigured(env)) {
    console.warn(
      `[kb] Knowledge base not configured for org ${org}. Returning empty results — run setup to enable.`,
    );
    return { results: [], total: 0, query: question, collection: `shared-${org}` };
  }

  const pythonPath = getVenvPython(frameworkRoot);
  const mmragPath = join(frameworkRoot, 'knowledge-base', 'scripts', 'mmrag.py');

  // Determine which collections to query. If --collection is explicitly set,
  // it overrides scope-derived names entirely — this is the escape hatch for
  // non-default collections like memory-{agent}.
  const collections: string[] = [];
  if (collectionOverride) {
    collections.push(collectionOverride);
  } else {
    switch (scope) {
      case 'shared':
        collections.push(`shared-${org}`);
        break;
      case 'private':
        collections.push(agent ? `agent-${agent}` : `shared-${org}`);
        break;
      case 'all':
        collections.push(`shared-${org}`);
        if (agent) collections.push(`agent-${agent}`);
        // `memory-{agent}` is where the daily-memory recipe ingests (see the
        // kb-ingest line in every agent's AGENTS.md / HEARTBEAT.md), yet before
        // 2026-07-09 scope 'all' never searched it. An agent asking "what was I
        // doing?" mid-session got a confident zero from collections that had
        // never held its diary, while its own memory sat indexed and unread.
        // Boot reads memory from disk, so this only ever bit MID-SESSION recall
        // — which is precisely when it is least likely to be noticed.
        // 'all' must mean all.
        if (agent) collections.push(`memory-${agent}`);
        break;
    }
  }

  // A FAILED QUERY AND AN EMPTY ONE ARE DIFFERENT FACTS.
  // This used to `catch { return null }`, and parseOutput(null) returned [], so a
  // missing collection, a python crash and a 30s timeout all became "0 results"
  // — identical to a healthy search that matched nothing. On 2026-07-09 that shape
  // produced a fleet-wide false alarm ("several agents' memory is unsearchable")
  // that survived until the byte layer contradicted it. A semantic miss is not
  // absence, and an error is not a miss.
  //
  // Note a missing `memory-{agent}` collection is NORMAL for an agent that has
  // never ingested a diary, so a failure here is reported, not thrown.
  const failed: Array<{ collection: string; reason: string }> = [];
  const runQuery = (col: string): string | null => {
    try {
      return execFileSync(pythonPath, [
        mmragPath, 'query', question,
        '--collection', col,
        '--top-k', String(topK),
        '--threshold', String(threshold),
        '--json',
      ], {
        encoding: 'utf-8',
        timeout: 30000,
        env,
      });
    } catch (err) {
      const e = err as { code?: string; signal?: string; message?: string };
      failed.push({
        collection: col,
        reason: e.signal === 'SIGTERM' ? 'timeout after 30s' : (e.message?.split('\n')[0] ?? 'unknown error'),
      });
      return null;
    }
  };

  const parseOutput = (output: string | null, col: string): KBQueryResult[] => {
    if (!output) return [];
    // mmrag.py --json outputs pretty-printed JSON; find and parse the JSON block
    const trimmed = output.trim();
    const jsonStart = trimmed.indexOf('{');
    if (jsonStart === -1) {
      // MEASURED 2026-07-09, not assumed: for a collection that does not exist,
      // mmrag.py EXITS 0 and prints the plain sentence
      //   "Knowledge base is empty. Ingest some files first."
      // to stdout. execFileSync therefore never throws, so the catch above never
      // records it, and this function used to `return []` — a silent zero for the
      // single most likely real failure. The throw-based guard I wrote first
      // covered the RARE case (python crash, timeout) and missed the common one.
      // Only probing the real binary surfaced this; the unit test mocked a throw.
      failed.push({ collection: col, reason: `non-JSON output: ${trimmed.slice(0, 60)}` });
      return [];
    }
    try {
      const raw = JSON.parse(trimmed.slice(jsonStart)) as {
        results?: Array<{ content?: string; result?: string; similarity?: number; source?: string; type?: string }>;
        result_count?: number;
        query?: string;
        collection?: string;
      };
      return (raw.results || []).map((r) => ({
        content: r.content || r.result || '',
        source_file: r.source || '',
        org,
        agent_name: agent,
        score: r.similarity ?? 0,
        doc_type: r.type || 'markdown',
      }));
    } catch {
      failed.push({ collection: col, reason: 'unparseable JSON from mmrag' });
      return [];
    }
  };

  let allResults: KBQueryResult[] = [];
  let lastCollection = `shared-${org}`;
  for (const col of collections) {
    const output = runQuery(col);
    allResults = allResults.concat(parseOutput(output, col));
    lastCollection = col;
  }

  // Merge-rank across collections. Without this, per-collection result blocks
  // concatenate in collection order, so a 0.7-scoring hit from a later
  // collection ranks below 0.5s from an earlier one and can fall outside the
  // caller's display window entirely — content present, scoring well, never
  // surfaced (observed 2026-07-22: result [6] at 0.603 listed below [1] at
  // 0.590; the likely mechanism behind "MEMORY.md chunks indexed but not
  // retrievable").
  allResults.sort((a, b) => b.score - a.score);

  // Report the zero, never merely return it. If every collection we consulted
  // errored, "0 results" says nothing about the knowledge base and everything
  // about the query failing — the caller must be able to tell those apart.
  if (failed.length > 0) {
    const detail = failed.map((f) => `${f.collection} (${f.reason})`).join(', ');
    if (failed.length === collections.length && allResults.length === 0) {
      console.warn(
        `[kb] ALL ${collections.length} collection(s) failed to query: ${detail}. ` +
          `This is a FAILED SEARCH, not an empty one — do not read the 0 results as "nothing indexed".`,
      );
    } else {
      console.warn(
        `[kb] ${failed.length} of ${collections.length} collection(s) failed: ${detail}. ` +
          `Results below are PARTIAL and exclude those collections.`,
      );
    }
  }

  if (allResults.length > 0) {
    return {
      results: allResults,
      total: allResults.length,
      query: question,
      collection: collections.length === 1 ? lastCollection : `shared-${org}`,
    };
  }

  return { results: [], total: 0, query: question, collection: `shared-${org}` };
}

/**
 * Ingest files into the knowledge base.
 */
/**
 * Screen ONE concrete file for a credential before it is embedded into the KB.
 *
 * Wires the CREDENTIAL predicate from the auto-commit screen (hasCredential in
 * ./system.ts) onto the ingest path, which never had a screen. The leak route it
 * closes: agents/{slash}memory is kb-ingested AND ships off-box in the nightly R2
 * backup, so a credential quoted into a memory file reaches an embedding store
 * and an off-box archive unscreened — one ordinary diligent step downstream of
 * anyone who holds a secret.
 *
 * DELIBERATELY the credential predicate, NOT the full screenFile() commit policy.
 * screenFile() refuses binaries (PDF, images) as unscreenable_binary and caps at
 * 10MB — correct for a text-only snapshot repo, WRONG here, where PDFs and images
 * are first-class multimodal ingest content. Applying it would break legitimate
 * ingestion, which is a reshape, not a wire. So:
 *   - .env by NAME       -> refuse (a secrets file must never be embedded)
 *   - bytes are not text  -> allow (multimodal; hasCredential cannot read the raw
 *                            bytes, and refusing every binary breaks the KB's job).
 *   - text + hasCredential -> refuse (credential_pattern_detected)
 *   - unreadable          -> refuse (a file we cannot read we cannot clear).
 *
 * 🔴 RESIDUAL — NOT the same as the auto-commit binary limit, do not read it as
 * such. This screen runs PRE-EXTRACTION, on raw bytes. The KB does not store the
 * binary opaquely the way the snapshot repo does — per the Document Tooling
 * Standard it EXTRACTS text from PDFs/images (Kreuzberg / markitdown / tesseract)
 * and embeds that text, which is then fully searchable. So a credential in a PDF's
 * text layer passes this screen (allowed as binary) and lands in the vector store
 * after extraction — the exact leak, through the one path this layer is blind to.
 * Auto-commit's limit is bounded because nobody can query inside an opaque blob;
 * this one is NOT. Closing it needs a POST-EXTRACTION screen inside the mmrag
 * pipeline (screen exactly the text that gets embedded), which is a separate change
 * from this wire. Filed as a follow-up; this wire closes the LIVE route (a
 * credential quoted into a text memory file), not the binary-extraction route.
 * Returns a block reason, or null if safe to ingest. Exported for the unit test
 * that plants a fake credential and asserts it is refused — a screen that has
 * never refused anything is indistinguishable from no screen.
 */
export function screenIngestFile(fullPath: string): string | null {
  if (fullPath.endsWith('.env') || fullPath.includes('/.env')) return 'contains_credentials';
  try {
    const buf = readFileSync(fullPath);
    if (isUnscreenableBinary(buf)) return null; // binary/multimodal — not text-screenable
    if (hasCredential(buf.toString('utf-8'))) return 'credential_pattern_detected';
  } catch {
    return 'unreadable';
  }
  return null;
}

/**
 * Expand an ingest path to the concrete files it covers. A file is itself; a
 * directory is walked recursively, because mmrag recurses into directories — so a
 * credential one level down would ride in unscreened if the screen only looked at
 * the top path. A path that does not exist expands to nothing (mmrag reports it;
 * the screen has nothing to check). .git is skipped: it is packed object storage,
 * not ingest content, and walking it is a large waste — but hidden FILES such as
 * .env are still screened, only the .git directory itself is pruned.
 */
function expandIngestFiles(p: string): string[] {
  let st;
  try {
    st = statSync(p);
  } catch {
    return [];
  }
  if (st.isFile()) return [p];
  if (st.isDirectory()) {
    const out: string[] = [];
    for (const entry of readdirSync(p, { withFileTypes: true })) {
      if (entry.isDirectory() && entry.name === '.git') continue;
      out.push(...expandIngestFiles(join(p, entry.name)));
    }
    return out;
  }
  return [];
}

/**
 * Best-effort emit of a `kb_credential_blocked` error event so a refusal is
 * countable in the activity feed and not just a stderr line nobody tails. Mirrors
 * emitQuotaSkipEvent — never throws; a screen that cannot log still refuses.
 */
function emitCredentialBlockEvent(frameworkRoot: string, meta: { collection: string; count: number; files: string[] }): void {
  try {
    const cliPath = join(frameworkRoot, 'dist', 'cli.js');
    if (!existsSync(cliPath)) return;
    execFileSync(process.execPath, [cliPath, 'bus', 'log-event', 'error', 'kb_credential_blocked', 'error', '--meta', JSON.stringify(meta)], {
      timeout: 5_000,
      stdio: 'pipe',
    });
  } catch { /* best-effort */ }
}

/**
 * Partition ingest paths into the ones safe to embed and the files refused for a
 * credential/screen reason. A path is refused as a WHOLE if any file it expands to
 * is refused, because mmrag recurses a directory as one unit — a dir with one dirty
 * file fails closed rather than ingesting its clean siblings via a path mmrag would
 * re-walk. The common case is a file path (path IS the file), so this is per-file
 * there. Exported so the wire's refusal can be proven with real files and no mocks.
 */
export function screenIngestPaths(paths: string[]): {
  cleanPaths: string[];
  refused: { file: string; reason: string }[];
} {
  const refused: { file: string; reason: string }[] = [];
  const cleanPaths: string[] = [];
  for (const p of paths) {
    const bad = expandIngestFiles(p)
      .map(f => ({ file: f, reason: screenIngestFile(f) }))
      .filter((r): r is { file: string; reason: string } => r.reason !== null);
    if (bad.length > 0) refused.push(...bad);
    else cleanPaths.push(p);
  }
  return { cleanPaths, refused };
}

export function ingestKnowledgeBase(
  paths: string[],
  options: {
    org: string;
    agent?: string;
    scope?: 'shared' | 'private';
    collection?: string;
    force?: boolean;
    frameworkRoot: string;
    instanceId: string;
  },
): void {
  const { agent, scope = 'shared', collection: collectionOverride, force, frameworkRoot, instanceId } = options;
  // Normalize once (see queryKnowledgeBase for rationale).
  const org = normalizeOrgName(frameworkRoot, options.org);

  const env = buildKBEnv(frameworkRoot, org, instanceId, agent);

  // Correctness fix: if the KB is not configured for this org, the underlying
  // python MMRAG tool exits with "Config not found. Run setup first" and
  // execFileSync (below, stdio: inherit) throws a non-zero-exit error. That
  // throw used to bubble up through the CLI action handler as an unhandled
  // exception, dumping a full Node stack trace on top of the python error
  // message — ugly and alarming for operators who were just running ingest
  // without setting up the KB first. Detect the missing-config state
  // up-front and warn-and-skip instead of letting execFileSync crash.
  if (!kbConfigured(env)) {
    console.warn(
      `[kb] Knowledge base not configured for org ${org}. Skipping ingest — ` +
      `run setup to enable (see HEARTBEAT.md step 10 for the config path).`,
    );
    return;
  }

  const pythonPath = getVenvPython(frameworkRoot);
  const mmragPath = join(frameworkRoot, 'knowledge-base', 'scripts', 'mmrag.py');

  // Determine collection name. Explicit --collection wins; otherwise derive
  // from scope (same logic as the original kb-ingest.sh shim).
  let collection: string;
  if (collectionOverride) {
    collection = collectionOverride;
  } else if (scope === 'private') {
    if (!agent) throw new Error('--agent or CTX_AGENT_NAME required for --scope private');
    collection = `agent-${agent}`;
  } else {
    collection = `shared-${org}`;
  }

  // Ensure chromadb dir exists
  const kbRoot = join(homedir(), '.cortextos', instanceId, 'orgs', org, 'knowledge-base');
  const chromaDir = join(kbRoot, 'chromadb');
  if (!existsSync(chromaDir)) {
    mkdirSync(chromaDir, { recursive: true });
  }

  console.log(`Ingesting into collection: ${collection}`);
  for (const p of paths) {
    console.log(`  Source: ${p}`);
  }

  // --- Credential screen (wired 2026-08-25, task_1787631822832) -------------
  // Refuse any file carrying a credential before it is embedded and shipped to R2.
  const { cleanPaths, refused } = screenIngestPaths(paths);

  if (refused.length > 0) {
    for (const r of refused) {
      // Named stderr line per refused file — loud, greppable, one per incident.
      process.stderr.write(`🔴 KB-INGEST REFUSED: ${r.file} — ${r.reason}\n`);
    }
    emitCredentialBlockEvent(frameworkRoot, {
      collection,
      count: refused.length,
      files: refused.map(r => r.file),
    });
  }

  // Nothing clean to ingest — refuse the whole run rather than reporting success
  // over an empty ingest (the success-badge inversion this screen exists to stop).
  if (cleanPaths.length === 0) {
    throw new Error(
      `kb-ingest refused: ${refused.length} file(s) carry a credential/screen reason and no clean file remained. See the KB-INGEST REFUSED lines above; redact and re-ingest.`,
    );
  }

  const args = [mmragPath, 'ingest', ...cleanPaths, '--collection', collection];
  if (force) args.push('--force');

  // Multimodal PDF ingestion via Gemini Flash routinely takes 2–5 min for
  // documents over ~10 pages with images/tables. Two minutes was too low and
  // produced ETIMEDOUT mid-Gemini-call. Default 10 min, override via env,
  // floored at 60s so nobody accidentally sets it to 0 or a value smaller
  // than a single Gemini call needs.
  const KB_INGEST_TIMEOUT_FLOOR_MS = 60_000;
  const KB_INGEST_TIMEOUT_DEFAULT_MS = 600_000;
  const requestedTimeout = Number(process.env.KB_INGEST_TIMEOUT_MS);
  const ingestTimeoutMs = Math.max(
    KB_INGEST_TIMEOUT_FLOOR_MS,
    Number.isFinite(requestedTimeout) && requestedTimeout > 0
      ? requestedTimeout
      : KB_INGEST_TIMEOUT_DEFAULT_MS,
  );

  // Switched from execFileSync(stdio:inherit) to spawnSync with captured
  // stdout/stderr so we can detect a Gemini-quota 429 and skip gracefully
  // instead of letting every heartbeat dump a noisy non-zero-exit stack.
  // Output is still forwarded verbatim — the only behaviour change is on
  // quota-exhausted failure.
  const result = spawnSync(pythonPath, args, {
    encoding: 'utf-8',
    timeout: ingestTimeoutMs,
    env,
  });

  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);

  if (result.status !== 0) {
    const combined = `${result.stdout || ''}\n${result.stderr || ''}`;
    if (isGeminiQuotaExhausted(combined)) {
      // Quota-exhausted is operationally expected — Gemini free-tier resets
      // daily, so the next heartbeat will likely succeed. Skip clean, emit a
      // structured event so analyst dashboards can count quota-skip rate,
      // and exit without throwing. Crucially: do NOT retry — a retry burns
      // another embed call from a quota we already know is empty.
      console.warn(
        `[kb] Gemini embedding quota exhausted — skipping ingest into ${collection}. ` +
        `Will retry on next cycle when the quota resets.`,
      );
      emitQuotaSkipEvent(frameworkRoot, { collection, scope, agent: agent || null });
      return;
    }
    // Non-quota failure — preserve the original throw semantics so the CLI
    // surfaces the error the same way it always has.
    throw new Error(`mmrag ingest exited with status ${result.status}`);
  }

  if (refused.length > 0) {
    // Clean content landed, but a partial ingest WITH refusals is not a success.
    // The throw makes the exit non-zero so a refusal can never read as a clean
    // run — the third of the three signals (non-zero exit · named stderr line ·
    // distinct error event), the same shape the auto-commit fatal path rides.
    throw new Error(
      `kb-ingest: clean content ingested into ${collection}, but REFUSED ${refused.length} credential-bearing file(s): ${refused.map(r => r.file).join(', ')}. Redact and re-ingest those.`,
    );
  }

  console.log(`\nIngest complete → collection: ${collection}`);
}

/**
 * Detect the Gemini `429 RESOURCE_EXHAUSTED` quota error in mmrag.py's
 * combined stdout+stderr. The error format is documented as:
 *
 *   ERROR: 429 RESOURCE_EXHAUSTED. {...quota details...}
 *
 * We match on BOTH `429` and `RESOURCE_EXHAUSTED` to avoid false positives
 * from a transient HTTP 429 of a different shape (unlikely, but tight).
 */
function isGeminiQuotaExhausted(output: string): boolean {
  return /\b429\b/.test(output) && /RESOURCE_EXHAUSTED/.test(output);
}

/**
 * Best-effort emit of a `kb/quota_skip` event so the heartbeat-skip rate is
 * observable in the dashboard activity feed. Never throws — quota-skip is
 * already a soft event and we should not turn it into a hard failure if the
 * event-log surface is unhappy.
 */
function emitQuotaSkipEvent(frameworkRoot: string, meta: { collection: string; scope: string; agent: string | null }): void {
  try {
    const cliPath = join(frameworkRoot, 'dist', 'cli.js');
    if (!existsSync(cliPath)) return;
    // Category MUST be one of the validate.ts VALID_CATEGORIES — kb is not in
    // that list, so an earlier "log-event kb quota_skip" silently failed (the
    // outer try/catch swallowed the validation throw). Use category=action with
    // event=kb_quota_skip so dashboards can still group by event name.
    execFileSync(process.execPath, [cliPath, 'bus', 'log-event', 'action', 'kb_quota_skip', 'warning', '--meta', JSON.stringify(meta)], {
      timeout: 5_000,
      stdio: 'pipe',
    });
  } catch { /* best-effort */ }
}

/**
 * Delete a document from the knowledge base by source path.
 *
 * Mirrors ingestKnowledgeBase's options/collection-resolution shape so the
 * CLI surface stays consistent — caller passes the same flags they would
 * for an ingest, plus the source path to remove. All chunks whose
 * `source` metadata matches the resolved absolute path are dropped.
 */
export function deleteKnowledgeBase(
  paths: string[],
  options: {
    org: string;
    agent?: string;
    scope?: 'shared' | 'private';
    collection?: string;
    frameworkRoot: string;
    instanceId: string;
  },
): void {
  const { agent, scope = 'shared', collection: collectionOverride, frameworkRoot, instanceId } = options;
  const org = normalizeOrgName(frameworkRoot, options.org);

  const env = buildKBEnv(frameworkRoot, org, instanceId, agent);

  // Same kbConfigured guard as ingest — operator-friendly fail-soft when the
  // KB hasn't been set up for this org yet.
  if (!kbConfigured(env)) {
    console.warn(
      `[kb] Knowledge base not configured for org ${org}. Skipping delete — ` +
      `run setup to enable.`,
    );
    return;
  }

  const pythonPath = getVenvPython(frameworkRoot);
  const mmragPath = join(frameworkRoot, 'knowledge-base', 'scripts', 'mmrag.py');

  let collection: string;
  if (collectionOverride) {
    collection = collectionOverride;
  } else if (scope === 'private') {
    if (!agent) throw new Error('--agent or CTX_AGENT_NAME required for --scope private');
    collection = `agent-${agent}`;
  } else {
    collection = `shared-${org}`;
  }

  if (paths.length === 0) {
    console.warn('[kb] No paths supplied to delete. Nothing to do.');
    return;
  }

  // mmrag.py delete is single-path per invocation. Loop so the bus surface
  // supports the same `<paths...>` variadic as kb-ingest.
  for (const p of paths) {
    console.log(`Deleting from collection ${collection}: ${p}`);
    const args = [mmragPath, 'delete', p, '--collection', collection];
    execFileSync(pythonPath, args, {
      encoding: 'utf-8',
      timeout: 60_000,
      env,
      stdio: 'inherit',
    });
  }
}

/**
 * Ensure the knowledge base directories exist for an org.
 *
 * `frameworkRoot` is required so the org name can be normalized to its
 * canonical filesystem casing — without that, a caller passing a drifted
 * name (e.g. "acmecorp") would create a ghost state dir identical
 * to the one this module was written to prevent.
 */
export function ensureKBDirs(instanceId: string, frameworkRoot: string, org: string): void {
  const canonicalOrg = normalizeOrgName(frameworkRoot, org);
  const kbRoot = join(homedir(), '.cortextos', instanceId, 'orgs', canonicalOrg, 'knowledge-base');
  const chromaDir = join(kbRoot, 'chromadb');
  if (!existsSync(chromaDir)) {
    mkdirSync(chromaDir, { recursive: true });
  }
}
