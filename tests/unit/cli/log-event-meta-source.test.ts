/**
 * Standing guard for the log-event --meta fail-close + stdin/file resolution
 * (chief task_1791167040974 + goal #92 item 2, landed 2026-10-06). These paths —
 * silently substituting {} for a shell-corrupted --meta — are what dropped self_report
 * payloads at exit 0 (task_1791166263884). A scratch run proved the arms the day they
 * landed; this file is the standing guard so the next change to that handler cannot
 * silently regress the reject or the stdin resolution.
 *
 * 🔴 CONTAMINATION-SAFE BY CONSTRUCTION (chief's landing condition): these tests exercise
 * the pure decision logic ONLY — they never call logEvent, never construct an event, never
 * touch any event tree or CTX_ROOT. A reject-arm test fired through the real handler would
 * inject the exact empty/rejected shapes the empty-metadata base rate is computed over
 * (analyst's 9/10,008 series + the dashboard wrapper-vs-CLI split). There is no event-write
 * path in the unit under test, so the question cannot arise. The only filesystem touch is a
 * tmp file for the --meta-file case; stdin is injected, never read from fd 0.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { resolveMetaSource, classifyMetaReject } from '../../../src/cli/meta-source';
import { busCommand } from '../../../src/cli/bus';

describe('log-event --meta source resolution (goal #92 item 2)', () => {
  const quiet = () => ''; // injected stdin reader; never touches fd 0

  it('returns the --meta value when no stdin/file source is given', () => {
    expect(resolveMetaSource({ meta: '{"a":1}' }, true, quiet)).toBe('{"a":1}');
  });

  it("falls back to '{}' when --meta is absent (commander default path)", () => {
    expect(resolveMetaSource({}, false, quiet)).toBe('{}');
  });

  it('reads JSON from stdin when --meta-stdin, stripping a single trailing newline', () => {
    const payload = '{"wrong":"don\'t do X","not_done":"NONE"}';
    expect(resolveMetaSource({ metaStdin: true }, false, () => payload + '\n')).toBe(payload);
  });

  it('reads JSON from a file when --meta-file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'meta-file-'));
    try {
      const f = join(dir, 'm.json');
      writeFileSync(f, '{"k":"v"}\n');
      expect(resolveMetaSource({ metaFile: f }, false, quiet)).toBe('{"k":"v"}');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rejects --meta-stdin + --meta-file together', () => {
    expect(() => resolveMetaSource({ metaStdin: true, metaFile: '/x' }, false, quiet))
      .toThrow(/either --meta-stdin or --meta-file, not both/);
  });

  it('rejects a stdin/file source combined with an explicit --meta', () => {
    expect(() => resolveMetaSource({ metaStdin: true }, true, quiet))
      .toThrow(/--meta cannot be combined with --meta-stdin\/--meta-file/);
    expect(() => resolveMetaSource({ metaFile: '/x' }, true, quiet))
      .toThrow(/--meta cannot be combined with --meta-stdin\/--meta-file/);
  });

  it('rejects --meta-stdin when nothing is piped (tty)', () => {
    expect(() => resolveMetaSource({ metaStdin: true }, false, quiet, /* isStdinTTY */ true))
      .toThrow(/nothing is piped/);
  });
});

describe('log-event --meta fail-close (chief task_1791167040974)', () => {
  it('passes a valid JSON object', () => {
    expect(classifyMetaReject('{"a":1}')).toBeNull();
  });

  it('passes an empty object — discriminator is validity, NOT emptiness', () => {
    // This is the retirement condition for the empty-metadata trigger: a legitimate {}
    // must still be accepted, only an INVALID/non-object --meta is rejected.
    expect(classifyMetaReject('{}')).toBeNull();
  });

  it('rejects unparseable JSON (the shell-corruption carrier)', () => {
    expect(classifyMetaReject('not json')).toMatch(/not valid JSON/);
    expect(classifyMetaReject('{"k":1}}')).toMatch(/not valid JSON/); // the ${4:-{}} corruption shape
  });

  it('rejects a JSON value that is not an object', () => {
    expect(classifyMetaReject('[]')).toMatch(/must be a JSON object \(got array\)/);
    expect(classifyMetaReject('null')).toMatch(/must be a JSON object \(got null\)/);
    expect(classifyMetaReject('"str"')).toMatch(/must be a JSON object \(got string\)/);
    expect(classifyMetaReject('42')).toMatch(/must be a JSON object \(got number\)/);
  });
});

describe('log-event command wiring', () => {
  it('registers --meta-stdin and --meta-file on the log-event subcommand', () => {
    const logEventCmd = busCommand.commands.find((c) => c.name() === 'log-event');
    expect(logEventCmd).toBeDefined();
    const flags = (logEventCmd!.options as { long?: string }[]).map((o) => o.long);
    expect(flags).toContain('--meta');
    expect(flags).toContain('--meta-stdin');
    expect(flags).toContain('--meta-file');
  });
});
