---
name: blindspot-pass
description: "You (or the org) are about to start work in a domain, client engagement, or codebase area the fleet has NOT operated in before — a new venture, a new client's industry, an unfamiliar API or regulatory space. Before producing the first deliverable, run a blindspot pass: surface the unknown unknowns — the landmines, hidden context, what-good-looks-like, and the questions an expert in that domain would insist on asking — so the work is scoped against the territory, not just the brief. This is the fleet's institutional fix for our most-repeated failure: guessing through an unknown in unfamiliar territory until it becomes an expensive rework."
triggers: ["blindspot pass", "blind spot", "unknown unknowns", "new domain", "new venture", "unfamiliar area", "never done this before", "entering new territory", "what don't we know", "what am i missing", "surface unknowns", "de-risk before start", "regulated domain", "new client industry", "scope a new engagement", "before we build check unknowns"]
---

# Blindspot pass

The fleet is about to work in territory it doesn't know well — a new domain, a new client's industry, an unfamiliar API, a regulated space. **Do not do the task yet.** The job of this pass is to show what we don't know we don't know, so the next prompt, plan, or deliverable is built against the real territory instead of a thin map. This is a *before-work* skill: it ends at understanding.

Adapted for our fleet: we surface findings through the orchestrator (never straight to Steven), we query our own shared memory before exploring outward, and the "questions an expert would ask" become a pick-list the orchestrator can route for a fast decision.

## Steps

1. **Establish the starting point.** Name two things: what we're trying to do, and the fleet's actual experience level in this specific area (usually low — that's why this fired). Our starting point changes everything downstream.
2. **Query our own memory first, then explore outward.** Before external research, check the KB and agent memory (`cortextos bus` knowledge-base + MEMORY / feedback entries) — we may have already learned the landmines here. *Then* explore the territory: the module/history/conventions if it's code; the table-stakes practitioners assume if it's an external or regulated domain (e.g. safeguarding rules for a childcare client, auth model for a new API).
3. **Report back in four sections:**
   - **Landmines** — the mistakes someone new here typically makes, plus any of our own repo/process-specific potholes (deprecated paths, misleading names, half-migrated patterns, prior burns in feedback-memory).
   - **Hidden context** — decisions already made that constrain the work; invariants that must hold; why things are shaped the way they are.
   - **What good looks like** — 2-3 concrete examples of the pattern done well (from our work or external prior art) so we can calibrate quality before producing anything.
   - **Questions an expert would ask** — the 3-5 questions a domain expert would raise before starting, each with our best-guess answer. **Format these as a pick-list** so the orchestrator can route the open ones to Steven/client for a fast decision (options + a recommendation each — never a blank-page question).
4. **End with a rewritten brief** that folds in what was found, so the gap between the original request (the map) and the territory is visible on one screen.

## Guardrails

- **Do not start implementing or producing the deliverable.** This skill ends at understanding. Hand the rewritten brief + open questions back to the orchestrator.
- Prioritise unknowns that would change the *approach or architecture* over trivia.
- **Route open questions through the orchestrator** (chief for silvermere, jones for family) as a pick-list — specialists never surface directly to Steven.
- If the area turns out simpler than feared, say so plainly. "No significant blindspots here — proceed" is a valid, valuable result and saves everyone time.
- Log what you surfaced to the KB so the *next* agent entering this domain inherits it.

---
**When this fires:** any new-domain / new-venture / new-client-industry / unfamiliar-API entry, run before the first deliverable is scoped. (Retrospective fit: Yoodli API scope, Jenevi Educare regulated childcare domain, PYLOT, Liwa venture entry.)
