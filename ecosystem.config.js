// PM2 ecosystem config for cortextOS daemon.
// Portable: paths resolve at load time relative to this file and the user's home.
// Override any value with environment variables before `pm2 start`.

const path = require('path');
const os = require('os');

const FRAMEWORK_ROOT = process.env.CTX_FRAMEWORK_ROOT || __dirname;
const PROJECT_ROOT = process.env.CTX_PROJECT_ROOT || FRAMEWORK_ROOT;
const INSTANCE_ID = process.env.CTX_INSTANCE_ID || 'default';
const CTX_ROOT = process.env.CTX_ROOT || path.join(os.homedir(), '.cortextos', INSTANCE_ID);
const CTX_ORG = process.env.CTX_ORG || '';

// Authorised Claude Code pin — SINGLE SOURCE OF TRUTH for the version string.
// Roll the fleet by editing this constant; the binary path and the boot-time
// version assertion (CTX_CLAUDE_VERSION_EXPECTED) are both derived from it, so
// they can never disagree. Steve go tg9125 (2026-07-27) chose 2.1.219 for the
// opus-4-8 / sonnet-5 1M window. Rolled to 2.1.226 on 2026-08-09 (Steve go
// tg10436/10447, chief's option-A call): worktree destructive-git containment
// fix (2.1.222); 3b-verified behaviour-neutral (all fleet model IDs recognised
// by 226, auto-compact enforcement never fires). 2.1.219 frozen copy retained
// for revert; 2.1.218 second fallback.
const CLAUDE_VERSION = '2.1.229';  // rolled 226->229 2026-08-13 (Steve go, roll-first ahead of migration: closes live exposure to the 228 session-cleanup memory-folder-delete bug; 3b: no cost-raising default, 229 prefix-stagger lowers spend). 2.1.226 frozen copy is the revert target.
const AUTHORISED_CLAUDE_BIN = path.join(os.homedir(), '.local', 'share', 'claude-code', CLAUDE_VERSION, 'claude.exe');

module.exports = {
  apps: [
    {
      name: 'cortextos-daemon',
      script: path.join(FRAMEWORK_ROOT, 'dist', 'daemon.js'),
      args: `--instance ${INSTANCE_ID}`,
      cwd: FRAMEWORK_ROOT,
      env: {
        CTX_INSTANCE_ID: INSTANCE_ID,
        CTX_ROOT: CTX_ROOT,
        CTX_FRAMEWORK_ROOT: FRAMEWORK_ROOT,
        CTX_PROJECT_ROOT: PROJECT_ROOT,
        CTX_ORG: CTX_ORG,
        // Pin discipline (OOM Track A): agents spawn `claude` by this absolute
        // path (getBinaryName reads it from the daemon env), so PATH order can
        // never surface the user-writable shadow install.
        // Deliberate roll 2026-07-27 (Steve go tg9125, via chief): pinned to a
        // FROZEN 2.1.219 copy (minimal verified step toward Opus 5). Prev roll
        // 2026-07-24 pinned 2.1.218. Frozen copy is a user-owned artifact nothing
        // auto-updates (2.1.219 native build installs to ~/.local/share/claude/
        // versions/ which IS auto-update-capable, so a byte-identical copy is
        // frozen here instead — deliberately NOT the pin target). Grants opus-4-8
        // + sonnet-5 their 1M window. Revert if regressed: edit CLAUDE_VERSION
        // above (frozen 2.1.218 copy exists at .../claude-code/2.1.218/claude.exe).
        //
        // AUTHORITATIVE, not a fallback. This was `process.env.CTX_CLAUDE_BIN ||
        // <default>` until 2026-07-30: on that form an INHERITED env var beat the
        // pin. A pm2 resurrect from a stale ~/.pm2/dump.pm2 (carrying the 07-23
        // Track-A value CTX_CLAUDE_BIN=/usr/bin/claude, i.e. 2.1.141) silently
        // reverted the ENTIRE FLEET three versions on 2026-07-29 23:12:59Z —
        // undetected for hours because every roll since 07-23 had only edited a
        // default that no longer applied (task_1785377221211). The pin now WINS
        // over any inherited env; you roll by editing CLAUDE_VERSION, never by
        // exporting CTX_CLAUDE_BIN. The daemon re-checks this at boot and pages
        // the operator if the resolved binary's --version != CTX_CLAUDE_VERSION_EXPECTED.
        CTX_CLAUDE_BIN: AUTHORISED_CLAUDE_BIN,
        CTX_CLAUDE_VERSION_EXPECTED: CLAUDE_VERSION,
        // Debug-only: set to '1' to enable SIGUSR2 signal → controlled
        // uncaughtException for testing the crash-visibility path
        // (.daemon-crashed markers + crash-loop operator Telegram alert).
        // Leave '0' in production; enable temporarily to reproduce crash
        // paths during development. `kill -SIGUSR2 $(pm2 pid cortextos-daemon)`
        // then watch the operator chat for "🚨 CRITICAL: daemon crash-looping"
        // after 3 crashes in 15 min.
        CTX_DEBUG_ALLOW_CRASH_TRIGGER: '0',
      },
      // max_restarts + restart_delay is the ultimate crash-storm circuit
      // breaker. If the daemon dies 10 times faster than 5s apart, PM2
      // gives up — the fleet goes fully dead, requiring a manual
      // `pm2 restart cortextos-daemon`. That is intentional: storm
      // protection > fleet uptime during a pathological crash loop.
      // The daemon's uncaughtException handler (src/daemon/index.ts)
      // fires a Telegram alert to the operator at 3+ crashes in 15 min —
      // well before this circuit trips. Do NOT raise these values without
      // also strengthening the upstream fix; the 2026-04-22 storm is a
      // reminder that unchecked auto-restart amplifies one bug into a
      // fleet-wide outage.
      max_restarts: 10,
      restart_delay: 5000,
      // BUG-011 fix: raise kill_timeout so PM2 gives the daemon enough time to
      // finish graceful agent shutdown before sending SIGKILL. Default (1600ms)
      // was shorter than daemon stop()'s 20s window, guaranteeing orphaned PTY
      // processes on every pm2 restart. 25s covers the worst-case shutdown path.
      kill_timeout: 25000,
      autorestart: true,
    },
  ],
};
