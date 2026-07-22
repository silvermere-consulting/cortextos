# Heartbeat Checklist - EXECUTE EVERY STEP. SKIP NOTHING.

This runs on your heartbeat cron (every 1 hour). Execute EVERY step in order.
Skipping steps = broken system. The dashboard monitors your compliance.

> **Step 0.5 (F7 unconditional MEMORY.md re-read) RETIRED 2026-06-02** — OVERWRITE protocol makes mid-session re-reads unnecessary. Session-start MEMORY.md read in standard protocol still applies.

## Step 1: Update heartbeat (DO THIS FIRST)

```bash
cortextos bus update-heartbeat "<1-sentence summary of current work>"
```

If this fails, your agent shows as DEAD on the dashboard. Fix it before anything else.

**Note:** `update-heartbeat` (Step 1) and `log-event heartbeat agent_heartbeat` (Step 4) are NOT interchangeable.
- `update-heartbeat` refreshes the dashboard status-string field.
- `log-event heartbeat …` appends to the activity feed (JSONL append-only event log).

Both are required every cycle.

## Step 2: Sweep inbox for un-ACK'd messages

Messages arrive in real time via the fast-checker daemon. This step is a safety sweep for anything that wasn't ACK'd.

Full reference: `plugins/cortextos-agent-skills/skills/comms/SKILL.md`

```bash
cortextos bus check-inbox
```

For any messages returned: process and ACK each one:

```bash
cortextos bus ack-inbox "<message_id>"
```

Un-ACK'd messages are re-delivered after 5 minutes. Target: 0 un-ACK'd after this sweep.

If any of those messages were Telegram-shape (`=== TELEGRAM from`), you should already have replied via `cortextos bus send-telegram` when they first arrived — if not, do it NOW before continuing.

## Step 3: Check task queue + stale task detection

Full reference: `plugins/cortextos-agent-skills/skills/tasks/SKILL.md`

```bash
cortextos bus list-tasks --agent $CTX_AGENT_NAME --status pending
cortextos bus list-tasks --agent $CTX_AGENT_NAME --status in_progress
```

- If you have pending tasks: pick the highest priority one
- If you have in_progress tasks older than 2 hours: either complete them NOW or update their status with a note
- If you have NO tasks: check GOALS.md for objectives, then message the orchestrator

## Step 4: Log heartbeat event

Full reference: `plugins/cortextos-agent-skills/skills/event-logging/SKILL.md`

```bash
cortextos bus log-event heartbeat agent_heartbeat info --meta '{"agent":"'$CTX_AGENT_NAME'"}'
```

## Step 5: Write daily memory

Full reference: `plugins/cortextos-agent-skills/skills/memory/SKILL.md`

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

Read GOALS.md. Goals are refreshed daily by the orchestrator each morning.

- If goals were updated today: you should already have tasks. If not, create them now — see `plugins/cortextos-agent-skills/skills/tasks/SKILL.md`
- If goals are stale (>24h without update): message the orchestrator to request fresh goals
- If you have no goals: message the orchestrator immediately. Don't idle.

## Step 7: Resume work

Full reference: `plugins/cortextos-agent-skills/skills/tasks/SKILL.md`

Pick your highest priority task and work on it. Tasks should trace back to your current goals.

When starting:
```bash
cortextos bus update-task "<task_id>" in_progress
```

When done:
```bash
cortextos bus complete-task "<task_id>" --result "<summary of what was produced>"
```

If you are blocked, see `plugins/cortextos-agent-skills/skills/human-tasks/SKILL.md` for the human task and approval workflow.
If you need an approval before acting, see `plugins/cortextos-agent-skills/skills/approvals/SKILL.md`.

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

## Step 8: Guardrail self-check

Full reference: `plugins/cortextos-agent-skills/skills/guardrails-reference/SKILL.md`

Ask yourself: did I skip any procedures this cycle? Did I rationalize not doing something I should have?

If yes, log it:
```bash
cortextos bus log-event action guardrail_triggered info --meta '{"guardrail":"<which one>","context":"<what happened>"}'
```

If you discovered a new pattern that should be a guardrail, add it to GUARDRAILS.md now.

## Step 9: Update long-term memory (if applicable)

Full reference: `plugins/cortextos-agent-skills/skills/memory/SKILL.md`

If you learned something this cycle that should persist across sessions:
- Patterns that work/don't work
- User preferences discovered
- System behaviors noted
- Append to MEMORY.md

## Step 10: Re-ingest memory to knowledge base

Full reference: `plugins/cortextos-agent-skills/skills/knowledge-base/SKILL.md`

Keep your memory collection searchable and current:

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

This runs automatically on every heartbeat cycle. It ensures past experiences, user preferences, and learned patterns are semantically searchable for future tasks. Skip if GEMINI_API_KEY is not configured.

---

REMINDER: A heartbeat with 0 events logged and 0 memory updates means you did nothing visible.
Target: >= 2 events and >= 1 memory update per heartbeat cycle.
Invisible work is wasted work.
