// cortextOS Dashboard — Foundry approvals bridge
// Mints a short-lived dashboard service-account token and calls the Foundry
// approvals service to issue or reject a domain:buy (or other kind-discriminated)
// approval token. The token returned by /issue is forwarded back to the original
// requester via the cortextos approval resolution note (existing inbox path).

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

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

// Resolved once and cached. The dashboard pm2 process does not load
// orgs/<org>/secrets.env at boot, so process.env.FOUNDRY_TOKEN_SECRET is
// typically empty even though the file holds the value. Fall back to a
// disk read scoped to the configured tenant org so secret rotation does
// not require a dashboard restart. process.env always wins when present.
let resolvedSecret: string | null | undefined;

function readSecretFromOrgFile(org: string): string | null {
  const frameworkRoot = process.env.CTX_FRAMEWORK_ROOT;
  if (!frameworkRoot) return null;
  const secretsPath = path.join(frameworkRoot, 'orgs', org, 'secrets.env');
  if (!fs.existsSync(secretsPath)) return null;
  const lines = fs.readFileSync(secretsPath, 'utf-8').split(/\r?\n/);
  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    if (key !== 'FOUNDRY_TOKEN_SECRET') continue;
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    return value.length > 0 ? value : null;
  }
  return null;
}

function getFoundryTokenSecret(): string {
  const fromEnv = process.env.FOUNDRY_TOKEN_SECRET;
  if (fromEnv && fromEnv.length > 0) return fromEnv;
  if (resolvedSecret !== undefined) {
    if (resolvedSecret === null) {
      throw new Error('FOUNDRY_TOKEN_SECRET not set in environment and not found in secrets.env');
    }
    return resolvedSecret;
  }
  resolvedSecret = readSecretFromOrgFile(DEFAULT_TENANT);
  if (!resolvedSecret) {
    throw new Error('FOUNDRY_TOKEN_SECRET not set in environment and not found in secrets.env');
  }
  return resolvedSecret;
}

function mintDashboardToken(ttlSeconds = 60): string {
  const secret = getFoundryTokenSecret();
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
