import { existsSync, readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import type { Approval, ApprovalCategory, ApprovalStatus, BusPaths } from '../types/index.js';
import { atomicWriteSync, ensureDir } from '../utils/atomic.js';
import { parseEnvFile, readOrgContext } from '../utils/env.js';
import { randomString } from '../utils/random.js';
import { validateApprovalCategory } from '../utils/validate.js';
import { TelegramAPI } from '../telegram/api.js';
import { detectDayNightMode, resolveUserTimezone } from './heartbeat.js';
import { sendMessage } from './message.js';
import { postActivity } from './system.js';

/**
 * Build the inline keyboard posted to the activity channel alongside a
 * newly-created approval. Two buttons (Approve / Deny) with callback_data
 * keyed on the approval id so fast-checker's activity-channel callback
 * handler can route them to updateApproval.
 */
function buildApprovalKeyboard(approvalId: string): object {
  return {
    inline_keyboard: [[
      { text: '✅ Approve', callback_data: `appr_allow_${approvalId}` },
      { text: '❌ Deny', callback_data: `appr_deny_${approvalId}` },
    ]],
  };
}

/**
 * Post a newly-created approval to the org's activity channel with
 * Approve/Deny inline buttons. Returns a promise that resolves once the
 * post attempt has settled.
 *
 * Path resolution: activity-channel.env lives under the FRAMEWORK root
 * (frameworkRoot/orgs/<org>/activity-channel.env), NOT the runtime state
 * dir (ctxRoot/orgs/<org>/). The earlier version of this helper used
 * paths.ctxRoot to derive orgDir, which silently resolved to the wrong
 * filesystem root and caused every activity-channel post to fail as
 * "not configured" — a bug that hid for hours because of the silent
 * .catch below. Fallback chain is now: explicit frameworkRoot arg →
 * process.env.CTX_FRAMEWORK_ROOT → SKIP WITH WARN (no further fallback;
 * the paths.ctxRoot fallback that caused the original bug was removed
 * deliberately per post-incident review — silently using a known-wrong
 * path is worse than skipping loudly).
 *
 * Errors from postActivity (thrown rejections) are suppressed so
 * activity-channel unreachability does not block approval creation. The
 * "not configured" signal (postActivity returns false) is now logged as
 * a visible warn — preserves the best-effort behavior but surfaces
 * misconfiguration immediately instead of debugging it silently.
 *
 * The returned promise MUST be awaited by the caller in short-lived
 * contexts (CLI action handlers) or the process may exit before the
 * underlying fetch completes and the post silently never sends.
 */
function postApprovalToActivityChannel(
  paths: BusPaths,
  org: string,
  approvalId: string,
  title: string,
  category: ApprovalCategory,
  agentName: string,
  context: string | undefined,
  frameworkRoot: string | undefined,
): Promise<void> {
  const root = frameworkRoot ?? process.env.CTX_FRAMEWORK_ROOT;
  if (!root) {
    console.warn(
      `[approval] No frameworkRoot available for ${approvalId} — skipping activity-channel post. ` +
      `Set CTX_FRAMEWORK_ROOT env var or pass frameworkRoot explicitly.`,
    );
    return Promise.resolve();
  }

  const orgDir = join(root, 'orgs', org);
  const lines = [
    `🔔 Approval request: ${title}`,
    `Category: ${category}`,
    `Requested by: ${agentName}`,
  ];
  if (context) {
    lines.push('', context);
  }
  lines.push('', `id: ${approvalId}`);
  const message = lines.join('\n');

  return postActivity(orgDir, paths.ctxRoot, org, message, buildApprovalKeyboard(approvalId))
    .then((posted) => {
      if (!posted) {
        // postActivity returns false when activity-channel.env is missing
        // or cannot be parsed. Surface this visibly — the silent-false
        // pattern is what hid tonight's path-resolution bug for hours.
        console.warn(
          `[approval] Activity-channel post failed for ${approvalId} — ` +
          `check ${orgDir}/activity-channel.env (must define ACTIVITY_BOT_TOKEN + ACTIVITY_CHAT_ID).`,
        );
      }
    })
    .catch(() => undefined); // Thrown rejections still suppressed — activity-channel unreachable must not fail approval creation.
}

// ---------------------------------------------------------------------------
// NIGHT-GATE for the approval ping (task_1785376444454)
//
// pingAgentChatId Telegram-messaged the operator's 1:1 bot the instant an
// approval was created — with NO contact-clock check, so an approval raised at
// 03:00 the USER's time woke them. This gates the PING, never the approval: the
// record is always persisted to pending/ and stays visible on the dashboard.
// At night the ping is DEFERRED — a marker (metadata.ping_deferred) is stamped
// on the approval so resurfaceDeferredApprovalPings can re-send it at day-start
// — it is never DISCARDED.
//
// Fail CLOSED: if the contact clock cannot be resolved we treat it as NIGHT and
// defer. A ping recoverable at day-start (with the approval already visible) is
// strictly better than a 03:00 wake.
//
// KNOWN-POSITIVE: a gate never observed to DELIVER is indistinguishable from a
// broken ping. evaluateApprovalPingGate('day') returns deliver:true, and the
// resurface path is exercised end-to-end with an injectable sender — proving
// the guard can say YES before it is trusted to say NO.
//
// COUPLING: postApprovalToActivityChannel has the SAME missing gate. It is
// inert today ONLY because the activity-channel bot token is dead (posts fail
// as "not configured") so it cannot wake anyone. If that token is ever
// restored, the identical gate MUST be applied there — flagged so the coupling
// is not lost.
// ---------------------------------------------------------------------------

export type ContactClockMode = 'day' | 'night';

export interface ApprovalPingGate {
  /** Send the ping now. */
  deliver: boolean;
  /** Record a deferral marker and resurface at day-start (mutually exclusive with deliver). */
  defer: boolean;
  reason: string;
}

/** Pure gate: DAY delivers now; NIGHT (or an unknown clock, resolved to night) defers. */
export function evaluateApprovalPingGate(mode: ContactClockMode): ApprovalPingGate {
  if (mode === 'day') {
    return { deliver: true, defer: false, reason: 'contact-clock DAY — delivering approval ping now' };
  }
  return {
    deliver: false,
    defer: true,
    reason: 'contact-clock NIGHT — approval ping deferred to day-start (record persisted, not discarded)',
  };
}

/**
 * Resolve the human contact clock for an org. Answers "is the USER awake?" in
 * the USER's timezone (resolveUserTimezone honours a dated override), NEVER the
 * agents' infra clock. Fails CLOSED to 'night' on any error — the contact clock
 * must never wake the user on an unknown clock.
 */
export function resolveContactClockMode(
  org: string,
  projectRoot: string | undefined,
): ContactClockMode {
  try {
    const ctx = projectRoot ? readOrgContext(projectRoot, org) : {};
    const fallback = ctx.timezone || process.env.CTX_TIMEZONE || 'UTC';
    const resolved = resolveUserTimezone(fallback, {
      userTimezone: ctx.userTimezone || process.env.CTX_USER_TIMEZONE || undefined,
      userTimezoneUntil: ctx.userTimezoneUntil || process.env.CTX_USER_TIMEZONE_UNTIL || undefined,
    });
    return detectDayNightMode(resolved.timezone, {
      start: ctx.dayModeStart || process.env.CTX_DAY_MODE_START || undefined,
      end: ctx.dayModeEnd || process.env.CTX_DAY_MODE_END || undefined,
    });
  } catch {
    return 'night';
  }
}

/** Injectable Telegram sender — real by default; a fake in tests keeps the gate off the network. */
export type ApprovalPingSender = (botToken: string, chatId: string, message: string) => Promise<void>;

const defaultApprovalPingSender: ApprovalPingSender = (botToken, chatId, message) =>
  new TelegramAPI(botToken).sendMessage(chatId, message, undefined, { parseMode: null }).then(() => undefined);

function buildApprovalPingMessage(
  title: string,
  category: ApprovalCategory,
  agentName: string,
  context: string | undefined,
  approvalId: string,
): string {
  const lines = [
    `🔔 Approval needed: ${title}`,
    `Category: ${category}`,
    `Requested by: ${agentName}`,
  ];
  if (context) {
    lines.push('', context);
  }
  lines.push('', `id: ${approvalId}`);
  lines.push('', 'Approve via the orchestrator chat (Approve/Deny buttons) or the dashboard.');
  return lines.join('\n');
}

/**
 * Best-effort: ping the requesting agent's own Telegram chat (the operator's
 * 1:1 conversation with the agent's bot) when a new approval is created.
 * The activity-channel post handles "Approve / Deny" inline routing for the
 * operator-via-orchestrator UX, but operators on a per-agent bot would
 * otherwise miss approvals entirely — that's the source of the observed
 * 50h+ Repo-B-style stalls. This pings them on the bot they're actually
 * watching so they can hop to the orchestrator chat or dashboard to act.
 *
 * Reads BOT_TOKEN + CHAT_ID from `<agentDir>/.env`. Skips silently with a
 * single warn line when either is missing — approvals from a bot-less
 * agent (e.g. a hermes runtime, or pre-onboarding) must still succeed.
 *
 * The clock gate lives in the CALLER (createApproval / resurfaceDeferredApprovalPings):
 * this function unconditionally sends when invoked, so both the live-deliver and
 * the resurface path share one send implementation and one injectable sender.
 *
 * Errors from the network round-trip are suppressed: a Telegram outage
 * must not block approval creation.
 */
/**
 * FAIL-CLOSED gate: is this agent's operator 1:1 chat an INTENDED recipient of
 * approval pings? Reads config.json `approval_rules.notify_operator_chat`.
 *
 * Default — absent flag, false, missing/unreadable/malformed config, or no
 * agentDir — is FALSE (do NOT ping). This converts the UNMEASURED case into the
 * SAFE one: an agent nobody has decided about does not direct-ping a human who
 * may not want approval notifications (e.g. a 1:1 bot whose operator has not
 * onboarded), and does not bypass orchestrator routing for a specialist whose
 * CHAT_ID resolves to the user's own chat. An intended recipient must be
 * explicitly opted in. Enforced at the single ping choke point so the day path
 * and the night-resurface path are both covered without any caller remembering.
 */
export function isIntendedApprovalRecipient(agentDir: string | undefined): boolean {
  if (!agentDir) return false;
  try {
    const cfgPath = join(agentDir, 'config.json');
    if (!existsSync(cfgPath)) return false;
    const cfg = JSON.parse(readFileSync(cfgPath, 'utf-8')) as {
      approval_rules?: { notify_operator_chat?: boolean };
    };
    return cfg.approval_rules?.notify_operator_chat === true;
  } catch {
    return false; // unreadable/malformed config -> fail closed (do not ping)
  }
}

function pingAgentChatId(
  agentDir: string | undefined,
  approvalId: string,
  title: string,
  category: ApprovalCategory,
  agentName: string,
  context: string | undefined,
  send: ApprovalPingSender = defaultApprovalPingSender,
): Promise<void> {
  if (!agentDir) {
    console.warn(
      `[approval] No agentDir available for ${approvalId} — skipping agent-bot Telegram ping.`,
    );
    return Promise.resolve();
  }
  const envPath = join(agentDir, '.env');
  if (!existsSync(envPath)) {
    return Promise.resolve();
  }
  const env = parseEnvFile(envPath);
  const botToken = env.BOT_TOKEN;
  const chatId = env.CHAT_ID;
  if (!botToken || !chatId) {
    console.warn(
      `[approval] BOT_TOKEN or CHAT_ID missing in ${envPath} — skipping agent-bot Telegram ping for ${approvalId}.`,
    );
    return Promise.resolve();
  }

  // INTENDED-RECIPIENT gate (fail-closed). Placed LAST — after the No-agentDir /
  // missing-.env / missing-token checks — so those keep firing as before and
  // only this policy gate is new. Both the day-ping call site and the
  // night-resurface call site route through this one function, so gating here
  // (not per-caller) covers both. An agent whose operator chat is not a
  // configured approval recipient is never pinged, even in day mode: this is
  // the code guard that enforces "specialists route approvals via the
  // orchestrator" and lets a per-agent prose rule retire.
  if (!isIntendedApprovalRecipient(agentDir)) {
    console.warn(
      `[approval] ${agentName}'s operator chat is not a configured approval recipient ` +
        `(config.approval_rules.notify_operator_chat !== true) — skipping agent-bot ping for ${approvalId}.`,
    );
    return Promise.resolve();
  }

  const message = buildApprovalPingMessage(title, category, agentName, context, approvalId);
  return send(botToken, chatId, message)
    .then(() => undefined)
    .catch(() => undefined); // Telegram outage must not fail approval creation.
}

/**
 * Day-start resurfacing of pings deferred overnight (task_1785376444454). Scans
 * pending approvals for the metadata.ping_deferred marker; for each, if the
 * requesting org's contact clock is now DAY, re-sends the agent-bot ping and
 * clears the marker. Still-night approvals are left deferred (never discarded).
 *
 * This is the DEFER-not-discard other half of the night gate. The robust
 * trigger is a day-start cron invoking it; createApproval also flushes the
 * backlog opportunistically on any daytime approval so the primitive is wired,
 * not dangling.
 *
 * `mode` is injectable for tests; in production it is resolved per-approval from
 * that approval's own org (approvals from different orgs may be on different
 * clocks). `send` is injectable for the same reason as pingAgentChatId.
 * Never throws — resurfacing must not break the caller.
 */
export async function resurfaceDeferredApprovalPings(
  paths: BusPaths,
  opts: { projectRoot?: string; mode?: ContactClockMode; send?: ApprovalPingSender } = {},
): Promise<{ resurfaced: number; stillDeferred: number }> {
  const send = opts.send ?? defaultApprovalPingSender;
  const pendingDir = join(paths.approvalDir, 'pending');
  let files: string[];
  try {
    files = readdirSync(pendingDir).filter(f => f.endsWith('.json'));
  } catch {
    return { resurfaced: 0, stillDeferred: 0 };
  }

  let resurfaced = 0;
  let stillDeferred = 0;
  for (const file of files) {
    const filePath = join(pendingDir, file);
    let approval: Approval;
    try {
      approval = JSON.parse(readFileSync(filePath, 'utf-8'));
    } catch {
      continue; // skip corrupt
    }
    if (!approval.metadata || approval.metadata.ping_deferred === undefined) continue;

    const mode = opts.mode ?? resolveContactClockMode(approval.org, opts.projectRoot);
    if (mode !== 'day') {
      stillDeferred++;
      continue; // still night — keep the deferral, do not discard
    }

    const agentDir = opts.projectRoot && approval.org && approval.requesting_agent
      ? join(opts.projectRoot, 'orgs', approval.org, 'agents', approval.requesting_agent)
      : undefined;
    await pingAgentChatId(
      agentDir,
      approval.id,
      approval.title,
      approval.category,
      approval.requesting_agent,
      approval.description || undefined,
      send,
    );

    // Clear the marker so the ping resurfaces exactly once.
    const md: Record<string, unknown> = { ...approval.metadata };
    delete md.ping_deferred;
    const rewritten: Approval = { ...approval };
    if (Object.keys(md).length > 0) {
      rewritten.metadata = md;
    } else {
      delete rewritten.metadata;
    }
    atomicWriteSync(filePath, JSON.stringify(rewritten));
    resurfaced++;
  }
  return { resurfaced, stillDeferred };
}

/**
 * Create an approval request.
 * Identical to bash create-approval.sh format.
 *
 * Returns a Promise that resolves to the approval id AFTER the
 * activity-channel fan-out has settled. Callers in short-lived contexts
 * (CLI action handlers) MUST await — otherwise the process may exit before
 * the Telegram post completes and the post silently never sends.
 *
 * `frameworkRoot` (optional) is the filesystem root where
 * orgs/<org>/activity-channel.env lives. Without it the activity-channel
 * post is skipped with a warn — see postApprovalToActivityChannel for the
 * fallback chain (explicit arg → CTX_FRAMEWORK_ROOT env → skip). CLI call
 * sites should pass env.frameworkRoot explicitly; daemon-side callers
 * may rely on the env var.
 */
export async function createApproval(
  paths: BusPaths,
  agentName: string,
  org: string,
  title: string,
  category: ApprovalCategory,
  context?: string,
  frameworkRoot?: string,
  agentDir?: string,
  metadata?: Record<string, unknown>,
): Promise<string> {
  validateApprovalCategory(category);

  const epoch = Math.floor(Date.now() / 1000);
  const rand = randomString(5);
  const approvalId = `approval_${epoch}_${rand}`;
  const now = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');

  // NIGHT-GATE (task_1785376444454): decide the agent-bot ping BEFORE persisting
  // so the deferral marker is written atomically with the record (no re-write).
  // The approval itself is ALWAYS persisted — only the ping is clock-gated.
  const clockMode = resolveContactClockMode(org, frameworkRoot);
  const pingGate = evaluateApprovalPingGate(clockMode);
  // Whether this agent's operator chat is an intended approval recipient. Used
  // to skip the defer marker for non-recipients (below): a ping_deferred marker
  // for a ping the recipient gate will never deliver is a false state that would
  // outlive the approval and mislead the resurface path. The day-ping itself is
  // gated independently inside pingAgentChatId (the choke point).
  const isRecipient = isIntendedApprovalRecipient(agentDir);

  const approval: Approval = {
    id: approvalId,
    title,
    requesting_agent: agentName,
    org,
    category,
    status: 'pending',
    description: context || '',
    created_at: now,
    updated_at: now,
    resolved_at: null,
    resolved_by: null,
    ...(metadata ? { metadata } : {}),
  };
  if (pingGate.defer && isRecipient) {
    approval.metadata = {
      ...(approval.metadata || {}),
      ping_deferred: { since: now, reason: pingGate.reason },
    };
  }

  const pendingDir = join(paths.approvalDir, 'pending');
  ensureDir(pendingDir);
  atomicWriteSync(join(pendingDir, `${approvalId}.json`), JSON.stringify(approval));

  // Fan-out to the activity channel so the operator can approve/deny from
  // Telegram without opening the dashboard. AWAITED so short-lived CLI callers do
  // not exit before the Telegram post fetch completes. Errors are
  // suppressed inside postApprovalToActivityChannel — activity-channel
  // unreachable must not block approval creation. Callbacks route back
  // via the orchestrator's activity-channel poller (see
  // daemon/agent-manager.ts).
  //
  // NOTE: this post shares the night-gate COUPLING documented above — it is
  // sent unconditionally here only because the activity-channel bot token is
  // currently dead. Gate it too if that token is restored.
  await postApprovalToActivityChannel(paths, org, approvalId, title, category, agentName, context, frameworkRoot);

  // Best-effort ping to the requesting agent's own Telegram bot (the
  // operator's 1:1 conversation with the agent). Closes the gap where
  // operators not in the activity channel would miss approvals entirely
  // (the 50h+ Repo-B-style stall). Errors suppressed — see helper.
  // Clock-gated: DAY delivers now; NIGHT defers (marker written above) and the
  // ping resurfaces at day-start.
  if (pingGate.deliver) {
    await pingAgentChatId(agentDir, approvalId, title, category, agentName, context);
  } else if (isRecipient) {
    console.warn(
      `[approval] ${pingGate.reason} — ${approvalId} persisted to pending; agent-bot ping held for day-start.`,
    );
  } else {
    console.warn(
      `[approval] contact-clock NIGHT and ${agentName}'s operator chat is not a configured approval recipient — ` +
        `${approvalId} persisted to pending; no agent-bot ping, no deferral.`,
    );
  }

  // Opportunistic day-start flush: any daytime approval activity resurfaces the
  // overnight backlog. The robust trigger is a dedicated day-start cron calling
  // resurfaceDeferredApprovalPings (daylight wiring follow-up). Never blocks
  // creation.
  if (clockMode === 'day') {
    try {
      // No forced mode: resurface re-resolves each approval's OWN org clock, so
      // a night-clock org's backlog is not flushed by a day-clock org's activity.
      await resurfaceDeferredApprovalPings(paths, { projectRoot: frameworkRoot });
    } catch {
      /* resurfacing must not fail approval creation */
    }
  }

  return approvalId;
}

/**
 * Update an approval's status (approve or deny).
 * Notifies the requesting agent via inbox message.
 */
export function updateApproval(
  paths: BusPaths,
  approvalId: string,
  status: ApprovalStatus,
  note?: string,
): void {
  const pendingDir = join(paths.approvalDir, 'pending');
  const filePath = join(pendingDir, `${approvalId}.json`);

  try {
    const content = readFileSync(filePath, 'utf-8');
    const approval: Approval = JSON.parse(content);
    approval.status = status;
    approval.updated_at = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
    approval.resolved_at = approval.updated_at;
    approval.resolved_by = note || null;

    // Move to resolved/ directory (matches bash version)
    const destDir = join(paths.approvalDir, 'resolved');
    ensureDir(destDir);
    atomicWriteSync(join(destDir, `${approvalId}.json`), JSON.stringify(approval));

    // Remove from pending
    const { unlinkSync } = require('fs');
    unlinkSync(filePath);

    // Notify requesting agent via inbox
    if (approval.requesting_agent) {
      const noteText = note ? ` Note: ${note}` : '';
      const msg = `Approval decision: ${status.toUpperCase()}\napproval_id: ${approvalId}\ndecision: ${status}${noteText}`;
      sendMessage(paths, 'system', approval.requesting_agent, 'urgent', msg);
    }
  } catch (err) {
    throw new Error(`Approval ${approvalId} not found: ${err}`);
  }
}

/**
 * List pending approvals.
 */
export function listPendingApprovals(paths: BusPaths): Approval[] {
  const pendingDir = join(paths.approvalDir, 'pending');
  let files: string[];
  try {
    files = readdirSync(pendingDir).filter(f => f.endsWith('.json'));
  } catch {
    return [];
  }

  const approvals: Approval[] = [];
  for (const file of files) {
    try {
      const content = readFileSync(join(pendingDir, file), 'utf-8');
      approvals.push(JSON.parse(content));
    } catch {
      // Skip corrupt
    }
  }

  return approvals.sort(
    (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime(),
  );
}
