---
name: compact-between-tasks
description: "Compact session context between tasks to stay out of the >150k high-cost bucket. Call after completing one task and before starting the next. Decides between /compact (same domain) and hard-restart (domain switch) based on context fill and task domain."
triggers: ["compact between tasks", "clear context", "context discipline", "between tasks compact", "self compact", "task transition"]
---

# Compact Between Tasks

## When to Use

Call this after `cortextos bus complete-task` and before starting the next task.

**Rule of thumb:**
- Context fill < 15% (< 150k tokens): skip — overhead not worth it
- Context fill 15–60%: `/compact` (same domain) or check domain switch
- Context fill > 60%: always compact or restart

Check current fill:
```bash
cat ~/.cortextos/${CTX_INSTANCE_ID}/state/${CTX_AGENT_NAME}/context_status.json 2>/dev/null | \
  python3 -c "import sys,json; d=json.load(sys.stdin); print(f\"{d.get('fill_pct',0):.1f}%\")"
```

## Decision Tree

```
Same task domain as before?
  YES → fill > 15%? → /compact (preserves context summary)
  NO  → hard-restart (fresh context, no domain bleed)
```

**Same domain examples:** two research tasks, two coding tasks, two analysis tasks.
**Domain switch examples:** coding → market research, analysis → outreach draft.

## /compact (same domain, fill > 15%)

```bash
cortextos bus self-compact
```

This injects `/compact` into Claude Code's PTY. Claude Code will compact the session on the next idle cycle — the compaction summary preserves key context. `hook-extract-facts` fires automatically and saves facts to the state directory.

After calling `self-compact`, write a brief memory entry:
```
COMPACTED: switching from [completed task] to [next task] — context cleared to summary
```

## Hard Restart (domain switch)

```bash
cortextos bus hard-restart --reason "domain switch: [old domain] → [new domain]"
```

This produces a fresh session. Your MEMORY.md and daily journal survive — read them on next boot to restore context.

## What /compact Preserves

Claude Code's compaction keeps a summary of the conversation, not the full history. Key facts, decisions, and current task state are preserved. The `hook-extract-facts` PreCompact hook also writes extracted facts to `state/<agent>/facts/`.

## What Gets Dropped

Full turn-by-turn conversation history. This is intentional — it resets the context window so the next task starts with headroom.

## Integration with Task Workflow

Add to your standard task completion sequence:
```
1. cortextos bus complete-task <id> --result "..."
2. cortextos bus log-event task task_completed info ...
3. [this skill] — compact if fill > 15% and tasks remain
4. cortextos bus create-task "<next task>" ...
```
