# Watchdog wedge-sim — deploy-window runbook (task_1784498912934)

**Purpose.** Live verify-by-effect of the freeze-escalation fix (commit `6f1df99`): when the
wedged agent IS the orchestrator (chief), rung-3 escalation must page the operator Telegram chat.
Until the daemon is restarted on the new build, the fleet is **UNGUARDED in exactly this case** —
the ticket reads fixed, the alarm still cannot reach a human.

**The ask to Steve (its own line, never bundled to the router split — chief ruling 2026-07-20):**
one daemon restart on current `main` + ~20 minutes of controlled sim in the same window. All
agents cycle once at the restart (~2 min, standard deploy notice). Chief gets restarted 2–3 more
times during the sim and rung 2 wipes his context by design — running the sim immediately after
the deploy restart makes that wipe nearly free (his context is minutes old).

**What Steve will see:** one 🚨 `WATCHDOG ESCALATION` message on the operator chat, pre-announced
as a drill. **His confirmation that he saw it IS the closure criterion** (R6) — the harness can
only prove the daemon sent it.

## Sequence

1. **Pre-deploy notice** (deployment protocol): Telegram to Steve + group chat, wait 30s.
2. **Deploy:** commit-clean tree → `npm run typecheck` → `npm test` → `npm run build` →
   `pm2 restart cortextos-daemon` (this is the gated step Steve's yes authorizes).
3. **Sim:** `bash orgs/silvermere-tech/scripts/watchdog-wedge-sim.sh --announced`
   - Preflight refuses unless the RUNNING daemon post-dates a dist that contains the fix symbol
     (known-positive + known-negative grep, proc-start vs dist-mtime — no green ticks on the old
     program).
   - Phase 1: temporary short watchdog profile (env at daemon restart; values pinned at
     construction — verified: `envNum()` is the only read path, src/daemon/index.ts:382-386) +
     chief heartbeat cron temporarily `2m` (real scheduler fires; `test-cron-fire` writes no
     fired-rows and is useless as stimulus — verified in ipc-server.ts).
   - Phase 2: SIGSTOP chief's claude process; re-STOP each watchdog respawn (rung 1, rung 2)
     until the rung-3 `watchdog_recovery_failed escalated:true` event lands.
   - Phase 3: assert the daemon log line `Watchdog escalation sent to operator chat`, then wait
     for Steve's "seen it".
4. **Structural restore — runs in an EXIT trap, not from memory (chief ruling):** SIGCONT +
   clean chief restart; heartbeat schedule restored from the value captured at start and
   re-read back; daemon restarted with CTX_WATCHDOG_* explicitly unset; then the asserts:
   - **Known-good control first:** the env probe must FIRE on a process known to carry
     CTX_WATCHDOG_* — otherwise every absence verdict below is VOID (failure string of a bare
     grep is identical to its success string).
   - `/proc/<new daemon pid>/environ` absence of CTX_WATCHDOG_* via resolve-probe semantics
     (unreadable/wrong-pid = TARGET-UNRESOLVABLE, never "clean").
   - **`~/.pm2/dump.pm2` byte check** — pm2 persists the calling shell env; a leaked sim var
     would resurrect the short profile on any later `pm2 resurrect`.
   - Production start-line echo (`check 60s, grace 10m, N=2`) as the human-readable record.
   - Collateral check: no non-chief agent got watchdog-restarted during the sim.
   The harness cannot exit 0 unless every restore assert is green.

## Failure handling
- No escalation within 20 min → sim FAILs loud; restore still runs; read chief's events file +
  daemon log. Do not retry blind — the ladder state (rolling-hour attempts) needs the hour to
  clear or a daemon restart.
- `OPERATOR PAGE FAILED` in the daemon log → getOperatorChatCreds found no usable chat: check
  CTX_OPERATOR_CHAT_ID/CTX_OPERATOR_BOT_TOKEN or first-agent .env fallback. That outcome is
  itself a finding (the fallback path is what a real 3am incident would use).

## What this does NOT verify
- Arrival when Telegram itself is down (send rc=0 is the daemon's horizon).
- The orchestrator-normal branch (already exercised in production by past escalations and by
  unit tests both directions; the sim spends its budget on the branch that has never fired).
