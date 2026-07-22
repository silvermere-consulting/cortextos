# Guardrails

Read this file on every session start. Full reference: `.claude/skills/guardrails-reference/SKILL.md`

---

## Red Flag Table

| Trigger | Red Flag Thought | Required Action |
|---------|-----------------|-----------------|
| Heartbeat cycle fires | "I'll skip this one, I just updated recently" | Always update heartbeat on schedule. No exceptions. The dashboard tracks staleness. |
| Starting work | "This is too small for a task entry" | Every significant piece of work gets a task. If it takes more than 10 minutes, it's significant. |
| Completing work | "I'll update memory later" | Write to memory now. Later means never. Context you don't write down is context the next session loses. |
| Inbox check | "I'll check messages after I finish this" | Process inbox now. Un-ACK'd messages redeliver and block other agents. |
| Bus script available | "I'll handle this directly instead of using the bus" | Use the bus script. Work that doesn't go through the bus is invisible to the system. |
| About to claim X based on memory, code, or single-source verification | "I checked one layer, that's enough" | LAYER-WALK first. Operational claims span 4 layers (codebase / banked memory / live state / user-asserted). The STALE layer wins by default if you don't walk all four. Verify each layer reachable in <30s; if any layer diverges, surface as a FLAG not a fact. Skip only when explicitly time-bounded — and say so in the claim ("verified codebase only, not live state"). |

## Specialist Agent Patterns

| Trigger | Red Flag Thought | Required Action |
|---------|-----------------|-----------------|
| Task assigned to me | "I'll get to it later" | ACK and start within one heartbeat cycle. Stale tasks make you look broken. |
| Blocked on something | "I'll wait and see" | Create a blocker task or escalate to orchestrator immediately. Silent blockers are invisible. |
| Work finished | "Orchestrator will notice" | Complete the task and log the event now. Unlogged completions don't exist. |

For the complete red flag table (15 patterns), see `.claude/skills/guardrails-reference/SKILL.md`.

---

## How to Use

1. **On boot**: Read this table. Internalize the patterns.
2. **During work**: When you notice yourself thinking a red flag thought, stop and follow the required action.
3. **On heartbeat**: Self-check - did I hit any guardrails this cycle? If yes, log it:
   ```bash
   cortextos bus log-event action guardrail_triggered info --meta '{"guardrail":"<which one>","context":"<what happened>"}'
   ```
4. **When you discover a new pattern**: Add a new row to the table in `.claude/skills/guardrails-reference/SKILL.md`. The file improves over time.

---

## Adding Guardrails

If you catch yourself almost skipping something important that isn't in the table, add it to the skill file. Format:

| Trigger | Red Flag Thought | Required Action |
|---------|-----------------|-----------------|
| [situation] | "[what you almost told yourself]" | [what you must do instead] |

## The handover question — added 2026-07-20 (othe)

**WHAT IS TRUE NOW THAT WILL NOT BE TRUE LATER, AND WHO IS WATCHING AT THAT MOMENT?**

| Trigger | Red Flag Thought | Required Action |
|---|---|---|
| A rule is being replaced, an exclusion granted, a state about to change | *"this is correct"* — and it **is**, today | **Ask the question above.** On 2026-07-20 it caught two defects in twenty minutes that were *correct at the moment of inspection* and would have failed silently later: a **guard with no reachable failure state** (documented, therefore read as checked-clean forever) and an **exclusion with no expiry** (baked in by absence of an instruction, so it would never stop applying once its justification died). |
| The thing that just went your way | *"settled, moving on"* | **Turn the question on the exclusion you were just granted or the rule you just argued for.** That is the case people skip. |


> ### ⚠ HONEST STATUS OF THIS ENTRY: **IT IS PROSE, AND BY THE RULE BELOW IT THAT MAKES IT RUNG TWO.**
> *Audited against analyst's own rule the hour it was written (2026-07-20).* **Anything that must happen goes in the command; this went into thirteen files as a paragraph.** There is **no command surface for "ask a question at a handover"** — so it depends entirely on the reader remembering it at the moment it matters, **which is the exact dependency this document spends the rest of its length warning about.**
> **It is recorded as rung two rather than counted as coverage.** *Thirteen files carrying a paragraph is not thirteen agents asking the question.* **If someone finds a way to attach it to a command — a handover step, a checklist line that gets copied — that is a real upgrade and it has not been done.**
> **DO NOT READ THIS AS "NOT YET WIRED" - IT IS PROBABLY PERMANENT, AND THE REASON IS STRUCTURAL.** *(analyst, 2026-07-20.)* **A cron can carry a checklist because it fires on a schedule. A HANDOVER IS EVENT-DRIVEN AND HAS NO SINGLE COMMAND.** `declined` and `goals_state` were wireable because Step 7b fires hourly into exactly one line. Handovers run through `send-message`, `create-task`, `update-task blocked`, prose, or conversation - **five surfaces, no shared template**, and the most common one, *naming a duty in a message*, has **no structured field at all.** *"Not yet" invites someone to spend a week looking for a wiring that does not exist.*
> **PARTIAL COVERAGE IS AVAILABLE AND UNBUILT, AND MUST BE SOLD AS PARTIAL:** the handovers that *are* commands - `create-task`, `update-task` - could carry the question as a required template field. **Real, copied, fires without intent.** *(Needs a CLI change: engineer's, unscoped.)* **ITS EXACT MISS, IN THE SAME BREATH:** it catches handovers **that produce an artefact** and misses handovers that are **just someone saying "you are now the reader"** - which is how the reader duty was actually handed over, **and is the highest-stakes kind.**
> ### **SOME OBLIGATIONS GENUINELY CANNOT BE WIRED, BECAUSE THE MOMENT THEY APPLY IS NOT A MOMENT ANY COMMAND RUNS.**
> **Labelling those honestly as rung two is not a failure to finish the job - IT IS THE FINISHED JOB.**

*Recorded as a MECHANISM, not an aptitude — at othe's insistence: the aptitude is not transferable and the question is. Neither catch came from being careful in general; today was a long argument that general care does not work.*

## Prose is not installation — added 2026-07-20 (analyst)

> ### **AGENTS COPY THE COMMAND. THEY DO NOT COPY THE PROSE.**
> **ANYTHING THAT MUST HAPPEN GOES IN THE COMMAND. ANYTHING THAT EXPLAINS WHY CAN BE PROSE.**

**Proving case, 2026-07-20:** `goals_state` was added to 12 `HEARTBEAT.md` files as a documented block **six lines above** the `log-event` line agents actually copy. Four agents then failed to emit it. That was read — first by analyst, then by me — as *"a template field half the fleet does not fill"*, **a behaviour problem implying four colleagues had read something and declined to act.** Measured across three layers, **they had all read the file, all run the step, and all run the command the file gave them — which had no `goals_state` in it.** **A layout defect, and the agents were compliant.** *The less charitable reading was the one both of us reached first.*

**Corollary — PRESENCE IS NOT POSITION.** chief exempted analyst's own file from the fix because a grep showed `goals_state` appearing twice. **That is a COUNT, not a POSITION**: both occurrences were prose 25 lines below the command, and the field was inert. *She had emitted it only because she had written it an hour earlier and remembered.* **A string can be present and still never be typed.**

| Trigger | Red Flag Thought | Required Action |
|---|---|---|
| About to add a field, rule or step to a doc | *"it's documented, it's deployed"* | **Put it in the line that gets copied, or accept that it is rung two and SAY SO.** Then audit the rest of the day's additions the same way — analyst found one defect in five doing exactly that. |
| A grep confirms the thing is 'there' | *"present, therefore working"* | **Check WHERE.** Presence in a file and presence in the execution path are different claims. |

## The control that stopped a false accusation - 2026-07-20, seven hours after the rule was made

> ### **A ZERO FROM AN UNCALIBRATED MATCHER IS NOT A FINDING.**

**Live proving case, and it runs both directions in one hour:**
- **14:33Z** chief's patch script printed `0 files` and **he believed it**, then told analyst a fix was applied to 13 files when it was applied to none. *He had the script's self-report and no control.*
- **14:36Z** analyst went to verify that correction rather than accept it - *"accepting the CORRECTED self-report on faith would have been the identical error one level down"* - and her first matcher searched `structurally permanent` against text reading `PROBABLY PERMANENT, AND THE REASON IS STRUCTURAL`. **Different words, same meaning. It returned 0 of 13.**
- **Her known-positive control returned EMPTY on a file she was certain had the content - so she knew the MATCHER was broken, not the corpus.** Without it she would have replied *"0 of 13, your correction is also wrong"* - **a false accusation of a repeat failure, aimed at someone who had just voluntarily reported the first one. The worst message available that day.**

> **The difference was NOT judgement. It was INSTRUMENTATION.** One had a control; the other had a script's self-report. *The object we spend all day removing had been hiding in the tooling we use to remove it.*

> ### **THE ECHO IS BOTH VECTOR AND INSTRUMENT, AND ACCURATE QUOTING IS WHICH ONE IT BECOMES.**
> *(engineer, 2026-07-20, completing the weighting rather than arguing with it.)* **Manufacturing a false claim is the primary error; relaying it unchecked is secondary — but the relay is the PROPAGATION step.** A manufactured claim stops with its author; **an echo carries it into the next message and everything downstream of that.**
> **The same echo DETECTS the false claim if the quote is accurate enough to be checkable, and SPREADS it if the quote is loose.** *Twice on 2026-07-20, in both directions: chief caught engineer's "config reload" by measuring; engineer caught chief's "no audit log" by quoting it back verbatim. Neither caught his own.*
> **So: QUOTE PEOPLE VERBATIM RATHER THAN PARAPHRASING THEM.** That single habit is what converts the cheapest detector available from a vector into an instrument, and it costs nothing.

> ### **RUN THE SEARCH OVER THE WHOLE POPULATION, INCLUDING YOURSELF.**
> *(othe, 2026-07-20.)* **A query scoped to "the agents who might have this defect" CANNOT RETURN YOU — and you are the member of the population you have the least visibility into.** On 2026-07-20 chief mandated a `goals_state` key into twelve files, announced it to the fleet, and chased four agents for not emitting it — **while emitting it into the wrong event himself the whole time.** It surfaced only because othe asked him to check *the other eleven* and **the query was neutral about who it returned, so it caught its own asker.**
> **The orchestrator is systematically outside their own instruments — not through carelessness, through POSITION.** *You build the thing, so you were already doing it before you wrote it down; you read everyone, so nobody reads you; you write the rule, so you are the one node the rule was not written at.* **Each is invisible from inside the role and cheap to see from outside it.** That is the argument for the peer loop **as a mechanism, not a virtue**.

> ### **CORRECTING A CONVERSATION IS NOT CORRECTING THE ARTEFACT.**
> *(2026-07-20, three instances in one day.)* business-analyst was told her routing was wrong, agreed — **and the document still said it**, so the artefact going to the user carried a correction that existed only in a chat neither party would re-read. chief told people the true `assignee` fact in messages all day **while his own HEARTBEAT.md asserted the false one**. othe's four hard-won rules lived only in `memory/YYYY-MM-DD.md`.
> **THE CHANNEL IS NOT THE RECORD.** *When the thread ages out, the FILE is the survivor — and it was the one that was wrong.* **After a correction delivered by message, write it to the file — AND CHECK WHICH FILE RE-OPENS.** *Not all durable files are durable: `MEMORY.md` is read at session start; a DATED daily file is write-only after its day ends.*

> ### **A DEFECT CLASS IDENTIFIED MUST BE SWEPT FOR IN PRODUCTION, NOT JUST WRITTEN UP.**
> *(2026-07-20, the day's most expensive miss.)* `assignee` vs `assigned_to` was **item one** on a five-wrong-keys list written at 06:00Z. The fleet fixed its own queries and catalogued the lesson. **Nobody asked whether anything in PRODUCTION read the wrong key.** Eight hours later: `page.tsx:68` filters `t.assignee === 'human'` and returns **0 for a user with 13 open items** — his dashboard had been telling him nobody was waiting on him, on a screen he checks, for the whole period we were pleased with ourselves for spotting the class.
> **A LESSON LEARNED AND NOT SWEPT FOR ONLY PROTECTS THE PEOPLE WHO ALREADY KNOW IT.** *When you name a defect class, grep the whole estate for it the same hour — and report the count even when it is zero.*

> ### **A USER DESCRIBING A PRODUCT AS WORTHLESS IS AN UNINSTRUMENTED ERROR REPORT.**
> *(othe, 2026-07-20 — the highest-signal defect report of the day, and it was filed as sentiment.)*
> Steve said **"the dashboard adds no value"**. That IS the bug report for *"his open-items counter has been reading zero all day because it filters on a dead key"*. **He filed it in the only vocabulary available to him — experiential — and it arrived as a preference about the product.** *A user cannot say "your widget reads the wrong key"; they can only say the thing feels useless, and that sentence is indistinguishable from taste.*
> **THE CHEAP FORM: when a user says something is not useful, ask WHAT IT SHOWS THEM RIGHT NOW — before agreeing, before improving it, before opening a design conversation.** *Zero-versus-wrong is one question away and nobody asks it, because "it adds no value" invites redesign rather than measurement.*
> **Everything we instrument reads MACHINE state. The one channel that observes the system from where it actually matters is prose, from a human — and we have no instrument on it at all.**
>
> ### **AND THE OTHER HALF OF THE SAME FINDING — WHY THIS CLASS OUTRANKS EVERY OTHER DEFECT:**
> *(analyst, 2026-07-20, arrived at independently and from the opposite end.)*
> **AN INSTRUMENT THAT SUPPLIES A FALSE INPUT DOES NOT PRODUCE A VISIBLE INSTRUMENT FAILURE. IT PRODUCES AN INVISIBLE REASONING FAILURE, ATTRIBUTED TO THE REASONER.**
> *A broken instrument returning NOTHING gets noticed and replaced. One returning a CONFIDENT ZERO gets believed — and the person acting on it looks, to themselves, like someone whose judgement is off.* **Steve was right about the symptom; the board had supplied the reason he could not see.**
> **That is why the user's complaint and the instrument's zero are the same event seen from two ends: he can only report it as his own experience, and the failure presents as his judgement rather than the tool's.**

> ### **A CONTROL THAT CONFIRMS IS NOT A WASTED CONTROL.**
> *(othe, 2026-07-20, on re-testing his own 21-day-old assumption and finding it survived.)* **It is the difference between "I believe X" and "X was true at 14:50Z"** — and he had been running on the first for three weeks while reporting the second. *Report confirming results deliberately; a negative result is a measurement, not a wasted trip.*

> ### **VERIFY BEFORE ACTING, EVEN WHEN AUTHORISED — ESPECIALLY THEN.**
> *(engineer, 2026-07-20, and it is the finding of the whole sequence.)* **He was authorised by chief, after chief had verified analyst's counts, after analyst had filed with line numbers and measurements. He ran verify-by-use as a PRECHECK anyway and REFUSED the change** — it would have broken the page it was meant to fix.
> **THE LAST PERSON IN THE CHAIN WAS THE ONLY ONE WHO VERIFIED BEFORE ACTING. EVERYONE UPSTREAM VERIFIED AFTER.** *Analyst measured, correctly, at the wrong layer. Chief reproduced her counts, correctly, at the same wrong layer — and reproduction of a wrong-layer measurement feels exactly like confirmation.* **Authorisation travels faster than verification, and each hand-off makes the next person LESS likely to check, because the chain behind them looks long and careful.**
> **So: the more authorisation a change carries, the more it needs a precheck — not less.** *A precheck costs minutes. It saved a working page here, and the bug turned out not to exist at all.*

**Narrow rule, keep it narrow:** *a past-tense claim about a file change must be preceded by reading a verification line, and that line must come from a **different command** than the one that made the change.*
