// Next.js instrumentation hook — register() runs ONCE at server boot (Next 15+/16
// stable, no flag). Starts the AUTONOMOUS sync timer so the dashboard's SQLite
// cache refreshes WITHOUT an authed request (task_1786076594927 / ⑰).
//
// The bug it closes: syncAll() ran only on authed page loads + an SSE-started
// watcher, so the cache was guaranteed STALEST exactly when nobody was watching.
// This trigger is in-process (the dashboard is a persistent next-server under
// pm2 — verified), fires every `interval_ms` from the shared config, and writes
// a per-run receipt. Its liveness is judged by the analyst's absence-watcher
// against ITS OWN clock (owed = wallclock/interval anchored at enabled_since),
// never against any record this trigger writes — see sync-receipt.ts.

let started = false; // dup-timer guard: register() can fire more than once per process

export async function register() {
  // Only the nodejs runtime has fs + a long-lived process for setInterval.
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;
  if (started) return;
  started = true;

  const { readSyncConfig, writeSyncReceipt } = await import('@/lib/sync-receipt');
  const { syncAll } = await import('@/lib/sync');

  const cfg = readSyncConfig();
  if (!cfg) {
    // Fail-safe: no config (or missing interval_ms/enabled_since) => do NOT run.
    // The operator writes the config at deploy (with enabled_since, so a dead-from-
    // birth trigger still leaves the watcher an anchor). Absent config reads to the
    // watcher as CANNOT_TELL, not a clean pass — so silence here is never mistaken
    // for health.
    console.error(
      '[dashboard-sync] no sync-config.json with interval_ms+enabled_since — autonomous sync NOT started. Write the config at deploy to activate.',
    );
    return;
  }

  const runOnce = () => {
    const start = Date.now();
    try {
      const r = syncAll();
      const rows = r.tasks + r.approvals + r.events + r.heartbeats;
      writeSyncReceipt(cfg, {
        ts: new Date().toISOString(),
        ok: true,
        rows_synced: rows,
        duration_ms: Date.now() - start,
      });
    } catch (e) {
      // A failed run still writes a receipt: ok:false (ran-and-failed) must be
      // DISTINCT from ABSENT (didn't run) on the watcher's side.
      writeSyncReceipt(cfg, {
        ts: new Date().toISOString(),
        ok: false,
        rows_synced: 0,
        error: e instanceof Error ? e.message : String(e),
        duration_ms: Date.now() - start,
      });
    }
  };

  // Fire once at boot (a receipt exists promptly), then on the configured cadence.
  runOnce();
  const timer = setInterval(runOnce, cfg.interval_ms);
  // Don't keep the event loop alive solely for this timer; the next-server stays
  // up on its own, so the timer still fires — this just allows a clean shutdown.
  if (typeof timer.unref === 'function') timer.unref();

  console.log(
    `[dashboard-sync] autonomous sync started: every ${cfg.interval_ms}ms -> ${cfg.receipt_path ?? 'default sync-runs.jsonl'}`,
  );
}
