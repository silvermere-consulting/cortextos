import { existsSync, readdirSync } from 'fs';
import { join } from 'path';

/**
 * Recipient validation for the send-message CLI — the fail-closed half of the
 * 2026-07-22 send-path fix.
 *
 * Why this module exists (measured, not hypothetical): 126 messages sat across
 * ten queues no consumer has ever read — 87 of them addressed to typed
 * recipient names that never existed (human/steven/steve/perkins/admin/ba),
 * spanning 69 days, with two real deadlines expiring inside the queue. The old
 * behaviour printed "Warning: ... may never be read" AND QUEUED ANYWAY: a send
 * that cannot fail looks identical to a send that worked, and the warning made
 * the broken thing look considered rather than broken.
 *
 * The rule this implements: REFUSE MEANS THE MESSAGE DOES NOT QUEUE. A refusal
 * that degrades into a sterner warning above an accepting queue reproduces the
 * disease with better prose (review criterion, chief-held).
 */

/** Names that read as attempts to message a HUMAN through agent messaging.
 * Used ONLY to sharpen the refusal message — classification never changes the
 * outcome (every unknown recipient refuses identically). Keeping the set small
 * and message-only means an unlisted human name still fails safe: it gets the
 * generic refusal, which carries the same redirection lines. */
const HUMAN_ALIAS_HINTS = new Set([
  'human', 'user', 'steve', 'steven', 'jen', 'admin', 'operator',
]);

export interface RecipientCheck {
  exists: boolean;
  looksHuman: boolean;
  knownAgents: string[];
}

/**
 * An agent EXISTS iff a directory orgs/<org>/agents/<name> exists in the
 * project tree — the same criterion the daemon uses to boot it. A stopped
 * agent (dir present, not running) is a VALID recipient: its inbox is consumed
 * when it next boots. The dangerous set is names with no dir at all — nothing
 * will ever consume that inbox.
 */
export function checkRecipient(projectRoot: string, to: string): RecipientCheck {
  const knownAgents: string[] = [];
  let exists = false;
  const orgsDir = join(projectRoot, 'orgs');
  if (existsSync(orgsDir)) {
    try {
      for (const org of readdirSync(orgsDir)) {
        const agentsDir = join(orgsDir, org, 'agents');
        if (!existsSync(agentsDir)) continue;
        for (const name of readdirSync(agentsDir)) {
          if (existsSync(join(agentsDir, name))) {
            knownAgents.push(name);
            if (name === to) exists = true;
          }
        }
      }
    } catch { /* unreadable orgs tree -> treated as no roster; caller refuses (fail closed) */ }
  }
  return { exists, looksHuman: HUMAN_ALIAS_HINTS.has(to.toLowerCase()), knownAgents };
}

/**
 * The refusal text. Teaches the correct tool at the moment of error — the only
 * moment anyone is listening (chief's protected review element). Both
 * redirections always appear, because we cannot enumerate the open set of
 * human names; the human-alias hint only reorders the emphasis.
 */
export function buildRefusal(to: string, check: RecipientCheck): string {
  const lines: string[] = [];
  lines.push(`REFUSED: '${to}' is not an agent in this project — the message was NOT queued.`);
  if (check.looksHuman) {
    lines.push(`'${to}' looks like a HUMAN. Agent messaging cannot reach humans: nothing ever`);
    lines.push(`consumes that inbox (87 messages to human-typed names sat unread for 69 days;`);
    lines.push(`two deadlines expired inside that queue).`);
  }
  lines.push(`To reach a HUMAN: create-task "[HUMAN] <what>" --desc "<steps>" --project human-tasks`);
  lines.push(`  (dashboard-visible, the surface humans actually read) — or create-approval for sign-offs.`);
  lines.push(`To message an AGENT: valid recipients are: ${check.knownAgents.sort().join(', ') || '(none found — is projectRoot set?)'}`);
  lines.push(`Deliberately queueing for an agent that will exist later: re-run with --force-queue.`);
  return lines.join('\n');
}

/** Body tags that assert urgency/humanness the ENVELOPE does not carry.
 * 19 of the 87 dead-queue bodies said [high] while every envelope said normal —
 * a triage tool reading the envelope field found zero. Warn (never refuse):
 * the mismatch is a smell, not proof of error. */
export function priorityBodyMismatch(priority: string, text: string): string | null {
  if (priority !== 'normal' && priority !== 'low') return null;
  const m = text.match(/\[(high|urgent|HUMAN)\]/i);
  if (!m) return null;
  return (
    `Warning: body carries the tag '[${m[1]}]' but the envelope priority is '${priority}'. ` +
    `Routing and triage read the ENVELOPE — a tag in prose is invisible to them. ` +
    `If this message is genuinely ${m[1].toLowerCase() === 'human' ? 'for a human, use create-task [HUMAN]' : `${m[1].toLowerCase()}-priority, pass '${m[1].toLowerCase()}' as the priority argument`}.`
  );
}
