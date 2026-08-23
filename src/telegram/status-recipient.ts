/**
 * Canonical routing for machine/ops status notices (crash / halt / recovery / boot).
 *
 * EXTRACTED 2026-08-23 (JEN-LEAK path F): this rule previously lived only in
 * hook-crash-alert.ts, but the daemon (agent-manager, agent-process) has its OWN
 * status-send paths that bypassed it and sent crash/halt/recovery notices straight
 * to the conversational CHAT_ID — which for a client-facing agent (e.g. othe -> Jen)
 * is a non-technical person on a deliberate no-contact hold. A hook cannot suppress a
 * DAEMON-executed send, so the rule has to be shared code, not a per-file habit. This
 * module is that shared home; every status sender imports resolveStatusRecipient.
 *
 * EXPLICIT RECIPIENT ONLY (2026-07-21, third-sender finding): status/ops notices go
 * ONLY to CTX_STATUS_CHAT_ID — a chat someone explicitly configured as the intended
 * recipient — never to the conversational CHAT_ID. For a single-agent org, CHAT_ID is
 * a person who never asked for ops noise (3 restart notices over 11 days, measured
 * from the dedup stamp). A status notice to someone who cannot act is not information,
 * it is intrusion. Unset = no Telegram send (crashes.log + bus notify still happen),
 * with the skip LOGGED when CHAT_ID exists so the silence is attributable. Same
 * requireExplicit shape as the daemon operator page.
 */
export function resolveStatusRecipient(env: Record<string, string | undefined>): {
  chatId: string | null;
  botToken: string | undefined;
  logSkip: boolean;
  skipReason: string;
} {
  const botToken = env.BOT_TOKEN;
  const statusChat = env.CTX_STATUS_CHAT_ID;
  if (botToken && statusChat) {
    return { chatId: statusChat, botToken, logSkip: false, skipReason: '' };
  }
  if (env.CHAT_ID && !statusChat) {
    return {
      chatId: null, botToken,
      logSkip: true,
      skipReason: 'no-CTX_STATUS_CHAT_ID (CHAT_ID present but not an explicit status recipient)',
    };
  }
  return { chatId: null, botToken, logSkip: false, skipReason: 'no-credentials' };
}
