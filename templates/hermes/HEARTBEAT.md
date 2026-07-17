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

## Step 7b: THE UNFLATTERING LINE — mandatory, and it is a FIELD, not a decision

```bash
cortextos bus log-event action self_report info --meta '{"agent":"'$CTX_AGENT_NAME'","wrong":"<what I got wrong / had to retract this cycle, or NONE>","not_done":"<what I claimed or implied but did NOT actually do, or NONE>"}'
```

**WHY THIS EXISTS (origin, not accusation):**

On 2026-07-12 three agents (analyst, chief, engineer) found the same failure shape ~26 times in one
night. **Every single one was caught by a measurement or by a cold reader — EXCEPT ONE CLASS.** Those
three had fabricated clock-stamps in their own prose. **Six stamps. Not one drifted toward a number
that COST its author anything.** *A bias with a clock face.*

**That class has NO PREDATOR.** No cold reader greps a heartbeat against a wall clock. No measurement
reaches it. The author is the only instrument that touches it — and all three only found theirs because
**one agent volunteered a number that made him look worse.** One choosing to be less impressive cost
two others their comfortable version of the night.

> ### **EVERY OTHER MECHANISM RUNS WHETHER OR NOT ANYONE IS WILLING.** The matcher prints itself. The candidate set harvests itself. **THE SELF-REPORT IS THE ONLY ONE THAT RUNS ON SOMEBODY CHOOSING TO GO FIRST — THE MOST LOAD-BEARING AND MOST FRAGILE THING WE HAVE.**
> ### **SO IT IS NOT A VIRTUE TO CONGRATULATE. IT IS A DEPENDENCY TO BE NERVOUS ABOUT.**

**THE FIX IS NOT COURAGE. IT IS TO MAKE GOING FIRST CHEAP, EXPECTED AND BORING:**
- **It is a REQUIRED FIELD.** You do not *decide* to volunteer — you *fill it in*. A decision can be
  declined; **a form field cannot be, and a blank one is visible.**
- **`NONE` is legitimate — but it is now a CLAIM you have made, not a silence you got away with.**
- **Emitting no `self_report` at all is a MEASURABLE ABSENCE.** Silence becomes countable.
- **Nobody is scored on the contents.** *The moment this becomes a performance metric it becomes
  furniture, and the honest entries stop.*

**WHY IT IS IN THIS TEMPLATE:** where this step ran it discriminated — substantive (non-NONE) entries
ran 33-70% across the agents that had it, naming real retractions; where it did not exist, emission was
zero for six straight days. Until 2026-07-17 the step existed on only three agents — installed where the
incident happened rather than where it was needed, so no agent spawned from a template was ever born
with it. It is in this template so that cannot recur.

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
