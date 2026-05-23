/**
 * heartbeat-staleness.ts — shared staleness calculation for agent heartbeats.
 *
 * Audit 2026-05-22 (observability) found 3 places computing staleness with
 * inconsistent thresholds (5h flat in metrics.ts, 2h flat in bus.ts:506,
 * 5h flat in the dashboard) — and none were per-agent-interval-aware, so a
 * 4h-cadence agent (writer) showed false-STALE while a 1h-cadence agent could
 * miss ~5 heartbeats before flagging. Unified here.
 *
 * Algorithm: stale if age > 2 × loop_interval. If loop_interval is empty or
 * unparseable, fall back to a default (5h) — preserving prior behaviour for
 * agents that never stamped an interval.
 */

const DEFAULT_FALLBACK_MS = 5 * 60 * 60 * 1000; // 5h
const STALENESS_MULTIPLIER = 2;

/**
 * Parse an interval string ('1h', '4h', '30m', '24h', '1d', '90s') to ms.
 * Returns null for empty / cron expressions / unrecognised forms — caller
 * should use the default fallback.
 */
export function parseIntervalMs(interval: string | undefined | null): number | null {
  if (!interval) return null;
  const m = interval.trim().match(/^(\d+)\s*([smhd])$/i);
  if (!m) return null;
  const n = parseInt(m[1], 10);
  switch (m[2].toLowerCase()) {
    case 's': return n * 1000;
    case 'm': return n * 60 * 1000;
    case 'h': return n * 60 * 60 * 1000;
    case 'd': return n * 24 * 60 * 60 * 1000;
    default: return null;
  }
}

/**
 * Compute the staleness threshold (in ms) for an agent given its loop_interval.
 * Falls back to 5h when interval is missing/unparseable.
 */
export function stalenessThresholdMs(loopInterval: string | undefined | null): number {
  const ms = parseIntervalMs(loopInterval);
  return ms !== null ? ms * STALENESS_MULTIPLIER : DEFAULT_FALLBACK_MS;
}

/**
 * Check whether a heartbeat is stale, using per-agent loop_interval awareness.
 *
 * @param lastHeartbeatISO last_heartbeat field from heartbeat.json (ISO 8601)
 * @param loopInterval     loop_interval field ('1h', '4h', ...) — may be empty
 * @param nowMs            optional override for `Date.now()` (for tests)
 */
export function isHeartbeatStale(
  lastHeartbeatISO: string | undefined | null,
  loopInterval: string | undefined | null,
  nowMs: number = Date.now(),
): boolean {
  if (!lastHeartbeatISO) return true;
  const lastMs = new Date(lastHeartbeatISO).getTime();
  if (!Number.isFinite(lastMs)) return true;
  return (nowMs - lastMs) > stalenessThresholdMs(loopInterval);
}
