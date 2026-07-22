import bcrypt from 'bcryptjs';
import { db } from './db';

/**
 * Detect (never repair) disk-env vs users-table credential divergence.
 *
 * Mechanism of the defect this watches (2026-07-22, hit twice in one morning):
 * seedAdminUser seeds ONLY when the users table is empty, so any password
 * changed after first seed leaves .env.local and the table permanently
 * diverged — and nothing compared the two sides. The operator discovers it as
 * a mysterious failed login, at the worst time (mid deploy-verification, where
 * it was covered only by someone holding AUTH_SECRET). Class: a stored value
 * and a live value with no instrument comparing them.
 *
 * Detect LOUDLY, never overwrite: the table value may be a deliberate password
 * change nobody recorded — auto-sync would clobber an intentional value to
 * restore a stale one, the same class failing in the opposite direction. The
 * warning names both recovery paths so the fix travels with the detection.
 *
 * Called from the auth path (seedAdminUser's early return), so it speaks at
 * exactly the moment an operator is about to experience the divergence.
 * Returns true iff a divergence was detected (and logged).
 */
export async function warnOnAdminCredentialDivergence(): Promise<boolean> {
  const password = process.env.ADMIN_PASSWORD;
  if (!password) return false; // absent env is a valid deployment, not a divergence
  const username = process.env.ADMIN_USERNAME ?? 'admin';
  const user = db
    .prepare('SELECT password_hash FROM users WHERE username = ?')
    .get(username) as { password_hash: string } | undefined;
  if (!user) return false; // no such user -> nothing to compare (seed handles empty)
  const matches = await bcrypt.compare(password, user.password_hash);
  if (!matches) {
    console.error(
      `[auth] CREDENTIAL DIVERGENCE: ADMIN_PASSWORD on disk does not match the users-table hash for '${username}'. ` +
      `Logins with the on-disk password WILL FAIL. This is detected, not repaired — the table value may be a ` +
      `deliberate change nobody recorded. If disk should win: set SYNC_ADMIN_PASSWORD=true and restart. ` +
      `If the table should win: update .env.local to match and this warning stops.`,
    );
    return true;
  }
  return false;
}
