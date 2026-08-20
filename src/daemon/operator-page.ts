/**
 * operator-page.ts — the daemon's last-resort alert channel: a direct
 * Telegram page to the operator with NO Claude turn anywhere in the path.
 *
 * WHY THIS IS A MODULE (2026-07-21, the 8h fleet outage): every other alert
 * path in the system terminates in a Claude turn — rung-3 escalations go to
 * the orchestrator's session, fleet-health runs inside agent sessions, the
 * activity channel is posted by agents. A common-mode failure (the shared
 * OAuth credential expiring) disabled every Claude turn at once, so the
 * system could not report its own most likely total failure. This primitive
 * uses only a bot token + curl: Telegram auth is independent of Anthropic
 * auth, and the daemon survived the whole outage.
 *
 * It is deliberately a GENERAL capability ("the daemon can always reach
 * Steven"), not a rung-3 special case — the same day this was built, a
 * second dead notification path surfaced (activity-channel.env missing for
 * every org, broadcasts silently failing since forever). Callers today:
 * rung-3 escalation (subject-is-orchestrator / no-orchestrator), the
 * watchdog common-mode arm, and the daemon crash-loop alert. Credential
 * refresh-failure and expiry-warning legs join with F1/F2.
 */

import { existsSync, readFileSync, readdirSync } from 'fs';
import { spawnSync } from 'child_process';
import { join } from 'path';

export const PAGE_SEND_TIMEOUT_MS = 3000; // bounded — callers may be crashing

export interface OperatorChatCreds {
  chatId: string;
  botToken: string;
  /**
   * How the creds were resolved. 'env' = explicit CTX_OPERATOR_* config —
   * the operator chat someone actually CHOSE. 'fallback' = first agent .env
   * found on disk — reachable, but nobody chose it, and today it resolves to
   * the wrong human (2026-07-21: pages routed to a non-operator chat; the
   * defect had been ticketed for 11 days as the crash-loop mis-routing).
   */
  source: 'env' | 'fallback';
}

/**
 * Resolve where an operator page goes.
 * Priority 1: explicit CTX_OPERATOR_CHAT_ID + CTX_OPERATOR_BOT_TOKEN env.
 * Priority 2: the first agent .env that defines BOT_TOKEN + CHAT_ID — good
 * enough for small single-operator installs; the alert still lands SOMEWHERE
 * a human reads.
 */
export function getOperatorChatCreds(frameworkRoot: string): OperatorChatCreds | null {
  const envChat = process.env.CTX_OPERATOR_CHAT_ID;
  const envToken = process.env.CTX_OPERATOR_BOT_TOKEN;
  if (envChat && envToken && /^\d+:[A-Za-z0-9_-]+$/.test(envToken)) {
    return { chatId: envChat, botToken: envToken, source: 'env' };
  }
  try {
    const orgsRoot = join(frameworkRoot, 'orgs');
    if (!existsSync(orgsRoot)) return null;
    const orgs = readdirSync(orgsRoot, { withFileTypes: true }).filter(d => d.isDirectory());
    for (const org of orgs) {
      const agentsRoot = join(orgsRoot, org.name, 'agents');
      if (!existsSync(agentsRoot)) continue;
      const agents = readdirSync(agentsRoot, { withFileTypes: true }).filter(d => d.isDirectory());
      for (const a of agents) {
        const envFile = join(agentsRoot, a.name, '.env');
        if (!existsSync(envFile)) continue;
        try {
          const content = readFileSync(envFile, 'utf-8');
          const tokenMatch = content.match(/^BOT_TOKEN=(.+)$/m);
          const chatMatch = content.match(/^CHAT_ID=(.+)$/m);
          if (!tokenMatch || !chatMatch) continue;
          const botToken = tokenMatch[1].trim();
          const chatId = envChat || chatMatch[1].trim();
          if (/^\d+:[A-Za-z0-9_-]+$/.test(botToken)) {
            return { chatId, botToken, source: 'fallback' };
          }
        } catch { /* skip this agent */ }
      }
    }
  } catch { /* fall through */ }
  return null;
}

/** Transport result: delivered is Telegram's own verdict, not curl's. */
export interface PageTransportResult {
  delivered: boolean;
  detail: string;
}

export type PageTransport = (creds: OperatorChatCreds, text: string) => PageTransportResult;

/**
 * Default transport: curl POST to the Bot API.
 *
 * DELIVERY IS JUDGED BY TELEGRAM'S RESPONSE BODY ({"ok":true}), NOT curl's
 * exit code. curl -s exits 0 on HTTP 4xx, so the previous exit-code check
 * reported "sent" forever on a bad chat_id or revoked bot token — a
 * check-that-cannot-fail in the one alarm that must never be one.
 */
export const curlPageTransport: PageTransport = (creds, text) => {
  const r = spawnSync('curl', [
    '-s', '--max-time', '3',
    '-X', 'POST',
    `https://api.telegram.org/bot${creds.botToken}/sendMessage`,
    '-d', `chat_id=${creds.chatId}`,
    '--data-urlencode', `text=${text}`,
  ], { timeout: PAGE_SEND_TIMEOUT_MS, stdio: 'pipe' });
  if (r.status !== 0) {
    return { delivered: false, detail: `curl exit ${r.status ?? 'null'}` };
  }
  const body = (r.stdout ?? Buffer.from('')).toString('utf-8');
  if (/"ok"\s*:\s*true/.test(body)) {
    // Persist the RE-CHECKABLE evidence, not just the verdict. The first
    // live delivery proof (2026-07-21 08:32Z) discarded the body; when the
    // recipient then said "no message arrived", the proof rested on a
    // regex reading nobody could re-run. message_id + date make a delivery
    // claim auditable after the fact: a message that Telegram assigned an
    // id and a timestamp is IN the chat history, findable by a human
    // scrolling to that moment.
    let evidence = '';
    try {
      const parsed = JSON.parse(body) as { result?: { message_id?: number; date?: number; chat?: { id?: number } } };
      const m = parsed.result;
      if (m?.message_id !== undefined) {
        const when = m.date !== undefined ? new Date(m.date * 1000).toISOString() : 'unknown-time';
        evidence = ` message_id=${m.message_id} chat=${m.chat?.id ?? creds.chatId} at=${when}`;
      }
    } catch { /* evidence is best-effort; the verdict stands on the regex */ }
    return { delivered: true, detail: `telegram ok:true${evidence}` };
  }
  return { delivered: false, detail: `telegram refused: ${body.slice(0, 200)}` };
};

/** Result of the boot-time operator-chat self-test. */
export interface OperatorChatValidation {
  ok: boolean;
  /** Which probe failed first, or 'none'. */
  failed: 'no-creds' | 'not-explicit' | 'getMe' | 'getChat' | 'none';
  detail: string;
}

export type ValidationTransport = (url: string) => { status: number | null; body: string };

const curlValidationTransport: ValidationTransport = (url) => {
  const r = spawnSync('curl', ['-s', '--max-time', '3', url],
    { timeout: PAGE_SEND_TIMEOUT_MS, stdio: 'pipe' });
  return { status: r.status, body: (r.stdout ?? Buffer.from('')).toString('utf-8') };
};

/**
 * Boot-time self-test: exercise the operator-page credentials WITHOUT
 * messaging the operator. getMe proves the bot token is valid; getChat
 * proves the chat is reachable by this bot. A dead alarm must be noisy
 * while everything else is healthy — that is the only time anyone can
 * hear it (chief, 2026-07-21). The full send path is proven by a one-time
 * live delivery test, not re-proven noisily on every boot.
 */
export function validateOperatorChat(
  frameworkRoot: string,
  transport: ValidationTransport = curlValidationTransport,
  opts: { requireExplicit?: boolean } = {},
): OperatorChatValidation {
  const creds = getOperatorChatCreds(frameworkRoot);
  if (!creds) {
    return { ok: false, failed: 'no-creds', detail: 'no operator chat credentials resolved (env or agent .env)' };
  }
  // DELIVERABILITY IS NOT ADDRESSEE (chief, 2026-07-21). A fallback-resolved
  // chat is reachable but nobody CHOSE it — measured today it was the wrong
  // human, and getMe/getChat passed on it anyway. Under requireExplicit the
  // self-test refuses a green it cannot earn: the expected chat must be
  // asserted BY configuration (CTX_OPERATOR_CHAT_ID), not merely reachable.
  if (opts.requireExplicit && creds.source !== 'env') {
    return {
      ok: false,
      failed: 'not-explicit',
      detail: `operator chat resolved by FALLBACK to chat ${creds.chatId} (first agent .env) — ` +
        'reachable but not chosen; set CTX_OPERATOR_CHAT_ID + CTX_OPERATOR_BOT_TOKEN so pages go to the operator, not whoever sorts first',
    };
  }
  try {
    const me = transport(`https://api.telegram.org/bot${creds.botToken}/getMe`);
    if (me.status !== 0 || !/"ok"\s*:\s*true/.test(me.body)) {
      return { ok: false, failed: 'getMe', detail: `bot token invalid or unreachable: ${me.body.slice(0, 200) || `curl exit ${me.status}`}` };
    }
    const chat = transport(`https://api.telegram.org/bot${creds.botToken}/getChat?chat_id=${encodeURIComponent(creds.chatId)}`);
    if (chat.status !== 0 || !/"ok"\s*:\s*true/.test(chat.body)) {
      return { ok: false, failed: 'getChat', detail: `chat ${creds.chatId} unreachable by bot: ${chat.body.slice(0, 200) || `curl exit ${chat.status}`}` };
    }
    // The green NAMES the chat it validated (source included): the
    // post-deploy check must confirm "green AND addressed to the operator",
    // and a green that does not say who it is addressed to would force the
    // checker back to the old reachability-only reading (chief, 2026-07-21).
    return { ok: true, failed: 'none', detail: `bot token valid, chat ${creds.chatId} reachable (source: ${creds.source})` };
  } catch (err) {
    return { ok: false, failed: 'getMe', detail: `validation threw: ${err instanceof Error ? err.message : String(err)}` };
  }
}

/** The observer event a self-test outcome should emit. */
export interface OperatorSelfTestEvent {
  category: 'action' | 'error';
  event: 'operator_page_selftest_ok' | 'operator_page_selftest_failed';
  severity: 'info' | 'error';
  meta: Record<string, unknown>;
}

/**
 * Map a self-test result to the observer event it emits. A per-run event on
 * BOTH outcomes — not failure-only — so the event stream can tell HEALTHY from
 * DEAD/stopped: with a failure-only control, event-stream silence reads
 * identically whether the page works or the self-test stopped running. The
 * persistent marker already records both states; this brings the event stream
 * to parity so a sweep need not know which store holds the positive signal
 * (task_1787204161743, condition 1).
 */
export function operatorSelfTestEvent(v: OperatorChatValidation): OperatorSelfTestEvent {
  return v.ok
    ? { category: 'action', event: 'operator_page_selftest_ok', severity: 'info', meta: { detail: v.detail } }
    : { category: 'error', event: 'operator_page_selftest_failed', severity: 'error', meta: { failed: v.failed, detail: v.detail } };
}

export interface PageOperatorOptions {
  /** Injectable transport for tests / live harness. Default: curl. */
  transport?: PageTransport;
  log?: (msg: string) => void;
  /**
   * Refuse to send via FALLBACK-resolved creds — send only to the chat
   * explicitly chosen by CTX_OPERATOR_* config. For NEW alert capabilities
   * (the common-mode arm) this makes the misconfigured state inert-and-loud
   * instead of a multiplier at the wrong chat: on 2026-07-20, 24 rung-3
   * pages targeted a non-operator chat overnight via the fallback; had the
   * common-mode arm shipped before the env config, it would have ADDED
   * pages to the wrong human rather than reached the operator. Existing
   * callers (rung-3, crash-loop) keep fallback behaviour — changing their
   * semantics is a separate, deliberate decision.
   */
  requireExplicit?: boolean;
}

/**
 * Page the operator chat. Returns true only on Telegram-confirmed delivery.
 * Best-effort: never throws — callers are often already in a failure path.
 */
export function pageOperator(
  frameworkRoot: string,
  message: string,
  label: string,
  opts: PageOperatorOptions = {},
): boolean {
  const log = opts.log ?? ((m: string) => console.error(m));
  const creds = getOperatorChatCreds(frameworkRoot);
  if (!creds) {
    log(`[daemon] ${label}: no operator chat configured ` +
      '(set CTX_OPERATOR_CHAT_ID + CTX_OPERATOR_BOT_TOKEN, or ensure at least one agent .env exists)');
    return false;
  }
  if (opts.requireExplicit && creds.source !== 'env') {
    log(`[daemon] ${label}: REFUSING to page — operator chat resolved by fallback to ${creds.chatId} ` +
      '(not chosen by config). Set CTX_OPERATOR_CHAT_ID + CTX_OPERATOR_BOT_TOKEN. ' +
      'A page to an unchosen chat is noise at a stranger, not an alarm.');
    return false;
  }
  const transport = opts.transport ?? curlPageTransport;
  try {
    const result = transport(creds, message);
    log(result.delivered
      ? `[daemon] ${label} delivered to operator chat (${result.detail})`
      : `[daemon] ${label} NOT delivered (${result.detail})`);
    return result.delivered;
  } catch (err) {
    log(`[daemon] ${label} transport threw: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
}
