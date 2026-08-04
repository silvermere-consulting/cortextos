import { existsSync } from 'fs';
import path from 'path';
import { getCTXRoot, getFrameworkRoot } from '@/lib/config';

/**
 * Shared access guard for the KB document endpoints (/api/kb/document and
 * /api/kb/document/download). ONE guard, both callers — so the rule cannot be
 * reinvented (or forgotten) per endpoint.
 *
 * Four independent checks, in order:
 *  (a) LOCATION — the resolved path must sit under an `orgs/` subtree of an
 *      allowed root (frameworkRoot or CTX_ROOT). NOT the whole repo, NOT all of
 *      ~/.cortextos. path.resolve() has already collapsed any `../`, so this is
 *      a containment check, not a traversal check.
 *  (b) ORG SCOPE — when an org is supplied it is USED, not just shape-validated:
 *      reads are confined to <root>/orgs/<org>/. A family-org session cannot
 *      read silvermere-tech paths and vice versa.
 *  (c) DENY BY NAME — credential-shaped files are refused regardless of where
 *      they sit or what extension they carry (secrets.env lives *under* orgs/,
 *      so location-narrowing alone does not exclude it — this does).
 *  (d) SERVABLE EXTENSION — only known document types. Config/data types that
 *      routinely carry secrets (.json service-accounts, .yml configs, .env) are
 *      NOT servable; ambiguous types are denied by default.
 *
 * The header comment on the old routes claimed "only files under CTX_ROOT or
 * frameworkRoot/orgs/ are served" while the code allowed all of frameworkRoot.
 * This makes the code do what that comment said.
 */

export type KbGuardResult =
  | { ok: true; resolved: string }
  | { ok: false; status: number; error: string };

// (c) Refused by exact name, any location, any extension.
const DENY_NAME = /^(secrets\.env|\.env|\.htpasswd|\.htaccess|\.netrc|\.git-credentials)$/i;
// (c) Refused by shape, any location. NB: a credential class is not one regex —
// this is a floor (dotfiles + key/cert shapes), not the sole control; the
// extension allowlist (d) is the complementary ceiling.
const DENY_SHAPE: RegExp[] = [
  /^\./, // any dotfile (.env, .git*, .npmrc, …)
  /\.pem$/i,
  /\.key$/i,
  /\.p12$/i,
  /\.pfx$/i,
  /\.keystore$/i,
  /\.crt$/i,
  /^id_[a-z0-9]+$/i, // ssh private keys: id_rsa, id_ed25519, …
];

// (d) Servable document types.
export const TEXT_DOC_EXTS: readonly string[] = [
  'md', 'markdown', 'mdx', 'txt', 'text', 'csv', 'tsv', 'html', 'htm', 'log', 'rst',
];
export const BINARY_DOC_EXTS: readonly string[] = [
  'pdf', 'png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'ico',
];

export function guardKbPath(
  filePath: string,
  org: string,
  allowedExts: readonly string[],
): KbGuardResult {
  if (!filePath) return { ok: false, status: 400, error: 'path parameter required' };
  if (org && !/^[a-z0-9_-]+$/.test(org)) return { ok: false, status: 400, error: 'Invalid org' };

  // Resolve to an absolute, normalised path (collapses any ../).
  const resolved = path.resolve(filePath);

  // (a)+(b) LOCATION + ORG SCOPE: must be under <root>/orgs[/<org>].
  const roots = [getFrameworkRoot(), getCTXRoot()].map((r) => path.resolve(r));
  const bases = roots.map((r) => (org ? path.join(r, 'orgs', org) : path.join(r, 'orgs')));
  const underAllowed = bases.some((b) => resolved === b || resolved.startsWith(b + path.sep));
  if (!underAllowed) {
    return { ok: false, status: 403, error: 'Path not within allowed directories' };
  }

  const base = path.basename(resolved);

  // (c) DENY BY NAME/SHAPE — credential-shaped files, any location/extension.
  if (DENY_NAME.test(base) || DENY_SHAPE.some((rx) => rx.test(base))) {
    return { ok: false, status: 403, error: 'File type not permitted' };
  }

  // (d) SERVABLE EXTENSION — known document types only.
  const ext = path.extname(resolved).slice(1).toLowerCase();
  if (!allowedExts.includes(ext)) {
    return { ok: false, status: 403, error: 'File type not permitted' };
  }

  if (!existsSync(resolved)) return { ok: false, status: 404, error: 'File not found' };
  return { ok: true, resolved };
}
