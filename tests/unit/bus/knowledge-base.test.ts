import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Path-aware fs mocks. existsSync is the one we actually drive per-test:
// it returns true for any path EXCEPT the MMRAG_CONFIG one (when the test
// wants to simulate a missing config) so loadSecretsEnv and other path
// lookups still work normally inside the module under test.
const fsMocks = {
  existsSync: vi.fn(),
  readFileSync: vi.fn(),
  mkdirSync: vi.fn(),
};

vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    existsSync: (...args: Parameters<typeof fsMocks.existsSync>) => fsMocks.existsSync(...args),
    readFileSync: (...args: Parameters<typeof fsMocks.readFileSync>) => fsMocks.readFileSync(...args),
    mkdirSync: (...args: Parameters<typeof fsMocks.mkdirSync>) => fsMocks.mkdirSync(...args),
  };
});

// Mock execFileSync + spawnSync so we can assert whether they were called
// (and optionally simulate python output). queryKnowledgeBase uses execFileSync
// directly; ingestKnowledgeBase switched to spawnSync so it can detect a
// Gemini-quota 429 in stdout/stderr and skip gracefully instead of throwing.
const execFileSyncMock = vi.fn();
const spawnSyncMock = vi.fn();
vi.mock('child_process', async () => {
  const actual = await vi.importActual<typeof import('child_process')>('child_process');
  return {
    ...actual,
    execFileSync: (...args: unknown[]) => execFileSyncMock(...args),
    spawnSync: (...args: unknown[]) => spawnSyncMock(...args),
  };
});

// Mock normalizeOrgName to a passthrough identity — we are not testing org
// normalization here, that has its own dedicated test file.
vi.mock('../../../src/utils/org.js', () => ({
  normalizeOrgName: (_root: string, org: string) => org,
}));

const { queryKnowledgeBase, ingestKnowledgeBase } = await import('../../../src/bus/knowledge-base.js');

// Minimal BusPaths stub — knowledge-base.ts doesn't actually USE the paths
// object at call time, just the options/env it constructs.
const dummyPaths = {
  stateDir: '/tmp/agent/state',
  logDir: '/tmp/agent/logs',
  ctxRoot: '/tmp/agent',
  instanceId: 'test',
  agentName: 'tester',
  org: 'TestOrg',
  inboxDir: '/tmp/agent/inbox',
  inflightDir: '/tmp/agent/inflight',
  processedDir: '/tmp/agent/processed',
  outboxDir: '/tmp/agent/outbox',
} as any;

const baseOptions = {
  org: 'TestOrg',
  agent: 'tester',
  frameworkRoot: '/home/test/cortextOS',
  instanceId: 'test',
};

let warnLog: string[] = [];
let originalWarn: typeof console.warn;
let logLog: string[] = [];
let originalLog: typeof console.log;

beforeEach(() => {
  fsMocks.existsSync.mockReset();
  fsMocks.readFileSync.mockReset().mockReturnValue('');
  fsMocks.mkdirSync.mockReset();
  execFileSyncMock.mockReset();
  spawnSyncMock.mockReset();
  // Default spawnSync behaviour: success with no output, mirrors the python
  // happy path so tests that don't care about quota-skip don't have to set it.
  spawnSyncMock.mockReturnValue({ status: 0, stdout: '', stderr: '' });

  warnLog = [];
  logLog = [];
  originalWarn = console.warn;
  originalLog = console.log;
  console.warn = (...args: unknown[]) => {
    warnLog.push(args.map((a) => String(a)).join(' '));
  };
  console.log = (...args: unknown[]) => {
    logLog.push(args.map((a) => String(a)).join(' '));
  };
});

afterEach(() => {
  console.warn = originalWarn;
  console.log = originalLog;
});

/**
 * Helper: make existsSync return false ONLY for paths that end with
 * knowledge-base/config.json (i.e. the MMRAG_CONFIG file), true for everything
 * else. Simulates a freshly-created agent with no KB configured yet.
 */
function mockMissingKbConfig(): void {
  fsMocks.existsSync.mockImplementation((p: any) => {
    const path = String(p);
    if (path.endsWith('/knowledge-base/config.json')) return false;
    return true;
  });
}

/**
 * Helper: make existsSync return true for everything, simulating a fully
 * configured KB with config.json present on disk.
 */
function mockConfiguredKb(): void {
  fsMocks.existsSync.mockImplementation(() => true);
}

describe('ingestKnowledgeBase — graceful missing-config', () => {
  it('missing config: warn + return cleanly, neither python spawn called', () => {
    mockMissingKbConfig();

    // Must NOT throw. Previously this path threw an unhandled execFileSync
    // error that dumped a Node stack trace on top of the python stderr.
    expect(() =>
      ingestKnowledgeBase(['/some/file.md'], baseOptions),
    ).not.toThrow();

    expect(execFileSyncMock).not.toHaveBeenCalled();
    expect(spawnSyncMock).not.toHaveBeenCalled();
    // Warn must include the org name AND an actionable hint ("run setup").
    expect(warnLog.some((m) => m.includes('TestOrg') && /run setup/i.test(m))).toBe(true);
    // Warn must carry the [kb] prefix so operators can filter log lines.
    expect(warnLog.some((m) => m.includes('[kb]'))).toBe(true);
  });

  it('config present: spawnSync IS called with the mmrag ingest args', () => {
    mockConfiguredKb();
    spawnSyncMock.mockReturnValue({ status: 0, stdout: '', stderr: '' });

    ingestKnowledgeBase(['/some/file.md'], baseOptions);

    expect(spawnSyncMock).toHaveBeenCalledTimes(1);
    const [pythonPath, argv] = spawnSyncMock.mock.calls[0] as [string, string[], object];
    expect(String(pythonPath)).toMatch(/python/);
    expect(argv).toEqual(expect.arrayContaining(['ingest', '/some/file.md']));
    // Happy path emits no [kb] warning.
    expect(warnLog.filter((m) => m.includes('[kb]'))).toHaveLength(0);
  });
});

describe('ingestKnowledgeBase — Gemini quota-exhausted skip (E2)', () => {
  it('429 RESOURCE_EXHAUSTED in stderr → warn + return cleanly (no throw, no retry)', () => {
    mockConfiguredKb();
    // Mirror the exact mmrag.py error shape observed in the field:
    //   ERROR: 429 RESOURCE_EXHAUSTED. {...}
    spawnSyncMock.mockReturnValue({
      status: 1,
      stdout: 'Ingesting: MEMORY.md\n',
      stderr: "  ERROR: 429 RESOURCE_EXHAUSTED. {'error': {'code': 429, 'message': 'You exceeded your current quota'}}",
    });

    expect(() =>
      ingestKnowledgeBase(['/MEMORY.md'], baseOptions),
    ).not.toThrow();

    expect(spawnSyncMock).toHaveBeenCalledTimes(1);
    // The skip warning is operator-facing — must name the collection AND
    // mention quota so it's obvious why the ingest was skipped.
    const quotaWarns = warnLog.filter((m) => m.includes('[kb]') && /quota exhausted/i.test(m));
    expect(quotaWarns.length).toBeGreaterThanOrEqual(1);
    expect(quotaWarns[0]).toMatch(/agent-TestAgent|shared-TestOrg/);
  });

  it('429 RESOURCE_EXHAUSTED in stdout (not stderr) → also detected', () => {
    mockConfiguredKb();
    // Some mmrag paths print the error to stdout; the detector should not
    // care which stream the message came from.
    spawnSyncMock.mockReturnValue({
      status: 1,
      stdout: 'ERROR: 429 RESOURCE_EXHAUSTED quota exceeded',
      stderr: '',
    });
    expect(() => ingestKnowledgeBase(['/f.md'], baseOptions)).not.toThrow();
    expect(warnLog.some((m) => m.includes('[kb]') && /quota exhausted/i.test(m))).toBe(true);
  });

  it('non-quota failure (status != 0, no 429/RESOURCE_EXHAUSTED) → throws as before', () => {
    mockConfiguredKb();
    spawnSyncMock.mockReturnValue({
      status: 1,
      stdout: '',
      stderr: 'ERROR: connection refused to chromadb',
    });
    expect(() => ingestKnowledgeBase(['/f.md'], baseOptions)).toThrow(/exited with status 1/);
    // The quota skip warning must NOT fire on unrelated failures.
    expect(warnLog.filter((m) => m.includes('[kb]') && /quota/i.test(m))).toHaveLength(0);
  });

  it('detector requires BOTH 429 AND RESOURCE_EXHAUSTED (not just 429)', () => {
    mockConfiguredKb();
    // A bare 429 without RESOURCE_EXHAUSTED is some OTHER kind of throttle
    // (e.g. transient rate limit, not quota-day-exhaustion). It should be a
    // real failure — retry semantics belong to the caller / next cycle.
    spawnSyncMock.mockReturnValue({
      status: 1,
      stdout: '',
      stderr: 'HTTP 429 Too Many Requests',
    });
    expect(() => ingestKnowledgeBase(['/f.md'], baseOptions)).toThrow(/exited with status 1/);
  });
});

describe('queryKnowledgeBase — graceful missing-config', () => {
  it('missing config: warn + return empty KBQueryResponse, execFileSync NEVER called', () => {
    mockMissingKbConfig();

    const result = queryKnowledgeBase(dummyPaths, 'what is cortextos?', baseOptions);

    expect(execFileSyncMock).not.toHaveBeenCalled();
    expect(result).toEqual({
      results: [],
      total: 0,
      query: 'what is cortextos?',
      collection: 'shared-TestOrg',
    });
    expect(warnLog.some((m) => m.includes('TestOrg') && /run setup/i.test(m))).toBe(true);
    expect(warnLog.some((m) => m.includes('[kb]'))).toBe(true);
  });

  it('config present: execFileSync IS called, happy-path query returns results', () => {
    mockConfiguredKb();
    // Mock mmrag.py --json output: a JSON blob with one result.
    execFileSyncMock.mockReturnValue(
      JSON.stringify({
        results: [
          { content: 'hit', similarity: 0.9, source: 'foo.md', type: 'markdown' },
        ],
      }),
    );

    const result = queryKnowledgeBase(dummyPaths, 'test query', baseOptions);

    expect(execFileSyncMock).toHaveBeenCalled();
    expect(result.total).toBeGreaterThan(0);
    expect(result.results[0].content).toBe('hit');
    // Happy path emits no [kb] warning.
    expect(warnLog.filter((m) => m.includes('[kb]'))).toHaveLength(0);
  });
});

describe('kb warn messages — UX invariants', () => {
  it('both warn messages name the org and suggest "run setup"', () => {
    // Drive ingest path
    mockMissingKbConfig();
    ingestKnowledgeBase(['/f.md'], { ...baseOptions, org: 'SpecificOrg' });
    // Drive query path
    mockMissingKbConfig();
    queryKnowledgeBase(dummyPaths, 'q', { ...baseOptions, org: 'SpecificOrg' });

    // At least one warn per call site, each containing the org name + hint
    const specificOrgWarns = warnLog.filter((m) => m.includes('SpecificOrg'));
    expect(specificOrgWarns.length).toBeGreaterThanOrEqual(2);
    expect(specificOrgWarns.every((m) => /run setup/i.test(m))).toBe(true);
  });
});

// ── 2026-07-09: mid-session recall bug + the silent-failure zero ─────────────
// Both regressions below were INVISIBLE to the existing suite: deleting either
// fix left all 1,883 tests green. Mutation-checked when written.
describe('queryKnowledgeBase — scope "all" must mean all', () => {
  it('scope "all" queries memory-{agent}, not just shared-{org} and agent-{agent}', () => {
    mockConfiguredKb();
    execFileSyncMock.mockReturnValue('{"results": [], "result_count": 0}');

    queryKnowledgeBase(dummyPaths, 'what was I doing?', { ...baseOptions, scope: 'all' });

    // The daily-memory recipe ingests into memory-{agent}. Before this fix,
    // scope 'all' never searched it, so an agent's own diary was unreachable
    // mid-session while the boot-time disk read masked the gap.
    const collections = execFileSyncMock.mock.calls.map((call) => {
      const args = call[1] as string[];
      return args[args.indexOf('--collection') + 1];
    });
    expect(collections).toContain('shared-TestOrg');
    expect(collections).toContain('agent-tester');
    expect(collections).toContain('memory-tester');
  });

  it('scope "private" is unchanged — still agent-{agent} only', () => {
    mockConfiguredKb();
    execFileSyncMock.mockReturnValue('{"results": [], "result_count": 0}');

    queryKnowledgeBase(dummyPaths, 'q', { ...baseOptions, scope: 'private' });

    const collections = execFileSyncMock.mock.calls.map((call) => {
      const args = call[1] as string[];
      return args[args.indexOf('--collection') + 1];
    });
    expect(collections).toEqual(['agent-tester']);
  });
});

describe('queryKnowledgeBase — a failed search is not an empty one', () => {
  it('ALL collections erroring → loud warn that the zero is a FAILED search', () => {
    mockConfiguredKb();
    execFileSyncMock.mockImplementation(() => {
      throw Object.assign(new Error('chromadb connection refused'), { code: 'ECONNREFUSED' });
    });

    const result = queryKnowledgeBase(dummyPaths, 'q', { ...baseOptions, scope: 'all' });

    expect(result.total).toBe(0);
    // The whole point: 0 results must NOT be reportable as "nothing indexed".
    expect(warnLog.some((m) => /ALL 3 collection\(s\) failed/.test(m))).toBe(true);
    expect(warnLog.some((m) => /FAILED SEARCH, not an empty one/i.test(m))).toBe(true);
    expect(warnLog.some((m) => /connection refused/.test(m))).toBe(true);
  });

  it('SOME collections erroring → warn that results are PARTIAL', () => {
    mockConfiguredKb();
    execFileSyncMock.mockImplementation((_py: unknown, args: unknown) => {
      const argv = args as string[];
      const col = argv[argv.indexOf('--collection') + 1];
      if (col === 'memory-tester') throw new Error('no such collection');
      return '{"results": [{"content": "hit", "similarity": 0.9}], "result_count": 1}';
    });

    const result = queryKnowledgeBase(dummyPaths, 'q', { ...baseOptions, scope: 'all' });

    expect(result.total).toBeGreaterThan(0);
    expect(warnLog.some((m) => /1 of 3 collection\(s\) failed/.test(m))).toBe(true);
    expect(warnLog.some((m) => /PARTIAL/.test(m))).toBe(true);
    // A partial result must not masquerade as a complete one.
    expect(warnLog.some((m) => /memory-tester/.test(m))).toBe(true);
  });

  it('a healthy empty search stays quiet — no false alarm', () => {
    mockConfiguredKb();
    execFileSyncMock.mockReturnValue('{"results": [], "result_count": 0}');

    const result = queryKnowledgeBase(dummyPaths, 'q', { ...baseOptions, scope: 'all' });

    expect(result.total).toBe(0);
    // known-negative: the warning must not fire when nothing actually failed,
    // or it becomes noise and gets ignored — a slower way of having no warning.
    expect(warnLog.some((m) => /failed/i.test(m))).toBe(false);
  });
});

describe('queryKnowledgeBase — mmrag exits 0 on a missing collection', () => {
  it('non-JSON stdout (the REAL missing-collection output) is a failure, not an empty result', () => {
    mockConfiguredKb();
    // Measured against the real binary 2026-07-09: exit 0, plain text on stdout.
    // The first version of this guard only caught THROWS and missed this entirely.
    execFileSyncMock.mockReturnValue('Knowledge base is empty. Ingest some files first.\n');

    const result = queryKnowledgeBase(dummyPaths, 'q', { ...baseOptions, scope: 'all' });

    expect(result.total).toBe(0);
    expect(warnLog.some((m) => /ALL 3 collection\(s\) failed/.test(m))).toBe(true);
    expect(warnLog.some((m) => /non-JSON output/.test(m))).toBe(true);
    expect(warnLog.some((m) => /FAILED SEARCH, not an empty one/i.test(m))).toBe(true);
  });

  it('valid JSON with zero results stays quiet (known-negative)', () => {
    mockConfiguredKb();
    execFileSyncMock.mockReturnValue('{"results": [], "result_count": 0}');

    const result = queryKnowledgeBase(dummyPaths, 'q', { ...baseOptions, scope: 'all' });

    expect(result.total).toBe(0);
    expect(warnLog.some((m) => /failed/i.test(m))).toBe(false);
  });
});
