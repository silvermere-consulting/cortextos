import { NextRequest } from 'next/server';
import { readFileSync } from 'fs';
import path from 'path';
import { guardKbPath, TEXT_DOC_EXTS } from '@/lib/kb-path-guard';

export const dynamic = 'force-dynamic';

/**
 * GET /api/kb/document?path=<absolute-path>&org=<org>
 *
 * Returns the full TEXT content of a KB source document.
 *
 * Security: access is gated by the shared guardKbPath() — the resolved path must
 * sit under <root>/orgs[/<org>], must not be a credential-shaped file, and must
 * carry a servable text-document extension. See src/lib/kb-path-guard.ts. The
 * guard is shared with /api/kb/document/download so the rule lives in one place.
 *
 * Response: { content: string, filename: string, ext: string, path: string }
 */
export async function GET(request: NextRequest) {
  const { searchParams } = request.nextUrl;
  const filePath = searchParams.get('path') ?? '';
  const org = searchParams.get('org') ?? '';

  const guard = guardKbPath(filePath, org, TEXT_DOC_EXTS);
  if (!guard.ok) {
    return Response.json({ error: guard.error }, { status: guard.status });
  }
  const resolved = guard.resolved;

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
