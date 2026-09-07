---
name: goal-management
description: "Daily goal lifecycle management. Use for: morning briefing goal cascade, setting daily focus, refreshing agent goals, reviewing goal progress. Triggered daily as part of morning review."
triggers: ["goals", "daily focus", "priorities", "what should we work on", "goal cascade", "set goals", "update goals", "goal management", "north star"]
---

# Goal Management

The orchestrator owns the daily goal lifecycle. Goals flow from the user's daily focus down to agent-specific objectives and tasks.

## Hierarchy

```
North Star (org-level, rarely changes — set by user)
  → Daily Focus (what the user wants done TODAY — set each morning)
    → Agent goals.json (orchestrator writes role-specific goals for each agent)
      → GOALS.md (auto-generated from goals.json — agents read this on boot)
        → Tasks (agents create from their goals)
```

## Morning Goal Cascade

Run this every morning as part of briefing:

### 1. Read current org goals

```bash
cat $CTX_FRAMEWORK_ROOT/orgs/$CTX_ORG/goals.json
```

### 2. Consult the user

Ask via Telegram:
> "Good morning. Our north star is: [north_star from goals.json]. What's the focus for today?"

Wait for their response. They may give specific directives or say "continue yesterday's work."

### 3. Update org goals.json with today's focus

```bash
jq --arg focus "the user's stated focus" --arg ts "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    '.daily_focus = $focus | .daily_focus_set_at = $ts' \
    $CTX_FRAMEWORK_ROOT/orgs/$CTX_ORG/goals.json > /tmp/goals.tmp \
  && mv /tmp/goals.tmp $CTX_FRAMEWORK_ROOT/orgs/$CTX_ORG/goals.json
```

### 4. Set each agent's goals

For each active agent, based on their role and today's daily focus:

1. Determine 2-5 role-appropriate goals
2. **MERGE their `goals.json` — NEVER REWRITE IT.**

   > ### 🔴 THIS STEP USED TO SAY `cat > …/goals.json << 'EOF'`. THAT IS A WHOLESALE REWRITE AND ON 2026-08-05 IT DELETED 17 GOALS.
   > **The correction was banked in the `goal-cascade` cron and in chief's goal (9) and NEVER REACHED THIS
   > FILE** — so the cron said *"run the cascade per goal-management/SKILL.md §4"* and this section pointed
   > the reader straight at the trap. **It survived because every operator silently repaired the command in
   > their head, which is exactly what keeps a defect invisible in the outcome.**
   >
   > ⚠️ **AND `cortextos goals set --goals` IS NOT ITSELF A MERGE.** Read before believing it: the
   > implementation does `next.goals = goals` — it **REPLACES the array**. It *is* the right writer (it
   > preserves other fields, clock-stamps `updated_at`, writes atomically, regenerates GOALS.md, and refuses
   > to overwrite an unparseable file) — **but swapping `cat >` for `goals set` without merging first is the
   > same deletion by a tidier route.** The merge is the caller's job.

   ```bash
   A=<agent>
   GJ="$CTX_FRAMEWORK_ROOT/orgs/$CTX_ORG/agents/$A/goals.json"
   NEW='["goal 1","goal 2","goal 3"]'          # only the goals you are ADDING today

   cp "$GJ" "$GJ.bak-$(date -u +%Y%m%dT%H%M%SZ)"     # back up BEFORE, not after
   BEFORE=$(jq '.goals | length' "$GJ")
   # append only genuinely-new entries; preserves order, never re-adds a duplicate
   MERGED=$(jq -c --argjson new "$NEW" '(.goals // []) as $cur | $cur + ($new - $cur)' "$GJ")

   cortextos goals set --agent "$A" --org "$CTX_ORG" --by "$CTX_AGENT_NAME" \
     --focus "role-specific focus derived from daily_focus" --goals "$MERGED"

   AFTER=$(jq '.goals | length' "$GJ")               # RE-READ FROM DISK, do not trust the command's echo
   [ "$AFTER" -lt "$BEFORE" ] && echo "🔴 GOAL COUNT FELL $BEFORE -> $AFTER — RESTORE THE BACKUP" >&2
   ```
   **The count check is the point.** A cascade that silently shrinks an agent's goals looks identical to a
   cascade that worked. *(Merge expression control-tested both directions 2026-08-20: order preserved,
   duplicate not re-added, new goal appended, and an empty `NEW` is a verified no-op.)*
   `goals set` regenerates GOALS.md itself — **no separate `generate-md` step is needed.**

4. Message the agent:
   ```bash
   cortextos bus send-message <agent> normal "New goals for today. Check GOALS.md and create tasks."
   ```

**If an agent's goals.json already has `daily_focus_set_at` matching today: skip — don't overwrite.**

### 5. Set your own goals

Write your orchestrator-level goals.json for today:
**Same rule as §4 — MERGE, never rewrite. Your own file is the one with the most history in it.**
```bash
GJ="$CTX_FRAMEWORK_ROOT/orgs/$CTX_ORG/agents/$CTX_AGENT_NAME/goals.json"
NEW='["cascade goals to all agents","send morning briefing","monitor progress","route approvals"]'

cp "$GJ" "$GJ.bak-$(date -u +%Y%m%dT%H%M%SZ)"
BEFORE=$(jq '.goals | length' "$GJ")
MERGED=$(jq -c --argjson new "$NEW" '(.goals // []) as $cur | $cur + ($new - $cur)' "$GJ")

cortextos goals set --agent "$CTX_AGENT_NAME" --org "$CTX_ORG" --by "$CTX_AGENT_NAME" \
  --focus "orchestrate today's work, cascade goals, monitor fleet" --goals "$MERGED"

AFTER=$(jq '.goals | length' "$GJ")
[ "$AFTER" -lt "$BEFORE" ] && echo "🔴 GOAL COUNT FELL $BEFORE -> $AFTER — RESTORE THE BACKUP" >&2
```

### 6. Confirm task plans

After each agent creates tasks from their new goals, review for:
- Overlap (two agents doing the same thing)
- Missing coverage (daily focus items nobody picked up)
- Misaligned tasks (work unrelated to today's focus)

## New Agent Bootstrap

When a new agent comes online with an empty `goals.json`, they will message you requesting goals.

Handle by:
1. Checking their role from `IDENTITY.md`
2. Writing their `goals.json` with appropriate starter goals
3. Running `cortextos goals generate-md --agent <name> --org $CTX_ORG`
4. Replying with confirmation

## Evening Goal Update

At end of day:
1. Check each agent's task completion against their goals
2. Note what was achieved vs planned
3. Update each agent's `goals.json` bottleneck field if new blockers emerged:
   ```bash
   jq --arg b "what's blocking them" --arg ts "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
       '.bottleneck = $b | .updated_at = $ts | .updated_by = "'$CTX_AGENT_NAME'"' \
       $CTX_FRAMEWORK_ROOT/orgs/$CTX_ORG/agents/<agent>/goals.json > /tmp/agent-goals.tmp \
     && mv /tmp/agent-goals.tmp $CTX_FRAMEWORK_ROOT/orgs/$CTX_ORG/agents/<agent>/goals.json
   cortextos goals generate-md --agent <agent> --org $CTX_ORG
   ```
4. Carry forward unfinished goals to tomorrow's morning discussion

## North Star

The north star lives in `orgs/<org>/goals.json`. It is set by the user, rarely changes. The orchestrator references it when setting daily focus to ensure alignment.

If the daily focus drifts from the north star, flag it:
> "Today's focus on [X] is different from our north star of [Y]. Is this intentional?"
