import { readFileSync, existsSync, writeFileSync } from 'fs';
import { join, basename } from 'path';
import { homedir } from 'os';
import type { CtxEnv } from '../types/index.js';
import { ensureDir } from './atomic.js';
import { validateAgentName, validateOrgName } from './validate.js';
import { stripBom } from './strip-bom.js';

/** Fields sourced from an org's context.json. All optional; absent → undefined. */
export interface OrgContextFields {
  timezone?: string;
  orchestrator?: string;
  userTimezone?: string;
  userTimezoneUntil?: string;
  dayModeStart?: string;
  dayModeEnd?: string;
}

/**
 * Read an org's context.json into normalized env fields. The SINGLE source of
 * this read — both resolveEnv() (CLI/bus path) and the daemon's per-agent env
 * build (agent-manager) call this, so they cannot drift. That drift is exactly
 * what shipped the user-tz arm as a silent no-op on 2026-07-14: resolveEnv read
 * user_timezone, the daemon hand-built its env and did NOT, so CTX_USER_TIMEZONE
 * injected empty. One reader, one contract, unit-tested at the seam.
 *
 * Never throws: missing file, unreadable, or malformed JSON → {} (callers then
 * fall back to their own defaults / agent tz). stripBom handles the Windows
 * UTF-8 BOM that would otherwise break JSON.parse at position 0.
 */
export function readOrgContext(projectRoot: string, org: string): OrgContextFields {
  if (!projectRoot || !org) return {};
  try {
    const contextPath = join(projectRoot, 'orgs', org, 'context.json');
    if (!existsSync(contextPath)) return {};
    const ctx = JSON.parse(stripBom(readFileSync(contextPath, 'utf-8')));
    return {
      timezone: ctx.timezone || undefined,
      orchestrator: ctx.orchestrator || undefined,
      userTimezone: ctx.user_timezone || undefined,
      userTimezoneUntil: ctx.user_timezone_until || undefined,
      dayModeStart: ctx.day_mode_start || undefined,
      dayModeEnd: ctx.day_mode_end || undefined,
    };
  } catch {
    return {};
  }
}

/**
 * Merge an org's context.json fields into a CtxEnv, filling only EMPTY fields
 * (existing values win — env vars/overrides already set upstream take precedence).
 * This is the daemon's seam: agent-manager hand-builds a base CtxEnv (instanceId,
 * ctxRoot, agentDir, org, projectRoot…) and MUST call this so user-tz/day-window
 * reach the spawned agent. Before 2026-07-15 it did not, and the user-tz arm was
 * a silent no-op. Pure + total (readOrgContext never throws) — unit-testable at
 * exactly the seam that broke.
 */
export function applyOrgContext(env: CtxEnv): CtxEnv {
  const ctx = readOrgContext(env.projectRoot, env.org);
  return {
    ...env,
    timezone: env.timezone || ctx.timezone,
    orchestrator: env.orchestrator || ctx.orchestrator,
    userTimezone: env.userTimezone || ctx.userTimezone,
    userTimezoneUntil: env.userTimezoneUntil || ctx.userTimezoneUntil,
    dayModeStart: env.dayModeStart || ctx.dayModeStart,
    dayModeEnd: env.dayModeEnd || ctx.dayModeEnd,
  };
}

/**
 * Resolve the cortextOS environment context.
 * Equivalent of bash _ctx-env.sh - reads from env vars, .cortextos-env, .env files.
 */
export function resolveEnv(overrides?: Partial<CtxEnv>): CtxEnv {
  // Priority: overrides > env vars > .cortextos-env file > defaults

  // Try reading .cortextos-env from cwd
  let envFile: Record<string, string> = {};
  const cortextosEnvPath = join(process.cwd(), '.cortextos-env');
  if (existsSync(cortextosEnvPath)) {
    envFile = parseEnvFile(cortextosEnvPath);
  }

  const instanceId =
    overrides?.instanceId ||
    process.env.CTX_INSTANCE_ID ||
    envFile.CTX_INSTANCE_ID ||
    'default';

  const ctxRoot =
    overrides?.ctxRoot ||
    process.env.CTX_ROOT ||
    envFile.CTX_ROOT ||
    join(homedir(), '.cortextos', instanceId);

  const frameworkRoot =
    overrides?.frameworkRoot ||
    process.env.CTX_FRAMEWORK_ROOT ||
    envFile.CTX_FRAMEWORK_ROOT ||
    '';

  const agentName =
    overrides?.agentName ||
    process.env.CTX_AGENT_NAME ||
    envFile.CTX_AGENT_NAME ||
    basename(process.cwd());

  const org =
    overrides?.org ||
    process.env.CTX_ORG ||
    envFile.CTX_ORG ||
    '';

  const projectRoot =
    overrides?.projectRoot ||
    process.env.CTX_PROJECT_ROOT ||
    envFile.CTX_PROJECT_ROOT ||
    '';

  // Resolve agent directory
  let agentDir =
    overrides?.agentDir ||
    process.env.CTX_AGENT_DIR ||
    envFile.CTX_AGENT_DIR ||
    '';

  if (!agentDir && org && projectRoot) {
    agentDir = join(projectRoot, 'orgs', org, 'agents', agentName);
  } else if (!agentDir && projectRoot) {
    agentDir = join(projectRoot, 'agents', agentName);
  }

  // Resolve timezone and orchestrator from org context.json.
  // userTimezone / userTimezoneUntil: the HUMAN's clock (a mutable fact — Steve on a
  // dated trip, 2026-07-14), distinct from `timezone` which is the agents' infra clock.
  // "Is the user awake?" decisions must go through resolveUserTimezone(), never read
  // CTX_TIMEZONE for that question.
  let timezone = overrides?.timezone || process.env.CTX_TIMEZONE || '';
  let orchestrator = overrides?.orchestrator || process.env.CTX_ORCHESTRATOR || '';
  let userTimezone = overrides?.userTimezone || process.env.CTX_USER_TIMEZONE || '';
  let userTimezoneUntil = overrides?.userTimezoneUntil || process.env.CTX_USER_TIMEZONE_UNTIL || '';
  let dayModeStart = overrides?.dayModeStart || process.env.CTX_DAY_MODE_START || '';
  let dayModeEnd = overrides?.dayModeEnd || process.env.CTX_DAY_MODE_END || '';

  // Fill any gaps from org context.json via the SHARED reader (readOrgContext) —
  // the same reader the daemon uses, so the two env-build paths cannot drift.
  // Precedence: overrides/env vars already set above WIN; context.json fills gaps.
  if ((!timezone || !orchestrator || !userTimezone || !dayModeStart) && org && projectRoot) {
    const ctx = readOrgContext(projectRoot, org);
    if (!timezone && ctx.timezone) timezone = ctx.timezone;
    if (!orchestrator && ctx.orchestrator) orchestrator = ctx.orchestrator;
    if (!userTimezone && ctx.userTimezone) userTimezone = ctx.userTimezone;
    if (!userTimezoneUntil && ctx.userTimezoneUntil) userTimezoneUntil = ctx.userTimezoneUntil;
    if (!dayModeStart && ctx.dayModeStart) dayModeStart = ctx.dayModeStart;
    if (!dayModeEnd && ctx.dayModeEnd) dayModeEnd = ctx.dayModeEnd;
  }

  // Security (H9): Validate agent name and org before they flow into filesystem paths.
  // These come from env vars / .cortextos-env and must match [a-z0-9_-]+.
  if (agentName) {
    try {
      validateAgentName(agentName);
    } catch (err) {
      throw new Error(`CTX_AGENT_NAME is invalid: ${(err as Error).message}`);
    }
  }
  if (org) {
    // Org names from the env may use mixed-case (e.g. AcmeCorp) when the
    // org directory was created before strict lowercase validation was enforced.
    // Only reject values that contain path-traversal characters or whitespace;
    // lowercase enforcement is a CLI-layer concern, not an env-resolution concern.
    if (/[./\\<>|;'"(){}[\] ]/.test(org) || org.includes('..')) {
      throw new Error(`CTX_ORG is invalid: contains unsafe characters`);
    }
  }

  return {
    instanceId, ctxRoot, frameworkRoot, agentName, agentDir, org, projectRoot,
    timezone, orchestrator, userTimezone, userTimezoneUntil, dayModeStart, dayModeEnd,
  };
}

/**
 * Write .cortextos-env file for backward compatibility with bash bus scripts.
 * Per D6: maintain this pattern.
 */
export function writeCortextosEnv(agentDir: string, env: CtxEnv): void {
  ensureDir(agentDir);
  const content = [
    `CTX_INSTANCE_ID=${env.instanceId}`,
    `CTX_ROOT=${env.ctxRoot}`,
    `CTX_FRAMEWORK_ROOT=${env.frameworkRoot}`,
    `CTX_AGENT_NAME=${env.agentName}`,
    `CTX_ORG=${env.org}`,
    `CTX_AGENT_DIR=${env.agentDir}`,
    `CTX_PROJECT_ROOT=${env.projectRoot}`,
  ].join('\n');

  writeFileSync(join(agentDir, '.cortextos-env'), content + '\n', 'utf-8');
}

/**
 * Parse a KEY=VALUE env file. Supports:
 *   - `#` comments at start of line
 *   - Surrounding single or double quotes on the value (stripped)
 *   - Inline ` #` comments on unquoted values
 * Lines with no `=` are skipped.
 */
export function parseEnvFile(filePath: string): Record<string, string> {
  const result: Record<string, string> = {};
  try {
    // stripBom + CRLF-aware split: Windows tooling (PowerShell Out-File,
    // Notepad) writes .env files with a UTF-8 BOM at position 0 AND CRLF
    // line endings. Without stripBom the first KEY line never matches
    // because position 0 is the BOM byte; without the regex split, each
    // value gets a trailing \r that breaks downstream validators.
    const content = stripBom(readFileSync(filePath, 'utf-8'));
    for (const line of content.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eqIdx = trimmed.indexOf('=');
      if (eqIdx <= 0) continue; // no '=' or empty key

      const key = trimmed.slice(0, eqIdx).trim();
      let value = trimmed.slice(eqIdx + 1).trim();

      if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
        value = value.slice(1, -1);
      } else if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) {
        value = value.slice(1, -1);
      } else {
        // Unquoted: strip inline comments starting with ' #'
        const hashIdx = value.indexOf(' #');
        if (hashIdx >= 0) {
          value = value.slice(0, hashIdx).trim();
        }
      }

      result[key] = value;
    }
  } catch {
    // Ignore read errors
  }
  return result;
}

/**
 * Source a .env file into process.env (for agent environment).
 */
export function sourceEnvFile(filePath: string): void {
  if (!existsSync(filePath)) return;
  const vars = parseEnvFile(filePath);
  for (const [key, value] of Object.entries(vars)) {
    if (!process.env[key]) {
      process.env[key] = value;
    }
  }
}
