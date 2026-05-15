---
name: on-demand-mode
description: "Your config.json has on_demand: true. You are a specialist that boots only when work is queued. Read this skill at session start to understand your lifecycle: check inbox, do the work, report done, self-stop."
triggers: ["on_demand", "on-demand", "self-stop", "self stop", "stop when done", "ephemeral session"]
---

# On-Demand Mode

You are running as an on-demand specialist. Unlike always-on agents, you boot when work is queued, complete it, and stop — you do not run continuously.

## Session Start Protocol (on-demand)

1. **Do NOT send a generic boot Telegram message** — you were started for a specific task.
2. Read bootstrap files (IDENTITY.md, SOUL.md, MEMORY.md — skip GOALS.md unless relevant).
3. **Check inbox immediately**: `cortextos bus check-inbox`
4. If inbox has messages: process them — this is your work queue.
5. If inbox is empty AND no in-progress tasks exist: self-stop (see below). You were started in error or work was already done.

## Work Cycle

1. Process each inbox message as a task.
2. Create a task in the tracker for any significant work (>10 min).
3. Complete the task, write memory, send completion message to chief.
4. Check inbox again for any messages that arrived during work.
5. When inbox is empty and all tasks done: proceed to self-stop.

## Self-Stop

When you have finished all queued work:

```bash
# 1. Send completion notice to chief
cortextos bus send-message chief normal "All queued work complete. Self-stopping. [brief summary of what was done]"

# 2. Log the session end event
cortextos bus log-event action session_end info --meta "{\"agent\":\"$CTX_AGENT_NAME\",\"reason\":\"on-demand work complete\"}"

# 3. Write session-end memory entry
# (append to memory/YYYY-MM-DD.md: "SESSION END — on-demand work complete")

# 4. Self-stop (writes .user-stop marker to suppress crash alert, then kills this session)
cortextos stop $CTX_AGENT_NAME
```

**Important**: `cortextos stop $CTX_AGENT_NAME` terminates your process. Write memory and send messages BEFORE calling it.

## What Chief Expects

- A done message in its inbox when work is complete.
- No heartbeats between sessions (you are stopped). Chief knows `on_demand: true` means heartbeat gaps are expected.
- You may be started and stopped multiple times per day.

## Telegram During Sleep

Messages sent to you while stopped queue in your inbox. They will be waiting on your next boot. The fast-checker daemon delivers them when you are running — no messages are lost.

## Memory Continuity

Your MEMORY.md and daily journals survive between sessions. Read them on boot to restore context. The KB is also available: `cortextos bus kb-query "<topic>"`.
