import { NextRequest } from 'next/server';
import { execFileSync } from 'child_process';
import { existsSync } from 'fs';
import path from 'path';
import os from 'os';
import { getCTXRoot, getFrameworkRoot } from '@/lib/config';

export const dynamic = 'force-dynamic';

/**
 * GET /api/kb/documents?org=<org>&collection=<collection>
 *
 * Lists all source documents in a KB collection with full (untruncated) paths.
 * Uses inline Python against ChromaDB directly — mmrag.py list truncates paths
 * to 58 chars which makes them unsuitable for file opening.
 *
 * Response: { documents: Array<{ source: string, filename: string, type: string, chunks: number }> }
 */
export async function GET(request: NextRequest) {
  const { searchParams } = request.nextUrl;
  const org = searchParams.get('org') ?? '';
  const collection = searchParams.get('collection') ?? '';

  if (!org || !/^[a-z0-9_-]+$/.test(org)) {
    return Response.json({ error: 'org parameter required' }, { status: 400 });
  }
  if (!collection || !/^[a-z0-9_-]+$/.test(collection)) {
    return Response.json({ error: 'collection parameter required' }, { status: 400 });
  }

  const frameworkRoot = getFrameworkRoot();
  const ctxRoot = getCTXRoot();
  const instanceId = path.basename(ctxRoot);
  const kbRoot = path.join(os.homedir(), '.cortextos', instanceId, 'orgs', org, 'knowledge-base');
  const chromaDir = path.join(kbRoot, 'chromadb');

  if (!existsSync(chromaDir)) {
    return Response.json({ documents: [] });
  }

  const isWin = process.platform === 'win32';
  const venvBin = isWin ? 'Scripts' : 'bin';
  const pythonExe = isWin ? 'python.exe' : 'python3';
  const pythonPath = path.join(frameworkRoot, 'knowledge-base', 'venv', venvBin, pythonExe);

  if (!existsSync(pythonPath)) {
    return Response.json({ documents: [] });
  }

  // Inline Python: query ChromaDB directly for full untruncated source paths
  const script = `
import sys, json, os
try:
    import chromadb
    client = chromadb.PersistentClient(path=sys.argv[1])
    col = client.get_collection(sys.argv[2])
    data = col.get(include=['metadatas'])
    by_source = {}
    for meta in data['metadatas']:
        src = meta.get('source', '')
        if not src:
            continue
        if src not in by_source:
            by_source[src] = {
                'source': src,
                'filename': meta.get('filename', '') or os.path.basename(src),
                'type': meta.get('type', 'text'),
                'chunks': 0,
            }
        by_source[src]['chunks'] += 1
    docs = sorted(by_source.values(), key=lambda x: x['source'])
    print(json.dumps({'documents': docs}))
except Exception as e:
    print(json.dumps({'documents': [], 'error': str(e)}))
`;

  let stdout = '';
  try {
    stdout = execFileSync(pythonPath, ['-c', script, chromaDir, collection], {
      timeout: 15000,
      encoding: 'utf-8',
    });
  } catch (e: unknown) {
    stdout = (e as { stdout?: string }).stdout || '';
    if (!stdout) return Response.json({ documents: [] });
  }

  try {
    const data = JSON.parse(stdout.trim()) as {
      documents: Array<{ source: string; filename: string; type: string; chunks: number }>;
      error?: string;
    };
    return Response.json({ documents: data.documents || [] });
  } catch {
    return Response.json({ documents: [] });
  }
}
