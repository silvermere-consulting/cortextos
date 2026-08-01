---
name: mcp-health-check
description: "Run at session start (and optionally first heartbeat) if any of your crons or tasks depend on claude.ai MCP connectors (Gmail, Google Calendar, Google Drive, Zoho, Atlassian, Canva). Makes a REAL connector call — not schema discovery — so an outage surfaces at boot instead of being found by accident mid-task. Built after a full day of family Gmail crons (school-email-scan, gmail-inbox-digest, ukpostbox-monitor) silently skipped when all connectors dropped post-restart and nobody noticed until mid-task."
triggers: ["mcp health check", "mcp-health-check", "check mcp connectors", "are my connectors up", "mcp outage", "connector health", "gmail connector down", "mcp flap"]
external_calls: ["mcp__claude_ai_Gmail__list_labels", "mcp__claude_ai_Google_Calendar__list_calendars"]
---

# MCP Connector Health Check

## Why this exists

claude.ai MCP connectors (Gmail/Calendar/Drive/Zoho/Atlassian/Canva) are **claude.ai-hosted and bound to the session process**, re-negotiated at EVERY session start. A daemon restart cycles every agent PTY → each respawn tears down and re-handshakes MCP. Most recover; a burst of restarts maximises the odds one session lands **without** them. When that happens to an agent whose crons call Gmail, those crons fail silently and the outage is discovered mid-task, hours later.

**This check moves that discovery to boot.**

## THE ONE RULE: a real call, never schema discovery

`ToolSearch("select:mcp__claude_ai_Gmail__list_labels")` resolving the **schema** does NOT mean the connector works. Discoverability != working — this was confirmed the hard way: the schema loaded while the connector was dead. **You must make the CALL and see real data come back.** A check that only loads the schema is a check that looks like a check and performs none.

## The probe (run at session start, before any MCP-dependent cron can fire)

One connector canaries the whole binding — they share the session handshake, so they go down and come back **together**. Gmail is the canary (it's what the family crons depend on):

1. Load the tool: `ToolSearch("select:mcp__claude_ai_Gmail__list_labels")`
2. **Call it for real:** `mcp__claude_ai_Gmail__list_labels` with `pageSize: 5`
3. Evaluate the PASS predicate:
   - **PASS** = the call returns a `labels` array with real entries (e.g. `INBOX` with a non-zero `messagesTotal`).
   - **FAIL** = any of: the tool can't be loaded/called, the call errors (auth/transport), or the payload is empty/error-shaped.
4. (Optional, stronger signal) repeat with `mcp__claude_ai_Google_Calendar__list_calendars` (`pageSize: 5`) — a second independent connector confirms it's the whole binding, not one connector.

Reference PASS shape (measured 2026-08-01): `list_labels` → `{"labels":[{"labelId":"INBOX","messagesTotal":2368,...}, ...]}`; `list_calendars` → `{"calendars":[{"id":"...@gmail.com",...}]}`.

## On PASS

Silent by default. Optionally log a health event so the green is on the record:
```bash
cortextos bus log-event action mcp_health info --meta '{"agent":"'$CTX_AGENT_NAME'","connectors":"up","probe":"gmail.list_labels"}'
```

## On FAIL — alert, then remedy

The bus CANNOT make the MCP call (the node CLI has no MCP context) — but it carries the ALERT once you (the agent) have the result:

1. **Log it:**
   ```bash
   cortextos bus log-event action guardrail_triggered info --meta '{"guardrail":"mcp_connectors_down","context":"session-start probe: gmail.list_labels returned no data","agent":"'$CTX_AGENT_NAME'"}'
   ```
2. **Alert the human** (day mode) / hold to memory (night mode), so a Gmail-cron owner knows before the crons silently skip:
   ```bash
   cortextos bus send-telegram $CTX_TELEGRAM_CHAT_ID "MCP connectors down at boot (gmail probe returned nothing). Gmail-dependent crons will skip until fixed. Applying the confirmed remedy: hard-restart to re-handshake MCP."
   ```
3. **Remedy — hard-restart re-negotiates the handshake** (confirmed 2026-07-20 and again 2026-08-01, twice now):
   ```bash
   cortextos bus hard-restart --reason "MCP connectors down at boot — re-handshake"
   ```
   After the restart, re-run the probe to confirm recovery (verify by effect: the call returns data, not just that the schema loads again).

## The boundary (do NOT hard-restart-loop)

If a **fully fresh** session STILL returns no connector data **while claude.ai shows the connectors connected**, that is a **claude.ai-side bug, not ours** — escalate to Steve to raise with Anthropic; do not keep restarting. One hard-restart is the remedy; a second identical failure is a finding, not a retry.

## Where to wire it

- **Session start**, as an early step for any agent with MCP-dependent crons — before those crons can fire. (Primary: jones, for the Gmail crons.)
- Optionally the **first heartbeat** of a session as a backstop.
- Keep the blast radius honest: this probes the connector binding, not each specific cron's end-to-end path.
