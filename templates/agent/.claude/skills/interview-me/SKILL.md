---
name: interview-me
description: "Brainstorming or scoping is done but real ambiguity still sits between the brief and what the work actually needs — and the gaps are things only Steven or the client can resolve, not the codebase. Close them by surfacing the open decisions as a tight, prioritised options-list routed through the orchestrator: architecture-changing questions first, each with 2-3 concrete options and your recommendation, never a blank-page question. This codifies our existing house style (convert open questions into pick-lists; don't punt blank decisions upward) into a repeatable pre-work step, adapted for async Telegram comms."
triggers: ["interview me", "interview", "scope this", "resolve ambiguity", "open questions", "clarify the brief", "pick-list", "options and recommendation", "what do you need to know", "questions before i build", "nail down the spec", "decision list", "surface the decisions", "convert to options", "ambiguity remains", "before planning"]
---

# Interview me

Scoping is over and gaps remain between the brief (the map) and what the work needs (the territory). Close them by surfacing the open decisions — but **do not ask what our own codebase, KB, or memory can already answer; go look first.** Only genuine human-decisions (Steven's or a client's call) get surfaced.

Adapted for our fleet: our comms are async over Telegram and specialists route through the orchestrator, so this is **not** a rapid one-question-at-a-time live loop. It is a *prioritised, batched pick-list* — architecture-changers first, options + a recommendation on each, sent up in a small round the orchestrator can relay and get answered in one pass. This is our "hustle on open questions / don't punt blank-page decisions" rule, operationalised.

## Steps

1. **Read everything already established** — the brief, any spec, prototypes, relevant code, KB entries, feedback-memory. Do not re-ask anything already answered.
2. **Build a private list of open ambiguities and sort by blast radius:**
   - **First: architecture-changers** — answers that would alter the data model, interfaces, scope, or the overall approach.
   - **Then: behaviour definers** — edge cases, failure modes, defaults, permissions.
   - **Last: polish** — naming, copy, cosmetics. Usually not worth a human's time: propose a sensible default and move on.
3. **Anything the codebase/KB can answer, answer it yourself.** Only human-decisions survive to the next step.
4. **Surface the surviving questions as a pick-list through the orchestrator**, highest-blast-radius first. For each: one line of context on why it matters, 2-3 concrete options, and your recommendation. Accept "you decide" as an answer you then own. **Batch a small round** (not a drip of single messages) — respect that Steven answers async and shouldn't be pinged question-by-question.
5. **Checkpoint decisions.** As answers land, restate what's now decided in one tight list so drift dies early. Sequence any options that are blocked behind an upstream decision, so they aren't asked prematurely.
6. **Stop when the remaining unknowns are cheaper to discover during the work than to ask about now** — and say that out loud. End with the final decision list, ready to paste into a plan or brief.

## Guardrails

- **Never surface directly to Steven or a client** — route every question through the orchestrator (chief for silvermere, jones for family) as a pick-list.
- **Never ask what's discoverable** from our code, KB, or memory. Go look instead.
- **No blank-page questions.** Every question carries options + a recommendation. If you can't propose options, you haven't researched enough yet.
- **Batch, don't drip.** Async comms means a small prioritised round beats question-by-question turn-taking.
- If an answer contradicts an earlier decision, flag the conflict immediately rather than silently taking the newest answer.

---
**When this fires:** after a directive/brief lands but before planning, when the remaining unknowns are human-decisions (Steven's or a client's), not codebase facts. (Retrospective fit: Liwa venture shaping, any new client brief with open scope.)
