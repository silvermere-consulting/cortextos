import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import bcrypt from 'bcryptjs';

// In-memory stand-in for the users table — same .prepare().get() surface the
// detector uses. The real db is a singleton over CTX_ROOT; tests never touch it.
const users = new Map<string, { password_hash: string }>();
vi.mock('../db', () => ({
  db: {
    prepare: (sql: string) => ({
      get: (username: string) => {
        expect(sql).toContain('FROM users');
        return users.get(username);
      },
    }),
  },
}));

import { warnOnAdminCredentialDivergence } from '../auth-divergence';

// Acceptance (chief-framed ticket, 2026-07-22): known-positive — deliberately
// diverge -> the check FIRES; known-negative — matching -> SILENT; and the
// detector never writes (it has no write path by construction: the mock throws
// on any sql it does not expect, and only SELECT is expected).

describe('warnOnAdminCredentialDivergence', () => {
  const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

  beforeEach(async () => {
    users.clear();
    errSpy.mockClear();
    process.env.ADMIN_USERNAME = 'admin';
    process.env.ADMIN_PASSWORD = 'correct-horse-battery';
    users.set('admin', { password_hash: await bcrypt.hash('correct-horse-battery', 4) });
  });

  afterEach(() => {
    delete process.env.ADMIN_USERNAME;
    delete process.env.ADMIN_PASSWORD;
  });

  it('known-negative: matching disk and table stays SILENT', async () => {
    expect(await warnOnAdminCredentialDivergence()).toBe(false);
    expect(errSpy).not.toHaveBeenCalled();
  });

  it('known-positive: deliberately diverged table FIRES loudly and names both recovery paths', async () => {
    users.set('admin', { password_hash: await bcrypt.hash('somebody-changed-me', 4) });
    expect(await warnOnAdminCredentialDivergence()).toBe(true);
    expect(errSpy).toHaveBeenCalledTimes(1);
    const line = errSpy.mock.calls[0][0] as string;
    expect(line).toContain('CREDENTIAL DIVERGENCE');
    expect(line).toContain('SYNC_ADMIN_PASSWORD=true'); // disk-wins recovery
    expect(line).toContain('.env.local');               // table-wins recovery
    expect(line).toContain('detected, not repaired');   // never-overwrite contract
  });

  it('absent ADMIN_PASSWORD is a valid deployment, not a divergence', async () => {
    delete process.env.ADMIN_PASSWORD;
    expect(await warnOnAdminCredentialDivergence()).toBe(false);
    expect(errSpy).not.toHaveBeenCalled();
  });

  it('missing user row is silent — the empty-table case belongs to seeding, not detection', async () => {
    users.clear();
    expect(await warnOnAdminCredentialDivergence()).toBe(false);
    expect(errSpy).not.toHaveBeenCalled();
  });
});
