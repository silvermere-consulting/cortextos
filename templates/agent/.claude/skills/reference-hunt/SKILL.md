---
name: reference-hunt
description: "You need to build or integrate something whose behaviour is too intricate or too tacit to write down in words — a new API, an SDK, a 'make it work like this library/site' request — but working code somewhere already embodies the requirement. Read that source as the specification: produce a semantics summary (behaviours, guarantees, edge cases, licence) and get it confirmed BEFORE reimplementing, so misreadings get caught cheaply instead of surfacing as a reverse-engineered surprise. This is the fix for our API/integration failure mode, where scope was discovered by live probing after the fact instead of read up front."
triggers: ["reference hunt", "use as reference", "like this library", "like this site", "read the source", "semantics summary", "reimplement", "port this", "new api", "integrate api", "map the api", "read source as spec", "reverse the behavior", "match this behavior", "build it like", "cross-language port", "sdk integration"]
---

# Reference hunt

Some requirements are too intricate or too tacit to write down, but working code somewhere already embodies them. The best reference is not a screenshot or a description — it's **source**. Read it like a spec, confirm your reading, then reimplement the *semantics*, not the syntax.

Adapted for our fleet: this is a **build/integration skill — scope it to the engineer** (specialists like the analyst read the source and produce the semantics summary but do not write the implementation). The confirmation checkpoint routes through the orchestrator. Anything we learn about an external API's shape gets ingested to the KB so the next agent inherits it.

## Steps

1. **Get the reference and pin the dimension.** A repo path, vendored folder, library name, or a site whose code can be read. Ask *what specifically* to extract — behaviour, structure, visual system, API shape / auth model — so you don't imitate the wrong dimension. For a new API, the auth-and-identity model is often the highest-value unknown to nail first.
2. **Read the reference and produce a semantics summary BEFORE writing anything:**
   - the behaviours and guarantees it implements (timing, ordering, error handling, edge cases, auth scope, what identifies a caller/org),
   - the decisions that look deliberate versus incidental,
   - anything that won't translate to our stack, with a proposed equivalent,
   - the **licence** — note it explicitly if extraction beyond semantics is in question.
3. **Confirm the semantics summary** before any implementation — route it through the orchestrator for a yes/confirm. This is the moment misreadings get caught cheaply (it's exactly the checkpoint that would have surfaced an API's token scope *up front* instead of via a live probe).
4. **Reimplement in our stack (engineer):** same semantics, native idioms. Do not transliterate line by line, and do not copy code verbatim from a reference whose licence doesn't allow it.
5. **Close the loop:** list each behaviour from the summary and where our implementation honours it, plus any place we consciously diverged and why. Ingest the API/reference readout to the KB.

## Guardrails

- **The reference defines *what*; our codebase conventions define *how*.**
- **Semantics summary before code — always.** The confirmation checkpoint is the whole point; skipping it is how we end up reverse-engineering scope after the fact.
- **Scope: reading the source + writing the semantics summary is fair game for any agent; writing the implementation is the engineer's job** (specialists surface, engineer builds).
- Respect licences: extracting semantics is fine; copying incompatible code is not. Flag unclear licences rather than assuming.
- If the reference itself is buggy or inconsistent, surface that instead of faithfully reproducing the bug.

---
**When this fires:** new API / SDK / integration, or any "build it like X" request where working source exists to read as the spec. (Retrospective fit: Yoodli API — token scope and orgId were discovered by probing; a semantics-summary-first pass would have surfaced them before build.)
