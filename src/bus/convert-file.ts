/**
 * convert-file — wrap the Python file-convert.py script so cortextos bus has a
 * one-shot "file → markdown" converter (with optional kb-ingest chaining).
 *
 * Routing happens in the Python script: PDF → Kreuzberg v4.9.9, everything
 * else → markitdown. Both live in the framework's knowledge-base/venv next
 * to mmrag.py, so kb-ingest and convert-file share their Python runtime.
 *
 * License note: Kreuzberg is ELv2 (INTERNAL ONLY). cortextos stays MIT,
 * and convert-file is an internal-tool surface — do not wrap this into a
 * client-facing product.
 */

import { existsSync, mkdtempSync, writeFileSync, statSync } from 'fs';
import { join } from 'path';
import { spawnSync } from 'child_process';
import { tmpdir } from 'os';

import { ingestKnowledgeBase } from './knowledge-base';

const SCRIPT_TIMEOUT_FLOOR_MS = 60_000;
const SCRIPT_TIMEOUT_DEFAULT_MS = 300_000;

function getVenvPython(frameworkRoot: string): string {
  const isWin = process.platform === 'win32';
  const venvBin = isWin ? 'Scripts' : 'bin';
  const pythonExe = isWin ? 'python.exe' : 'python3';
  return join(frameworkRoot, 'knowledge-base', 'venv', venvBin, pythonExe);
}

function getConverterPath(frameworkRoot: string): string {
  return join(frameworkRoot, 'knowledge-base', 'scripts', 'file-convert.py');
}

export interface ConvertFileOptions {
  frameworkRoot: string;
  ocr?: boolean;
  format?: 'markdown' | 'json';
}

export interface ConvertFileResult {
  ok: boolean;
  exitCode: number;
  content: string;
  stderr: string;
}

/**
 * Convert a single file to markdown via the framework Python venv.
 *
 * Returns the converted content (stdout) plus exit metadata. Does not throw
 * on conversion failure — callers can inspect `exitCode` and `stderr` to
 * decide whether to surface the error or fall back. The CLI wrapper does
 * exit non-zero with the stderr forwarded.
 */
export function convertFile(path: string, options: ConvertFileOptions): ConvertFileResult {
  const { frameworkRoot, ocr = false, format = 'markdown' } = options;

  const pythonPath = getVenvPython(frameworkRoot);
  const scriptPath = getConverterPath(frameworkRoot);

  if (!existsSync(pythonPath)) {
    return {
      ok: false,
      exitCode: 127,
      content: '',
      stderr:
        `convert-file: framework venv python not found at ${pythonPath}. ` +
        `Run the knowledge-base setup first.`,
    };
  }
  if (!existsSync(scriptPath)) {
    return {
      ok: false,
      exitCode: 127,
      content: '',
      stderr: `convert-file: converter script not found at ${scriptPath}.`,
    };
  }

  const args: string[] = [scriptPath, path];
  if (ocr) args.push('--ocr');
  if (format === 'json') args.push('--format', 'json');

  const requestedTimeout = Number(process.env.CONVERT_FILE_TIMEOUT_MS);
  const timeoutMs = Math.max(
    SCRIPT_TIMEOUT_FLOOR_MS,
    Number.isFinite(requestedTimeout) && requestedTimeout > 0
      ? requestedTimeout
      : SCRIPT_TIMEOUT_DEFAULT_MS,
  );

  const result = spawnSync(pythonPath, args, {
    encoding: 'utf-8',
    timeout: timeoutMs,
    env: process.env,
    maxBuffer: 256 * 1024 * 1024, // 256 MB — large reports can balloon
  });

  if (result.error) {
    return {
      ok: false,
      exitCode: 127,
      content: '',
      stderr: `convert-file: ${result.error.message}`,
    };
  }

  return {
    ok: result.status === 0,
    exitCode: result.status ?? 1,
    content: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

export interface ConvertAndIngestOptions extends ConvertFileOptions {
  org: string;
  agent?: string;
  scope?: 'shared' | 'private';
  collection?: string;
  force?: boolean;
  instanceId: string;
}

/**
 * Convert a file to markdown then ingest the markdown into the KB.
 *
 * The intermediate markdown is written to a tmp file so kb-ingest gets a
 * real source-path to fingerprint + record in its metadata. We DO NOT clean
 * up the tmp file after — kb-ingest path-IDs are md5(source_path)[:12], so
 * re-running convert-file on the same input from the same tmp gives the
 * same id and re-ingest is a no-op without --force. Leave the tmp behind
 * so the chain stays idempotent.
 */
export function convertAndIngest(
  sourcePath: string,
  options: ConvertAndIngestOptions,
): { conversion: ConvertFileResult; ingestRan: boolean; markdownTmpPath?: string } {
  const conversion = convertFile(sourcePath, options);
  if (!conversion.ok) {
    return { conversion, ingestRan: false };
  }

  const sourceStat = statSync(sourcePath);
  const sourceBase = sourcePath.replace(/[^A-Za-z0-9._-]/g, '_').slice(-80);
  const tmpDir = mkdtempSync(join(tmpdir(), 'convert-file-'));
  const tmpPath = join(tmpDir, `${sourceStat.ino}-${sourceBase}.md`);
  writeFileSync(tmpPath, conversion.content, 'utf-8');

  ingestKnowledgeBase([tmpPath], {
    org: options.org,
    agent: options.agent,
    scope: options.scope ?? 'shared',
    collection: options.collection,
    force: options.force,
    frameworkRoot: options.frameworkRoot,
    instanceId: options.instanceId,
  });

  return { conversion, ingestRan: true, markdownTmpPath: tmpPath };
}
