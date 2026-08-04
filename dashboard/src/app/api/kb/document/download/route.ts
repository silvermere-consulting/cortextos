import { NextRequest } from 'next/server';
import { readFileSync } from 'fs';
import path from 'path';
import { guardKbPath, BINARY_DOC_EXTS } from '@/lib/kb-path-guard';

export const dynamic = 'force-dynamic';

const MIME: Record<string, string> = {
  pdf:  'application/pdf',
  png:  'image/png',
  jpg:  'image/jpeg',
  jpeg: 'image/jpeg',
  gif:  'image/gif',
  svg:  'image/svg+xml',
  webp: 'image/webp',
  ico:  'image/x-icon',
};

/**
 * GET /api/kb/document/download?path=<absolute-path>&org=<org>
 *
 * Serves binary KB documents (PDFs, images) with correct Content-Type.
 *
 * Security: same shared guard as /api/kb/document (guardKbPath), with the
 * BINARY servable-extension set — the resolved path must sit under
 * <root>/orgs[/<org>], must not be a credential-shaped file, and must carry a
 * servable binary-document extension. See src/lib/kb-path-guard.ts.
 */
export async function GET(request: NextRequest) {
  const { searchParams } = request.nextUrl;
  const filePath = searchParams.get('path') ?? '';
  const org = searchParams.get('org') ?? '';

  const guard = guardKbPath(filePath, org, BINARY_DOC_EXTS);
  if (!guard.ok) {
    return Response.json({ error: guard.error }, { status: guard.status });
  }
  const resolved = guard.resolved;

  const ext = path.extname(resolved).slice(1).toLowerCase();
  const contentType = MIME[ext] ?? 'application/octet-stream';
  const filename = path.basename(resolved);

  let buffer: Buffer;
  try {
    buffer = readFileSync(resolved);
  } catch {
    return Response.json({ error: 'Could not read file' }, { status: 500 });
  }

  return new Response(new Uint8Array(buffer), {
    headers: {
      'Content-Type': contentType,
      'Content-Disposition': `inline; filename="${filename}"`,
      'Content-Length': String(buffer.length),
      'Cache-Control': 'private, max-age=60',
    },
  });
}
