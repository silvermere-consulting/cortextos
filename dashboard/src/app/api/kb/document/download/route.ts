import { NextRequest } from 'next/server';
import { readFileSync, existsSync } from 'fs';
import path from 'path';
import os from 'os';
import { getCTXRoot, getFrameworkRoot } from '@/lib/config';

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
 * Serves binary files (PDFs, images) with correct Content-Type.
 * Same path allowlist as /api/kb/document — only files under
 * CTX_ROOT, frameworkRoot, or ~/.cortextos are served.
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

  const resolved = path.resolve(filePath);

  const ctxRoot = path.resolve(getCTXRoot());
  const frameworkRoot = path.resolve(getFrameworkRoot());
  const homeDir = os.homedir();
  const cortextosRoot = path.resolve(path.join(homeDir, '.cortextos'));

  const allowed =
    resolved.startsWith(ctxRoot + path.sep) ||
    resolved.startsWith(frameworkRoot + path.sep) ||
    resolved.startsWith(cortextosRoot + path.sep);

  if (!allowed) {
    return Response.json({ error: 'Path not within allowed directories' }, { status: 403 });
  }

  if (!existsSync(resolved)) {
    return Response.json({ error: 'File not found' }, { status: 404 });
  }

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
