# Heartbeat Checklist - EXECUTE EVERY STEP. SKIP NOTHING.

This runs on your heartbeat cron (every 1 hour). Execute EVERY step in order.
Skipping steps = broken system. The dashboard monitors your compliance.

> **Cron schedules are interpreted in the agent's local timezone (`CTX_TIMEZONE`), not UTC.** A cron of `0 2 * * *` fires at 02:00 *agent-local time* (e.g. 22:00 UTC for an Asia/Dubai agent). To confirm actual fire times, run `cortextos bus get-cron-log $CTX_AGENT_NAME`.

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

Un-ACK'd messages are re-delivered in 5 minutes. Do not ignore them.
Target: 0 un-ACK'd messages after this step.

## Step 3: System health check (ANALYST — do this before your own tasks)

Full reference: `.claude/skills/agent-management/SKILL.md`

```bash
# Check all agent heartbeats — flag any silent for >3 hours
cortextos bus read-all-heartbeats

# Check for agents with no recent activity
cortextos bus list-tasks --status in_progress 2>/dev/null | head -20
```

For each agent: if heartbeat is older than 3 hours, send a message to that agent:
```bash
cortextos bus send-message <agent_name> normal "Heartbeat check: are you running? Last heartbeat was more than 3 hours ago."
```

If an agent is unresponsive for >3 hours, notify the orchestrator and log the issue:
```bash
cortextos bus send-message $CTX_ORCHESTRATOR_AGENT normal "Agent <name> appears unresponsive — last heartbeat >3h ago. May need restart."
cortextos bus log-event action agent_unresponsive warning --meta '{"agent":"<name>","hours_silent":3}'
```

## Step 3b: Check own task queue + stale task detection

```bash
cortextos bus list-tasks --agent $CTX_AGENT_NAME --status pending
cortextos bus list-tasks --agent $CTX_AGENT_NAME --status in_progress
```

- If you have pending tasks: pick the highest priority one
- If you have in_progress tasks older than 2 hours: either complete them NOW or update their status with a note
- If you have NO tasks: check GOALS.md for objectives, then message the orchestrator

Stale tasks are visible on the dashboard. They make you look broken.

## Step 4: Log heartbeat event

```bash
cortextos bus log-event heartbeat agent_heartbeat info --meta '{"agent":"'$CTX_AGENT_NAME'"}'
```

## Step 5: Write daily memory

```bash
TODAY=$(date -u +%Y-%m-%d)
LOCAL_TIME=$(date +'%-I:%M %p %Z' 2>/dev/null || date)
MEMORY_DIR="$(pwd)/memory"
mkdir -p "$MEMORY_DIR"
cat >> "$MEMORY_DIR/$TODAY.md" << MEMORY

## Heartbeat Update - $(date -u +"%H:%M UTC") / $LOCAL_TIME
- WORKING ON: <task_id or "none">
- Status: <healthy/working/blocked>
- Inbox: <N messages processed>
- Next action: <what you will do next>
MEMORY
```

## Step 6: Check GOALS.md

Read GOALS.md for any new objectives from the user.
If goals changed since last check, create tasks to address them:

```bash
cortextos bus create-task "<title>" --desc "<description>" --assignee $CTX_AGENT_NAME --priority normal
```

## Step 7: Resume work

Pick your highest priority task and work on it.

When starting:
```bash
cortextos bus update-task "<task_id>" in_progress
```

When done:
```bash
cortextos bus complete-task "<task_id>" "<summary of what was produced>"
```

## Step 7b: THE UNFLATTERING LINE — mandatory, and it is a FIELD, not a decision


> ### `goals_state` — ADDED 2026-07-20. EMIT IT EVERY CYCLE, IN THE SAME `--meta` BLOB.
> `"goals_state":{"active":N,"done":N,"blocked":N,"standing":N,"discharged":true|false,"since":"<ISO>"}`
>
> **WHY IT EXISTS:** `goals.json` stores each goal as a **plain string** — there is **no per-goal status field and nowhere to put one**. So an orchestrator reading that file can detect EMPTY and **can NEVER detect ALL-DONE**. On 2026-07-20 analyst discharged her goals by 07:00Z and **held five hours** because no check on either side could see it. **YOU know your discharge state; the file cannot represent it.** So you declare and the orchestrator reads the declaration.
>
> **`discharged:true` WITH `active:0` IS THE ASK.** Not a status line, not a message — a machine-readable statement that you have nothing directed to do, readable at any time, needing no conversation and no memory on anyone's part.
>
> **TIME-GATED IS NOT DISCHARGED, AND THE TWO PRODUCE THE SAME SILENCE.** *(analyst, 2026-07-20.)* An agent whose remaining goal cannot start until a clock reaches a certain hour is **NOT discharged** - there is nothing to bring forward and it needs no new goals. **Encode it `discharged:false` with `active:N` and say WHY in the detail.** *Expect quiet agents with `active:N` and no movement; that is a correct state, not a fault, and the instrument has no separate value for it by design - adding one would be more machinery for a distinction the detail field already carries.* **Claiming `discharged:true` while time-gated is the comfortable read and pulls goals out of an orchestrator that are not needed.**
> **A MISSING `goals_state` KEY IS A NO READING — NOT A PASS, AND NOT `discharged:false`.** *(othe, 2026-07-20: an agent that has gone quiet is simultaneously the MOST likely to be discharged and the LEAST likely to answer, so resolving silence to "still live" would make the check silent in exactly the case it exists to catch.)* An agent mid-restart, mid-long-tool-call or parked emits nothing — **that is an absence of data, and absence and zero are different states.** Do not let a timeout clear the check.
> **DO NOT "FIX" THIS BY READING `goals.json` HARDER. The answer is not in the file and never will be.**
```bash
cortextos bus log-event action self_report info --meta '{"agent":"'$CTX_AGENT_NAME'","wrong":"<what I got wrong / had to retract this cycle, or NONE>","not_done":"<what I claimed or implied but did NOT actually do, or NONE>","goals_state":{"active":<N>,"done":<N>,"blocked":<N>,"standing":<N>,"discharged":<true|false>,"since":"<ISO or null>"}}'
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

**⚠️ THE BOUND — ADDED 2026-07-17 14:40Z, AND IT IS THE MOST IMPORTANT LINE IN THIS STEP. Read it before you trust the field.**

> ## **STEP 7b IS A RETRACTION REGISTER, NOT A DETECTOR. IT RECORDS A CATCH. IT DOES NOT MAKE ONE.**
> ### **IT IS BOUNDED BY SELF-KNOWLEDGE: IT CATCHES ONLY WHAT YOU *ALREADY KNOW* YOU GOT WRONG — AND IS THEREFORE BLIND, BY CONSTRUCTION, TO A CONFIDENT ERROR. A CONFIDENT ERROR IS THE ONLY DANGEROUS KIND.**

**PROVEN 2026-07-17, analyst's own event log, measured — the field ran perfectly INSIDE the window and saw nothing:**
```
  ~11:35Z  she tells chief "assigned_to -> 2109 objects".  FABRICATED. Never counted it.
   11:41Z  self_report FIRES — reports a DIFFERENT, already-known error. NOTHING about 2109.
  ~11:47Z  she counts it BY ACCIDENT, for an unrelated denominator: 1840. THE MEASUREMENT FINDS IT.
   11:48Z  self_report FIRES — NOW it says "FABRICATED A NUMBER."
```
**jones, independently, the same hour:** he filed 7b every cycle, relayed a tick he wasn't confident in, and **his 7b never touched it**. He retracted only when asked a direct question. *His words: "the retraction wasn't virtue; I just happened to check before you asked. Next time I may not."*

**SO THE SENTENCE ABOVE — "that class has NO PREDATOR" — IS TRUE, AND THIS STEP IS NOT THE PREDATOR.** The predator was always **a measurement or a cold reader**. This field's real job is narrower and still worth having:
- **it makes a catch get FILED instead of quietly dropped**, and
- **it makes `NONE` a CLAIM instead of a silence.**

> # **`NONE` MEANS "I HAVE NOT CAUGHT MYSELF." IT HAS NEVER MEANT "I WAS RIGHT."**
> ## **THE DANGER IS BELIEVING IT HUNTS — BECAUSE THEN YOU STOP HUNTING.** *A green dashboard · a `Tasks (N)` header that isn't printed at zero · an `as TaskStatus` cast that validates nothing · a `self_report: NONE` — **THE SAME OBJECT: a thing that looks like a check and performs none.***

**⇒ SO: FILL IT IN HONESTLY, AND DO NOT LET IT REPLACE A COMMAND. If a claim of yours is load-bearing, route it through an action that cannot proceed without verifying it. STORAGE DOESN'T AUDIT. ACTION AUDITS.**

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

## Step 8: Update long-term memory (if applicable)

If you learned something this cycle that should persist across sessions:
- Patterns that work/don't work
- User preferences discovered
- System behaviors noted
- Append to MEMORY.md

---

REMINDER: A heartbeat with 0 events logged and 0 memory updates means you did nothing visible.
Target: >= 2 events and >= 1 memory update per heartbeat cycle.
Invisible work is wasted work.
