import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { screenIngestFile, screenIngestPaths } from '../../../src/bus/knowledge-base.js';

// This test uses REAL temp files and the REAL screen (no fs mock). A screen test
// that mocks the fs it reads would prove nothing about the screen — it would be a
// screen-shaped no-op testing a mock. The whole point of this row is that a screen
// which has never REFUSED anything is indistinguishable from no screen, so the
// load-bearing assertion is the known-POSITIVE: a planted fake credential is
// refused. The clean control proves it does not refuse everything (a screen that
// blocks all input is also a no-op, just the failing-closed kind).

describe('kb-ingest credential screen (screenIngestFile)', () => {
  let dir: string;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'kb-screen-'));
  });
  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('REFUSES a text file carrying a planted fake credential (KNOWN-POSITIVE — the proof)', () => {
    const f = join(dir, 'memory-with-secret.md');
    writeFileSync(f, '# daily note\n\npassword = "Pl4ntedF4keCredential"\n\nmore prose here\n');
    expect(screenIngestFile(f)).toBe('credential_pattern_detected');
  });

  it('REFUSES an .env file by NAME regardless of content', () => {
    const f = join(dir, '.env');
    writeFileSync(f, 'HARMLESS=value\n');
    expect(screenIngestFile(f)).toBe('contains_credentials');
  });

  it('ALLOWS an ordinary clean text file (KNOWN-NEGATIVE control — does not refuse everything)', () => {
    const f = join(dir, 'clean.md');
    writeFileSync(f, '# Meeting notes\n\nWe discussed the roadmap and the rate limiter design.\n');
    expect(screenIngestFile(f)).toBeNull();
  });

  it('ALLOWS a non-text/binary file (multimodal ingest is NOT broken — the reshape we avoided)', () => {
    const f = join(dir, 'image.bin');
    // NUL bytes => isUnscreenableBinary true => allowed pre-extraction. RESIDUAL
    // (see screenIngestFile doc): the KB extracts+embeds text FROM binaries, so a
    // credential in a PDF survives this screen and becomes searchable — closed only
    // by a post-extraction screen in mmrag, filed separately. This test asserts the
    // pre-extraction behaviour (binary allowed), which is correct at THIS layer.
    writeFileSync(f, Buffer.from([0x00, 0x01, 0x02, 0xff, 0x00, 0x10]));
    expect(screenIngestFile(f)).toBeNull();
  });

  it('REFUSES a target it cannot read as a file (fail-closed, not fall-through)', () => {
    const sub = join(dir, 'subdir');
    mkdirSync(sub, { recursive: true });
    // readFileSync on a directory throws EISDIR -> 'unreadable': a thing we cannot
    // read is a thing we cannot clear, so it is refused rather than allowed.
    expect(screenIngestFile(sub)).toBe('unreadable');
  });

  // --- Wire-level proof: the PARTITION refuses, not just the predicate ---------

  it('WIRE: a dirty path is dropped from cleanPaths and lands in refused', () => {
    const dirtyDir = mkdtempSync(join(tmpdir(), 'kb-wire-'));
    const clean = join(dirtyDir, 'clean.md');
    const dirty = join(dirtyDir, 'secret.md');
    writeFileSync(clean, '# fine\n\nordinary prose, nothing to see.\n');
    writeFileSync(dirty, 'token = "l1veL00kingT0ken"\n');
    try {
      const { cleanPaths, refused } = screenIngestPaths([clean, dirty]);
      expect(cleanPaths).toEqual([clean]);
      expect(refused).toEqual([{ file: dirty, reason: 'credential_pattern_detected' }]);
    } finally {
      rmSync(dirtyDir, { recursive: true, force: true });
    }
  });

  it('WIRE: a directory containing one dirty file fails the WHOLE directory closed', () => {
    const d = mkdtempSync(join(tmpdir(), 'kb-wiredir-'));
    writeFileSync(join(d, 'a.md'), 'clean sibling\n');
    writeFileSync(join(d, 'b.md'), 'password = "d33plyN3sted"\n');
    try {
      const { cleanPaths, refused } = screenIngestPaths([d]);
      // The dir is NOT in cleanPaths — mmrag recurses a dir as a unit, so a clean
      // sibling cannot ride in past a dirty one via a path mmrag would re-walk.
      expect(cleanPaths).toEqual([]);
      expect(refused.map(r => r.reason)).toContain('credential_pattern_detected');
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });
});
