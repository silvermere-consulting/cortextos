import { NextRequest } from 'next/server';
import { execFileSync } from 'child_process';
import { join } from 'path';
import { getFrameworkRoot, getCTXRoot, getOrgs } from '@/lib/config';
import type { UnifiedPendingItem } from '@/lib/types';

export const dynamic = 'force-dynamic';

// Path guard (H4, mirrors api/tasks): frameworkRoot flows into an execFile path.
const SAFE_PATH_REGEX = /^[/\w.-]+$/;

// ---------------------------------------------------------------------------
// GET /api/approvals/unified — the SINGLE-SOURCE approvals feed.
//
// Shells out to `cortextos bus list-pending-approvals-unified` (pending approval
// objects UNION needs_approval-flagged unresolved tasks). The bus verb is the
// one definition; the orchestrator's HEARTBEAT sweep calls the same verb, so the
// union predicate cannot fork into two drifting readers.
//
// THREE-VALUED CONTRACT (chief, 2026-07-27): this route MUST let the page tell
// "zero pending" from "could not read". A shell-out that swallows its own failure
// into an empty list would rebuild the exact bug it fixes — a surface affirming
// completeness while blind. So:
//   - spawn fails / non-zero exit (bus cannot-read) / timeout  -> 503 {status:'error'}
//   - stdout is not a JSON array (unparseable)                 -> 503 {status:'error'}
//   - success                                                  -> 200 {status:'ok', items}
// The page renders 'error' as an explicit "approvals unavailable" state, never
// "all caught up". items:[] on 200 is a genuine, read-confirmed empty.
// ---------------------------------------------------------------------------

export async function GET(_request: NextRequest) {
  const frameworkRoot = getFrameworkRoot();
  if (!frameworkRoot || !SAFE_PATH_REGEX.test(frameworkRoot)) {
    console.error('[api/approvals/unified] Invalid CTX_FRAMEWORK_ROOT:', frameworkRoot);
    // A misconfigured server is cannot-read, not empty.
    return Response.json(
      { status: 'error', reason: 'Server misconfigured (framework root)' },
      { status: 503 },
    );
  }

  const instanceId = process.env.CTX_INSTANCE_ID ?? 'default';
  const env = {
    ...process.env,
    CTX_FRAMEWORK_ROOT: frameworkRoot,
    CTX_ROOT: getCTXRoot(),
    CTX_INSTANCE_ID: instanceId,
    CTX_AGENT_NAME: 'dashboard',
    // --all-orgs makes the verb scan every org; CTX_ORG only satisfies env
    // resolution, so any real org works.
    CTX_ORG: getOrgs()[0] || '',
  };

  const cliPath = join(frameworkRoot, 'dist', 'cli.js');
  const args = ['bus', 'list-pending-approvals-unified', '--all-orgs', '--format', 'json'];

  let raw: string;
  try {
    raw = execFileSync(process.execPath, [cliPath, ...args], {
      encoding: 'utf-8',
      timeout: 10000,
      env,
    });
  } catch (err) {
    // Spawn failure, non-zero exit (the bus verb's own cannot-read), or timeout.
    // NONE of these may render as "empty" — that is the bug we are fixing.
    console.error('[api/approvals/unified] cannot-read (spawn/exit/timeout):', err);
    return Response.json(
      { status: 'error', reason: 'Could not read the approvals store' },
      { status: 503 },
    );
  }

  let items: UnifiedPendingItem[];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) throw new Error('expected a JSON array');
    items = parsed as UnifiedPendingItem[];
  } catch (err) {
    // Unparseable output is cannot-read, not empty.
    console.error('[api/approvals/unified] cannot-read (unparseable output):', err);
    return Response.json(
      { status: 'error', reason: 'Approvals store returned unreadable output' },
      { status: 503 },
    );
  }

  return Response.json({ status: 'ok', items });
}
