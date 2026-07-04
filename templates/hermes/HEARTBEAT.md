# Heartbeat Checklist — EXECUTE EVERY STEP. SKIP NOTHING.

This runs on your heartbeat cron (every 1 hour). Execute EVERY step in order.
Skipping steps = broken system.

> **Step 0.5 (F7 unconditional MEMORY.md re-read) RETIRED 2026-06-02** — OVERWRITE protocol makes mid-session re-reads unnecessary. Session-start MEMORY.md read in standard protocol still applies.

## Step 1: Update heartbeat (DO THIS FIRST)

```bash
cortextos bus update-heartbeat "<1-sentence summary of current work>"
```

If this fails, your agent shows as DEAD on the dashboard. Fix it before anything else.

**Note:** `update-heartbeat` (Step 1) and `log-event heartbeat agent_heartbeat` (Step 4) are NOT interchangeable.
- `update-heartbeat` refreshes the dashboard status-string field (what the dashboard reads to know you're alive).
- `log-event heartbeat …` appends to the activity feed (JSONL append-only event log).

Both are required every cycle. Skipping Step 1 leaves your dashboard view stale even though you're firing events.

## Step 2: Check inbox

```bash
cortextos bus check-inbox
```

Process ALL messages. ACK every single one:
```bash
cortextos bus ack-inbox "<message_id>"
```

Un-ACK'd messages are re-delivered in 5 minutes.
Target: 0 un-ACK'd messages after this step.

## Step 3: Check task queue

```bash
cortextos bus list-tasks --agent $CTX_AGENT_NAME --status pending
cortextos bus list-tasks --agent $CTX_AGENT_NAME --status in_progress
```

- Pending tasks: pick the highest priority one and start it
- In-progress tasks older than 2 hours: complete them or update status with a note
- No tasks: check GOALS.md for objectives, then check with orchestrator

## Step 4: Log heartbeat event

```bash
cortextos bus log-event heartbeat agent_heartbeat info --meta '{"agent":"'$CTX_AGENT_NAME'"}'
```

## Step 5: Write daily memory

```bash
TODAY=$(date -u +%Y-%m-%d)
mkdir -p memory
cat >> "memory/$TODAY.md" << MEMORY

## Heartbeat Update - $(date -u +%H:%M)
- WORKING ON: <task_id or "none">
- Status: <healthy/working/blocked>
- Inbox: <N messages processed>
- Next action: <what you will do next>
MEMORY
```

## Step 6: Re-index memory to KB

```bash
# (1) backfill any not-yet-indexed memory day cheaply (path-id skip, no --force) so no day is silently missed:
cortextos bus kb-ingest ./memory/*.md \
  --org $CTX_ORG --agent $CTX_AGENT_NAME --collection memory-$CTX_AGENT_NAME
# (2) refresh the actively-changing files (MEMORY.md + today's daily) into the SAME memory-{agent} collection.
#     NO --force: content-hash dedup (mmrag should_skip) re-embeds only CHANGED/new chunks and skips unchanged ones,
#     so hourly re-ingest is cheap instead of re-embedding ALL of memory every heartbeat (wasteful CPU under the local nomic
#     backend; would also burn quota under a remote embed backend). Do NOT re-add --force to a routine re-ingest (2026-07-01):
cortextos bus kb-ingest ./MEMORY.md ./memory/$(date -u +%Y-%m-%d).md \
  --org $CTX_ORG --agent $CTX_AGENT_NAME --collection memory-$CTX_AGENT_NAME
```

## Step 7: Check GOALS.md

Read GOALS.md for any new objectives. If goals changed, create tasks:
```bash
cortextos bus create-task "<title>" --desc "<description>" --assignee $CTX_AGENT_NAME
```

## Step 8: Resume work

Pick your highest priority task and work on it.

```bash
cortextos bus update-task "<task_id>" in_progress
# ... do the work ...
cortextos bus complete-task "<task_id>" "<summary of what was produced>"
```

---

REMINDER: A heartbeat with 0 events logged and 0 memory updates means you did nothing visible.
Target: >= 2 events and >= 1 memory update per heartbeat cycle.
