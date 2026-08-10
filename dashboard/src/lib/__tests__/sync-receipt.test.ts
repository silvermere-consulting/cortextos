import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';

// Set CTX_ROOT before modules load (sync-receipt derives its paths from it).
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sync-receipt-test-'));
process.env.CTX_ROOT = tmpDir;

let readSyncConfig: typeof import('../sync-receipt')['readSyncConfig'];
let writeSyncReceipt: typeof import('../sync-receipt')['writeSyncReceipt'];
let CONFIG_PATH: string;
let DEFAULT_RECEIPT_PATH: string;
let SYNC_DIR: string;

beforeAll(async () => {
  const m = await import('../sync-receipt');
  readSyncConfig = m.readSyncConfig;
  writeSyncReceipt = m.writeSyncReceipt;
  CONFIG_PATH = m.CONFIG_PATH;
  DEFAULT_RECEIPT_PATH = m.DEFAULT_RECEIPT_PATH;
  SYNC_DIR = m.SYNC_DIR;
  expect(CONFIG_PATH.startsWith(tmpDir)).toBe(true);
});

beforeEach(() => {
  fs.rmSync(SYNC_DIR, { recursive: true, force: true });
});

describe('sync-receipt', () => {
  describe('readSyncConfig (cadence one-source-of-truth, fail-closed)', () => {
    it('returns null when the config is absent', () => {
      expect(readSyncConfig()).toBeNull();
    });

    it('returns null when interval_ms or enabled_since is missing/invalid', () => {
      fs.mkdirSync(SYNC_DIR, { recursive: true });
      fs.writeFileSync(CONFIG_PATH, JSON.stringify({ interval_ms: 60000 })); // no enabled_since
      expect(readSyncConfig()).toBeNull();
      fs.writeFileSync(CONFIG_PATH, JSON.stringify({ enabled_since: '2026-08-10T00:00:00Z' })); // no interval
      expect(readSyncConfig()).toBeNull();
      fs.writeFileSync(CONFIG_PATH, JSON.stringify({ interval_ms: 0, enabled_since: 'T' })); // non-positive
      expect(readSyncConfig()).toBeNull();
      fs.writeFileSync(CONFIG_PATH, 'not json'); // unparsable
      expect(readSyncConfig()).toBeNull();
    });

    it('returns the config when valid', () => {
      fs.mkdirSync(SYNC_DIR, { recursive: true });
      fs.writeFileSync(
        CONFIG_PATH,
        JSON.stringify({ interval_ms: 60000, enabled_since: '2026-08-10T00:00:00Z', receipt_path: '/tmp/x.jsonl' }),
      );
      const cfg = readSyncConfig();
      expect(cfg).not.toBeNull();
      expect(cfg!.interval_ms).toBe(60000);
      expect(cfg!.enabled_since).toBe('2026-08-10T00:00:00Z');
      expect(cfg!.receipt_path).toBe('/tmp/x.jsonl');
    });
  });

  describe('writeSyncReceipt (atomic append, 3-state distinct)', () => {
    it('appends one complete newline-terminated JSON line per call; each parses; ok:false is present not swallowed', () => {
      const rp = path.join(SYNC_DIR, 'runs.jsonl');
      const cfg = { interval_ms: 60000, enabled_since: 'T', receipt_path: rp };
      writeSyncReceipt(cfg, { ts: 't1', ok: true, rows_synced: 5, duration_ms: 12 });
      writeSyncReceipt(cfg, { ts: 't2', ok: false, rows_synced: 0, error: 'boom', duration_ms: 3 });
      const raw = fs.readFileSync(rp, 'utf-8');
      const lines = raw.split('\n').filter(Boolean);
      expect(lines).toHaveLength(2); // two appends => two lines (series preserved)
      const a = JSON.parse(lines[0]);
      const b = JSON.parse(lines[1]);
      expect(a.ok).toBe(true);
      expect(a.rows_synced).toBe(5);
      // ok:false (ran-and-failed) is DISTINCT from ABSENT and is written, not swallowed:
      expect(b.ok).toBe(false);
      expect(b.error).toBe('boom');
      // atomic contract: every line is newline-terminated, so a reader never sees a torn line:
      expect(raw.endsWith('\n')).toBe(true);
    });

    it('falls back to the default sibling receipt path when receipt_path is absent', () => {
      const cfg = { interval_ms: 60000, enabled_since: 'T' };
      writeSyncReceipt(cfg, { ts: 't', ok: true, rows_synced: 1, duration_ms: 1 });
      expect(fs.existsSync(DEFAULT_RECEIPT_PATH)).toBe(true);
    });
  });
});
