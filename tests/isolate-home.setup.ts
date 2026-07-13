/**
 * Global test isolation: redirect HOME so no suite can touch the live estate.
 *
 * WHY (2026-07-13): resolvePaths() hardcodes join(homedir(), '.cortextos', …)
 * and ignores CTX_ROOT. Any test that exercises a CLI action or bus function
 * without mocking that module writes into the REAL ~/.cortextos — the
 * send-telegram normalize suite had been silently appending telegram_sent
 * events to the live analytics store on every run since 2026-05-14, and one
 * send-message test escape delivered a real (hostile-looking) message into
 * chief's live inbox mid-run. Per-suite mocks fix the suite that remembers;
 * this fixes the CLASS: os.homedir() on POSIX returns $HOME, so pointing
 * HOME at a per-worker temp dir makes the live estate unreachable by
 * construction for every current and future test in this config.
 *
 * A test that genuinely needs the real home directory (none should) must
 * opt out explicitly by restoring process.env.HOME from HOME_REAL.
 */
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

process.env.HOME_REAL = process.env.HOME;
const isolatedHome = mkdtempSync(join(tmpdir(), 'cortextos-vitest-home-'));
process.env.HOME = isolatedHome;
// Windows equivalent, for contributors running the suite there.
process.env.USERPROFILE = isolatedHome;
