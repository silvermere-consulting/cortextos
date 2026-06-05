// cortextOS Dashboard — Foundry approvals bridge
// Mints a short-lived dashboard service-account token and calls the Foundry
// approvals service to issue or reject a domain:buy (or other kind-discriminated)
// approval token. The token returned by /issue is forwarded back to the original
// requester via the cortextos approval resolution note (existing inbox path).

import crypto from 'node:crypto';

const FOUNDRY_BASE_URL =
  process.env.FOUNDRY_APPROVALS_URL ?? 'http://127.0.0.1:7113';
const DEFAULT_TENANT = process.env.FOUNDRY_DASHBOARD_TENANT ?? 'silvermere-tech';
const DEFAULT_APPROVER = process.env.FOUNDRY_DASHBOARD_APPROVER ?? 'human:steven';

export interface FoundryIssueResult {
  ok: true;
  approval_id: string;
  token: string;
  jti: string;
  issued_at: string;
  expires_at: string;
}

export interface FoundryError {
  ok: false;
  error: string;
  status?: number;
}

function mintDashboardToken(ttlSeconds = 60): string {
  const secret = process.env.FOUNDRY_TOKEN_SECRET;
  if (!secret) {
    throw new Error('FOUNDRY_TOKEN_SECRET not set in environment');
  }
  const now = new Date();
  const envelope = {
    caller_id: 'dashboard',
    caller_class: 'internal_agent',
    tenant_id: DEFAULT_TENANT,
    issued_at: now.toISOString(),
    expires_at: new Date(now.getTime() + ttlSeconds * 1000).toISOString(),
  };
  const body = Buffer.from(JSON.stringify(envelope)).toString('base64url');
  const sig = crypto.createHmac('sha256', secret).update(body).digest('hex');
  return `${body}.${sig}`;
}

async function foundryPost(
  pathSegment: string,
  body: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const token = mintDashboardToken();
  const res = await fetch(`${FOUNDRY_BASE_URL}${pathSegment}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let parsed: Record<string, unknown> = {};
  try {
    parsed = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(
      `foundry ${pathSegment} returned non-JSON (status ${res.status}): ${text.slice(0, 200)}`,
    );
  }
  if (!res.ok) {
    const err = (parsed.error as string) || `status_${res.status}`;
    const e = new Error(`foundry ${pathSegment} → ${res.status}: ${err}`);
    (e as Error & { status?: number }).status = res.status;
    throw e;
  }
  return parsed;
}

/**
 * Mint a domain:buy approval token via Foundry. Returns the JWT to forward
 * to the original caller via the cortextos resolution-note inbox message.
 */
export async function issueFoundryToken(
  foundryApprovalId: string,
  approver: string = DEFAULT_APPROVER,
): Promise<FoundryIssueResult> {
  const out = await foundryPost(`/v1/approvals/${foundryApprovalId}/issue`, {
    approver,
  });
  return {
    ok: true,
    approval_id: out.approval_id as string,
    token: out.token as string,
    jti: out.jti as string,
    issued_at: out.issued_at as string,
    expires_at: out.expires_at as string,
  };
}

/**
 * Reject a Foundry approval. No token returned.
 */
export async function rejectFoundryApproval(
  foundryApprovalId: string,
  reason: string | undefined,
  approver: string = DEFAULT_APPROVER,
): Promise<{ ok: true; approval_id: string; status: string }> {
  const out = await foundryPost(`/v1/approvals/${foundryApprovalId}/reject`, {
    approver,
    reason: reason ?? '',
  });
  return {
    ok: true,
    approval_id: out.approval_id as string,
    status: out.status as string,
  };
}
