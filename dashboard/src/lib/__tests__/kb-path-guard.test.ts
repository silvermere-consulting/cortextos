import { describe, it, expect } from 'vitest';
import path from 'path';
import { guardKbPath, TEXT_DOC_EXTS, BINARY_DOC_EXTS } from '../kb-path-guard';
import { getFrameworkRoot, getCTXRoot } from '../config';

// Paths are built from the SAME roots the guard uses, so the test is self-consistent.
const FR = getFrameworkRoot();
const CTX = getCTXRoot();
const ORG = 'silvermere-tech';
const fr = (rel: string) => path.join(FR, rel);
const ctx = (rel: string) => path.join(CTX, rel);

// A real, existing legit doc under orgs/<org> (the happy path must keep working).
const REAL_MD = fr(`orgs/${ORG}/knowledge.md`);
const REAL_PDF = fr(`orgs/${ORG}/research/GOTM-2026-06-05-gotm-vpn-affiliate-comparison.pdf`);

const denied = (r: ReturnType<typeof guardKbPath>) => r.ok === false && r.status === 403;

describe('guardKbPath — DENY (credential/exfil shapes)', () => {
  it('denies secrets.env directly under orgs/<org> (it lives UNDER orgs/, so name-deny is the load-bearing check)', () => {
    expect(denied(guardKbPath(fr(`orgs/${ORG}/secrets.env`), ORG, TEXT_DOC_EXTS))).toBe(true);
  });
  it('denies secrets.env in an UNEXPECTED deep location', () => {
    expect(denied(guardKbPath(fr(`orgs/${ORG}/docs/deep/nested/secrets.env`), ORG, TEXT_DOC_EXTS))).toBe(true);
  });
  it('denies an agent .env (dotfile)', () => {
    expect(denied(guardKbPath(fr(`orgs/${ORG}/agents/engineer/.env`), ORG, TEXT_DOC_EXTS))).toBe(true);
  });
  it('denies key/cert shapes: *.pem, *.key, id_rsa, *.p12, *.crt, .netrc, .git-credentials', () => {
    for (const name of ['tls.pem', 'origin.key', 'id_rsa', 'store.p12', 'server.crt', '.netrc', '.git-credentials']) {
      expect(denied(guardKbPath(fr(`orgs/${ORG}/${name}`), ORG, TEXT_DOC_EXTS))).toBe(true);
    }
  });
  it('denies service-account.json and any .json (config/credential type not servable)', () => {
    expect(denied(guardKbPath(fr(`orgs/${ORG}/service-account.json`), ORG, TEXT_DOC_EXTS))).toBe(true);
    expect(denied(guardKbPath(fr(`orgs/${ORG}/config.json`), ORG, TEXT_DOC_EXTS))).toBe(true);
  });
  it('denies source-code / non-doc extensions even under orgs/', () => {
    for (const name of ['x.ts', 'x.js', 'x.sh', 'x.py', 'x.env']) {
      expect(denied(guardKbPath(fr(`orgs/${ORG}/${name}`), ORG, TEXT_DOC_EXTS))).toBe(true);
    }
  });
  it('denies anything OUTSIDE orgs/ (whole-repo access is closed)', () => {
    expect(denied(guardKbPath(fr('package.json'), '', TEXT_DOC_EXTS))).toBe(true);
    expect(denied(guardKbPath(fr('dashboard/.env.local'), '', TEXT_DOC_EXTS))).toBe(true);
    expect(denied(guardKbPath(ctx('secrets.env'), '', TEXT_DOC_EXTS))).toBe(true); // ~/.cortextos root no longer wide-open
  });
  it('denies cross-org reads (org param is USED, not decorative)', () => {
    expect(denied(guardKbPath(fr('orgs/family/knowledge.md'), ORG, TEXT_DOC_EXTS))).toBe(true);
    expect(denied(guardKbPath(fr(`orgs/${ORG}/knowledge.md`), 'family', TEXT_DOC_EXTS))).toBe(true);
  });
  it('denies traversal that escapes orgs/ (path.resolve collapses ../)', () => {
    expect(denied(guardKbPath(fr(`orgs/${ORG}/../../secrets.env`), ORG, TEXT_DOC_EXTS))).toBe(true);
  });
  it('rejects empty path (400) and malformed org (400)', () => {
    expect(guardKbPath('', ORG, TEXT_DOC_EXTS)).toMatchObject({ ok: false, status: 400 });
    expect(guardKbPath(REAL_MD, 'bad org!', TEXT_DOC_EXTS)).toMatchObject({ ok: false, status: 400 });
  });
  it('download endpoint (binary exts) denies a text .md — endpoint separation holds', () => {
    expect(denied(guardKbPath(REAL_MD, ORG, BINARY_DOC_EXTS))).toBe(true);
  });
});

describe('guardKbPath — ALLOW (legitimate documents still serve)', () => {
  it('SERVES a real .md under orgs/<org> (text endpoint)', () => {
    const r = guardKbPath(REAL_MD, ORG, TEXT_DOC_EXTS);
    expect(r).toMatchObject({ ok: true });
    if (r.ok) expect(r.resolved).toBe(REAL_MD);
  });
  it('SERVES a real .pdf under orgs/<org> (download endpoint)', () => {
    expect(guardKbPath(REAL_PDF, ORG, BINARY_DOC_EXTS)).toMatchObject({ ok: true });
  });
  it('SERVES an org-scoped doc when org matches the path', () => {
    expect(guardKbPath(REAL_MD, ORG, TEXT_DOC_EXTS).ok).toBe(true);
  });
  it('returns 404 (not 403) for a servable-shaped path under orgs/ that does not exist — proves the guard reached the existence check, not a false allow', () => {
    expect(guardKbPath(fr(`orgs/${ORG}/does-not-exist-xyz.md`), ORG, TEXT_DOC_EXTS)).toMatchObject({ ok: false, status: 404 });
  });
});
