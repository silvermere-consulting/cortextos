import { execFileSync } from 'child_process';

/**
 * Boot-time Claude Code pin guard.
 *
 * Context (task_1785377221211): the fleet's claude binary is pinned in
 * ecosystem.config.js. Until 2026-07-30 the pin was `process.env.CTX_CLAUDE_BIN
 * || <default>`, so an inherited env var beat it — a pm2 resurrect from a stale
 * dump.pm2 silently reverted all 8 agents from the authorised 2.1.219 to 2.1.141
 * (a binary with no registry entry for opus-4-8 / sonnet-5 / opus-5), undetected
 * for hours because the only way to read the running version was /proc archaeology.
 *
 * The precedence fix (ecosystem pin is now authoritative) prevents that revert.
 * This module is the KNOWN-POSITIVE beside the guard: it logs the resolved binary
 * and its actual --version at every daemon boot, so "which version are agents on"
 * is answerable from the log, and it flags a mismatch loudly instead of degrading
 * silently. It never throws and never exits — a running fleet on the wrong version
 * is strictly better than a dead fleet, and the loud page ensures a human sees it.
 */

/**
 * The authorised Claude Code version — the REFERENCE the guard compares against.
 *
 * HARDCODED on purpose, never read from env. The guard exists to detect a
 * compromised / stale environment, so the expectation it measures against must
 * not come from that same environment: if it did, an inherited state could
 * satisfy the guard by supplying BOTH a wrong binary (CTX_CLAUDE_BIN) AND a
 * matching wrong expectation (CTX_CLAUDE_VERSION_EXPECTED) — the `||` precedence
 * defect run backwards, and a guard keyed on something its adversary can write
 * is not a guard. The OBSERVATION (resolvedBin, actualVersion) still reads env,
 * because that IS the fact under test; only the REFERENCE must be independent.
 *
 * MUST equal CLAUDE_VERSION in ecosystem.config.js. Rolling the pin means
 * editing BOTH files — a deliberate two-place cost that buys an independent
 * cross-check: divergence pages instead of silently trusting env.
 */
export const AUTHORISED_CLAUDE_VERSION = '2.1.219';

export interface PinCheck {
  resolvedBin: string;
  actualVersion: string | null;
  expectedVersion: string | null;
  ok: boolean;
  reason: string;
}

/**
 * Pure decision. Given the resolved binary path, the version actually read from
 * it, and the expected version, classify the boot state. Never throws.
 *
 * - actualVersion null  -> not ok (could not read the binary at all)
 * - expectedVersion null -> ok, but only observability (no pin to assert against)
 * - actual !== expected  -> not ok (the revert condition)
 * - actual === expected  -> ok (the known-positive)
 */
export function evaluateClaudePin(
  resolvedBin: string,
  actualVersion: string | null,
  expectedVersion: string | null,
): PinCheck {
  if (!actualVersion) {
    return {
      resolvedBin, actualVersion, expectedVersion, ok: false,
      reason: `could not read --version from resolved claude binary "${resolvedBin}"`,
    };
  }
  if (!expectedVersion) {
    return {
      resolvedBin, actualVersion, expectedVersion, ok: true,
      reason: `claude binary "${resolvedBin}" version ${actualVersion} (no CTX_CLAUDE_VERSION_EXPECTED pinned)`,
    };
  }
  if (actualVersion !== expectedVersion) {
    return {
      resolvedBin, actualVersion, expectedVersion, ok: false,
      reason: `PIN MISMATCH: resolved "${resolvedBin}" is ${actualVersion}, authorised ${expectedVersion} — `
        + `fleet may be running a binary with no registry entry for its --model (task_1785377221211)`,
    };
  }
  return {
    resolvedBin, actualVersion, expectedVersion, ok: true,
    reason: `claude binary "${resolvedBin}" version ${actualVersion} == authorised ${expectedVersion}`,
  };
}

/** Extract the bare `major.minor.patch` token from `claude --version` output. */
export function parseClaudeVersion(raw: string): string | null {
  const m = raw.trim().match(/\b(\d+\.\d+\.\d+)\b/);
  return m ? m[1] : null;
}

/**
 * Read `<bin> --version` and return the bare version token, or null on any
 * failure (missing binary, non-zero exit, timeout, unparseable output). The
 * runner is injectable so the decision can be tested without spawning a process.
 */
export function readClaudeVersion(
  bin: string,
  runner: (bin: string) => string = defaultVersionRunner,
): string | null {
  try {
    return parseClaudeVersion(runner(bin));
  } catch {
    return null;
  }
}

function defaultVersionRunner(bin: string): string {
  return execFileSync(bin, ['--version'], { encoding: 'utf-8', timeout: 5000 });
}

/**
 * Resolve the binary UNDER TEST from the daemon env, read its actual version,
 * and classify against the hardcoded {@link AUTHORISED_CLAUDE_VERSION}.
 *
 * The expectation is deliberately NOT taken from env (see AUTHORISED_CLAUDE_VERSION):
 * `resolvedBin` is the observation, so it reads env; the version it's checked
 * against is the fixed reference, so it does not. This also means the guard is
 * always ARMED — there is no "expectation unset" state that a missing env var
 * could use to disarm it into observability-only.
 */
export function checkClaudePinFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  runner?: (bin: string) => string,
): PinCheck {
  const resolvedBin = env.CTX_CLAUDE_BIN || 'claude';
  const actualVersion = readClaudeVersion(resolvedBin, runner);
  return evaluateClaudePin(resolvedBin, actualVersion, AUTHORISED_CLAUDE_VERSION);
}
