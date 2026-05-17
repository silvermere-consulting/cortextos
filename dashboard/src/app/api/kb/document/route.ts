import { NextRequest } from 'next/server';
import { readFileSync, existsSync } from 'fs';
import path from 'path';
import os from 'os';
import { getCTXRoot, getFrameworkRoot } from '@/lib/config';

export const dynamic = 'force-dynamic';

/**
 * GET /api/kb/document?path=<absolute-path>&org=<org>
 *
 * Returns the full content of a KB source document.
 * Security: only files under CTX_ROOT or frameworkRoot/orgs/ are served.
 *
 * Response: { content: string, filename: string, ext: string }
 */
export async function GET(request: NextRequest) {
  const { searchParams } = request.nextUrl;
  const filePath = searchParams.get('path') ?? '';
  const org = searchParams.get('org') ?? '';

  if (!filePath) {
    return Response.json({ error: 'path parameter required' }, { status: 400 });
  }
  if (org && !/^[a-z0-9_-]+$/.test(org)) {
    return Response.json({ error: 'Invalid org' }, { status: 400 });
  }

  // Resolve to absolute, normalised path (prevents traversal via ../)
  const resolved = path.resolve(filePath);

  // Allowlist: only serve files under CTX_ROOT or frameworkRoot/orgs/
  const ctxRoot = path.resolve(getCTXRoot());
  const frameworkOrgs = path.resolve(path.join(getFrameworkRoot(), 'orgs'));
  const homeDir = os.homedir();
  const cortextosRoot = path.resolve(path.join(homeDir, '.cortextos'));

  const allowed =
    resolved.startsWith(ctxRoot + path.sep) ||
    resolved.startsWith(frameworkOrgs + path.sep) ||
    resolved.startsWith(cortextosRoot + path.sep);

  if (!allowed) {
    return Response.json({ error: 'Path not within allowed directories' }, { status: 403 });
  }

  if (!existsSync(resolved)) {
    return Response.json({ error: 'File not found' }, { status: 404 });
  }

  let content: string;
  try {
    content = readFileSync(resolved, 'utf-8');
  } catch {
    return Response.json({ error: 'Could not read file' }, { status: 500 });
  }

  const filename = path.basename(resolved);
  const ext = path.extname(filename).slice(1).toLowerCase();

  return Response.json({ content, filename, ext, path: resolved });
}
