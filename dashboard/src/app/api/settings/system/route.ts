import { NextRequest } from 'next/server';
import fs from 'fs';
import path from 'path';
import { CTX_ROOT } from '@/lib/config';

export const dynamic = 'force-dynamic';

interface SystemConfig {
  // RECONCILE NOTE (2026-06-29): this field is persisted by the settings UI but is NOT read by
  // any health computation. Fleet health is interval-aware (2x each agent's loop_interval, floor
  // 30min) in api/agents/fleet-health/route.ts + lib/data/heartbeats.ts — that is the single
  // source of truth. Do NOT wire this flat value into staleness: the default 120 is in *seconds*
  // (2min), which would re-introduce the exact false-amber bug we just fixed for idle hourly
  // agents. Kept only as a dormant manual-override hook; left a no-op deliberately.
  heartbeatStalenessThreshold: number;
  maxCrashesPerDay: number;
  sessionRefreshInterval: number;
}

const DEFAULT: SystemConfig = {
  heartbeatStalenessThreshold: 120,
  maxCrashesPerDay: 5,
  sessionRefreshInterval: 300,
};

const CONFIG_PATH = path.join(CTX_ROOT, 'config', 'dashboard-settings.json');

function readConfig(): SystemConfig {
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      return { ...DEFAULT, ...JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8')) };
    }
  } catch { /* fallback */ }
  return { ...DEFAULT };
}

export async function GET(_request: NextRequest) {
  try {
    return Response.json({ config: readConfig() });
  } catch (err) {
    console.error('[api/settings/system] GET error:', err);
    return Response.json({ error: 'Failed to fetch system config' }, { status: 500 });
  }
}

export async function PUT(request: NextRequest) {
  try {
    const body = await request.json();
    const current = readConfig();
    const updated: SystemConfig = {
      heartbeatStalenessThreshold: Math.max(10, Math.min(3600, Math.round(body.heartbeatStalenessThreshold ?? current.heartbeatStalenessThreshold))),
      maxCrashesPerDay: Math.max(1, Math.min(100, Math.round(body.maxCrashesPerDay ?? current.maxCrashesPerDay))),
      sessionRefreshInterval: Math.max(30, Math.min(3600, Math.round(body.sessionRefreshInterval ?? current.sessionRefreshInterval))),
    };
    fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(updated, null, 2), 'utf-8');
    return Response.json({ success: true, config: updated });
  } catch (err) {
    console.error('[api/settings/system] PUT error:', err);
    return Response.json({ error: 'Failed to save system config' }, { status: 500 });
  }
}
