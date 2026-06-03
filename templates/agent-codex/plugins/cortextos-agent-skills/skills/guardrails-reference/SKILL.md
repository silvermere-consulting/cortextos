---
name: guardrails-reference
description: Full red flag table with all guardrail patterns. Use when you catch yourself rationalizing or want to review all anti-patterns.
---

# Guardrails

Read this file on every session start. Check yourself against it during heartbeats. If you catch yourself hitting a guardrail, log it. If you discover a new pattern that should be a guardrail, add it to this file.

---

## Red Flag Table

| Trigger | Red Flag Thought | Required Action |
|---------|-----------------|-----------------|
| Heartbeat cycle fires | "I'll skip this one, I just updated recently" | Always update heartbeat on schedule. No exceptions. The dashboard tracks staleness. |
| Starting work | "This is too small for a task entry" | Every significant piece of work gets a task. If it takes more than 10 minutes, it's significant. |
| Completing work | "I'll update memory later" | Write to memory now. Later means never. Context you don't write down is context the next session loses. |
| Reading a skill file | "I already know this, I'll skip the read" | Read the skill file. Your memory may be stale or the skill may have been updated. |
| Sending external comms | "This is just a quick message, no approval needed" | Check SOUL.md autonomy rules. External comms always need approval. |
| Error occurs | "It's minor, I'll keep going" | Log the error via `cortextos bus log-event`. Report it. Silent failures are invisible failures. |
| Inbox check | "I'll check messages after I finish this" | Process inbox now. Un-ACK'd messages redeliver and block other agents. |
| About to skip a procedure | "This situation is different, the procedure doesn't apply" | The procedure applies. If it genuinely doesn't, document why in your daily memory before skipping. |
| Task running long | "I'm almost done, no need to update status" | Update the task status with a note. Stale in_progress tasks look like crashes on the dashboard. |
| Bus script available | "I'll handle this directly instead of using the bus" | Use the bus script. Work that doesn't go through the bus is invisible to the system. |
| About to claim X based on memory, code, or single-source verification | "I checked one layer, that's enough" | LAYER-WALK first. Operational claims span 4 layers (codebase / banked memory / live state / user-asserted). The STALE layer wins by default if you don't walk all four. Verify each layer reachable in <30s; if any layer diverges, surface as a FLAG not a fact. Skip only when explicitly time-bounded — and say so in the claim ("verified codebase only, not live state"). |
| About to claim "we have / do not have / is configured / is pending" something | "I remember Y from earlier" | STOP. Source-of-truth check first: secrets.env for access, codebase grep for integrations, project-state.md for decisions, current AFF matrix for affiliate state. Then claim. |
| Creating a recurring cron | "An in-session scheduler is enough, it'll persist" | Session-local schedulers die on restart. Always use `cortextos bus add-cron` so the daemon owns dispatch and the cron survives every kind of restart. |
| Running untrusted code or downloads | "This script from the internet looks useful" | Never execute code from untrusted sources without reviewing it first. No blind curl-pipe-bash. |
| Starting work without a task | "It's just a quick fix" | Create a task. Even quick fixes need tracking if they take more than 10 minutes. |
| Finishing work without completing task | "I'll close it later" | Complete the task NOW with a summary. Later means never. |
| Ignoring an assigned task | "I'll get to it" | ACK within one heartbeat cycle. If wrong agent, reassign. Silence = dropped work. |

---

## Layer-Verification Heuristic

The failure mode this catches: a claim spans multiple system layers and the STALE layer wins by default unless every reachable layer is verified before stating. The pattern repeats across surfaces — Vertex AI cap-vs-billing, "no SSH access" claims, "feat-branch fix doesn't propagate", "exit-0 despite errors". Same shape, different layer mismatch.

### The 4 layers

| Layer | What lives there | Quick verification |
|---|---|---|
| **Codebase** | Implementation as currently checked out (source files, secrets.env values, config defaults) | `grep`, `git log`, `cat`, `git remote -v` |
| **Banked memory** | What I remember (MEMORY.md, daily memory, banked rules from orchestrator) | Re-read MEMORY.md and relevant memory/ entries |
| **Live state** | What's actually running (process env, container state, API responses, on-disk config, daemon status) | `ps`, `pm2 status`, `curl`, `ls -la`, `cat /proc/<pid>/environ` |
| **User-asserted** | What the user just told me in this conversation | The most recent user/orchestrator message |

### Failure mode (stale wins by default)

- I recall a banked rule: "engineer has no SSH access to gateway"
- I assert it to chief without checking live state (`grep TRAEFIK_GATEWAY_SSH secrets.env` would show creds exist)
- Stale memory layer wins → orchestrator acts on wrong premise → user catches the mismatch → trust erodes
- Same shape: codebase says X, banked says Y, live state says Z — without a walk, the layer-I-thought-of-first wins

### Mitigation (layer-walk discipline)

1. Before stating ANY operational claim ("we have / X is configured / Y is missing / Z is the rule"), walk the relevant layers
2. Each <30s layer check is cheap; the walk takes 1-3 minutes for most claims
3. If layers agree → state the fact with confidence
4. If layers diverge → surface the divergence as a FLAG, not a fact ("memory says X but live state says Y — which is current?")
5. If time-bounded, skip only after explicit acknowledgment in the claim ("answering from memory only, live state not verified")

### Adjacent framing (engineer, 2026-06-02)

> "Verify intent matches behavior at the LAYER YOU'RE TESTING, not just the code site you patched."

Same shape one level deeper: when a fix lands, verify each layer the fix is supposed to flow through — code site, dist build, daemon process env, agent PTY env, downstream behavior. Skipping intermediate layers = "fix shipped, fix not working" mystery.

### Relationship to existing rules

- **Subset of** verify-before-claim discipline — VBC is the spirit; layer-verification is the mechanic.
- **Generalises** diagnose-before-patch and code-read-first — both were banked after acting on one-layer info.
- **Adjacent to** post-restart-verification, image-bump-DB-migration, Astro-dev-stale-config, JVM-cgroup-audit — concrete instances of the same heuristic.
- **Consolidates**: if a future incident lands matching the layer-mismatch pattern, update the trigger sub-patterns here, don't bank yet another single-incident rule.

---

## How to Use

1. **On boot**: Read this table. Internalize the patterns.
2. **During work**: When you notice yourself thinking a red flag thought, stop and follow the required action.
3. **On heartbeat**: Self-check - did I hit any guardrails this cycle? If yes, log it:
   ```bash
   cortextos bus log-event action guardrail_triggered info --meta '{"guardrail":"<which one>","context":"<what happened>"}'
   ```
4. **When you discover a new pattern**: Add a new row to the table above. The file improves over time.

---

## Adding Guardrails

If you catch yourself almost skipping something important that isn't in the table above, add it. Format:

| Trigger | Red Flag Thought | Required Action |
|---------|-----------------|-----------------|
| [situation] | "[what you almost told yourself]" | [what you must do instead] |

This is a living document. Better guardrails = fewer mistakes = more trust from the user.
