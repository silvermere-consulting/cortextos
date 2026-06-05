'use server';

import { spawnSync } from 'child_process';
import path from 'path';
import { revalidatePath } from 'next/cache';
import { getFrameworkRoot, getCTXRoot } from '@/lib/config';
import { syncAll } from '@/lib/sync';
import { getApprovalById } from '@/lib/data/approvals';
import { issueFoundryToken, rejectFoundryApproval } from '@/lib/foundry';
import type { ActionResult } from '@/lib/types';

// ---------------------------------------------------------------------------
// Server Actions
// ---------------------------------------------------------------------------

/**
 * Resolve an approval by shelling out to bus/update-approval.sh.
 * Revalidates the approvals and overview pages after resolution.
 */
export async function resolveApproval(
  id: string,
  decision: 'approved' | 'rejected',
  note?: string,
): Promise<ActionResult> {
  // Validate inputs
  if (!id || !/^[a-zA-Z0-9_-]+$/.test(id)) {
    return { success: false, error: 'Invalid approval ID' };
  }

  if (!['approved', 'rejected'].includes(decision)) {
    return { success: false, error: 'Decision must be "approved" or "rejected"' };
  }

  if (note && note.length > 1000) {
    return { success: false, error: 'Note must be 1000 characters or fewer' };
  }

  // If the approval is a Foundry-bridged kind (carries metadata.foundry_approval_id),
  // call Foundry first. The minted token (or rejection reason) is woven into the
  // resolution note so the requesting agent's inbox message carries it via the
  // existing bus path. The Foundry call MUST succeed before we resolve the
  // cortextos record — otherwise an "approved" status would be visible to the
  // caller with no token, which is the silent-failure mode we explicitly avoid.
  const approval = getApprovalById(id);
  const foundryApprovalId = approval?.metadata?.foundry_approval_id;
  let resolutionNote = note;
  if (typeof foundryApprovalId === 'string' && foundryApprovalId.length > 0) {
    try {
      if (decision === 'approved') {
        const issued = await issueFoundryToken(foundryApprovalId);
        const tokenLine = `foundry_token=${issued.token}`;
        const expiresLine = `foundry_token_expires_at=${issued.expires_at}`;
        const jtiLine = `foundry_jti=${issued.jti}`;
        resolutionNote = note
          ? `${note}\n${tokenLine}\n${expiresLine}\n${jtiLine}`
          : `${tokenLine}\n${expiresLine}\n${jtiLine}`;
      } else {
        await rejectFoundryApproval(foundryApprovalId, note);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error('[actions/approvals] foundry bridge error:', message);
      return { success: false, error: `Foundry bridge: ${message}` };
    }
  }

  const frameworkRoot = getFrameworkRoot();
  const env = {
    ...process.env,
    CTX_FRAMEWORK_ROOT: frameworkRoot,
    CTX_ROOT: getCTXRoot(),
    CTX_AGENT_NAME: 'dashboard',
  };

  const args: string[] = [id, decision];
  if (resolutionNote) args.push(resolutionNote);

  try {
    const result = spawnSync(
      'bash',
      [path.join(frameworkRoot, 'bus', 'update-approval.sh'), ...args],
      { encoding: 'utf-8', timeout: 10000, env, stdio: 'pipe' },
    );
    if (result.status !== 0) {
      throw new Error(result.stderr || result.stdout || 'update-approval.sh failed');
    }

    // Sync so SQLite reflects the change
    try {
      syncAll();
    } catch {
      // Sync is best-effort
    }

    // Revalidate pages that show approval data
    revalidatePath('/approvals');
    revalidatePath('/'); // Overview "Action Required" section

    return { success: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[actions/approvals] resolveApproval error:', message);
    return { success: false, error: message };
  }
}
