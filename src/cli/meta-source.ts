import { readFileSync } from 'fs';

/**
 * Resolution + fail-close validation for the `log-event --meta` payload.
 *
 * Extracted from the command handler (2026-10-06, engineer; chief task_1791167040974
 * + goal #92 item 2) so the decision logic is UNIT-TESTABLE WITHOUT an event-write
 * path — a test that fired these arms through the real handler would inject the exact
 * empty/rejected shapes the empty-metadata base rate is computed over (analyst's
 * 9/10,008 series + the dashboard wrapper-vs-CLI split), contaminating the instrument
 * in the commit that fixes it. These functions touch no event tree, so contamination
 * is impossible by construction. Mirrors src/cli/message-text.ts (injectable reader).
 */

export interface MetaSourceOptions {
  /** The --meta value. Carries commander's '{}' default when the flag is absent. */
  meta?: string;
  /** --meta-stdin: read the JSON from stdin (off argv — shell quoting cannot mangle it). */
  metaStdin?: boolean;
  /** --meta-file <path>: read the JSON from a file (same off-argv safety as --meta-stdin). */
  metaFile?: string;
}

/**
 * Resolve the --meta payload STRING from its source. stdin/file bytes never ride argv,
 * so they cannot be split by shell quoting — this closes the residual the fail-close
 * alone leaves (the whole --meta flag vanishing to commander's '{}' default).
 *
 * @param metaExplicit did the user pass --meta on the CLI (vs the commander default)?
 * @param readStdin    injectable for tests; defaults to reading fd 0.
 * @param isStdinTTY   injectable for tests; defaults to the real tty state.
 * @throws Error on a source conflict or a --meta-stdin with nothing piped.
 */
export function resolveMetaSource(
  opts: MetaSourceOptions,
  metaExplicit: boolean,
  readStdin: () => string = () => readFileSync(0, 'utf-8'),
  isStdinTTY: boolean = Boolean(process.stdin.isTTY),
): string {
  if (opts.metaStdin && opts.metaFile) {
    throw new Error('log-event: use either --meta-stdin or --meta-file, not both.');
  }
  if ((opts.metaStdin || opts.metaFile) && metaExplicit) {
    throw new Error('log-event: --meta cannot be combined with --meta-stdin/--meta-file.');
  }
  if (opts.metaStdin) {
    if (isStdinTTY) {
      throw new Error(
        "log-event: --meta-stdin given but nothing is piped. Use a heredoc:\n" +
        "  cortextos bus log-event <category> <event> <severity> --meta-stdin << 'EOF'\n" +
        '  {"key":"value"}\n  EOF',
      );
    }
    return readStdin().replace(/\n$/, '');
  }
  if (opts.metaFile) {
    return readFileSync(opts.metaFile, 'utf-8').replace(/\n$/, '');
  }
  return opts.meta ?? '{}';
}

/**
 * Fail-close validity classifier. Returns a human reason if `meta` is NOT a JSON object
 * (the only shape a metadata blob may legitimately take), else null.
 *
 * Discriminator is JSON-VALIDITY, not emptiness: a valid `{}` returns null (passes), only
 * an unparseable / non-object --meta is rejected. Rejecting malformed BEFORE it is written
 * makes `{}` in the event log unambiguously legitimate — the retirement condition for the
 * empty-metadata trigger. Before this, logEvent() silently substituted {} for invalid JSON,
 * so a shell-corrupted self_report wrote metadata:{} at exit 0, unrecoverable and byte-
 * identical to a legitimately empty event.
 */
export function classifyMetaReject(meta: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(meta);
  } catch (err) {
    return `--meta is not valid JSON: ${err instanceof Error ? err.message : String(err)}`;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return `--meta must be a JSON object (got ${parsed === null ? 'null' : Array.isArray(parsed) ? 'array' : typeof parsed})`;
  }
  return null;
}
