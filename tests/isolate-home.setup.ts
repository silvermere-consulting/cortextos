/**
 * Global test isolation: point BOTH ctxRoot inputs at a temp dir so no suite
 * can touch the live estate.
 *
 * WHY (2026-07-13): a test that exercises a CLI action or bus function without
 * mocking path resolution writes into the REAL ~/.cortextos — the send-telegram
 * normalize suite had been silently appending telegram_sent events to the live
 * analytics store on every run since 2026-05-14, and one send-message test
 * escape delivered a real (hostile-looking) message into chief's live inbox
 * mid-run. Per-suite mocks fix the suite that remembers; this fixes the CLASS.
 *
 * TWO INSTRUMENTS, BOTH AIMED AT ISOLATION (2026-08-02): ctxRoot now resolves
 * through the shared resolveCtxRoot() as `process.env.CTX_ROOT || envFile ||
 * join(homedir(), '.cortextos', id)` (task_1785666893799). Historically this
 * file redirected only HOME, and that WORKED PRECISELY BECAUSE resolvePaths
 * ignored CTX_ROOT — a premise that fix removes. If we redirected HOME but left
 * CTX_ROOT pointing at the live estate (the vitest process inherits it from the
 * agent shell), resolvePaths would now honour CTX_ROOT and write to the REAL
 * store despite the HOME redirect — reintroducing the exact bug this file
 * exists to prevent. So we set CTX_ROOT to the isolated derived path as well:
 * whichever tier resolveCtxRoot takes, it stays inside the temp dir. Neither
 * redirect depends on the other being correct.
 *
 * A test that genuinely needs the real estate (none should) must opt out
 * explicitly by restoring process.env.HOME from HOME_REAL and clearing/repointing
 * process.env.CTX_ROOT.
 */
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

process.env.HOME_REAL = process.env.HOME;
process.env.CTX_ROOT_REAL = process.env.CTX_ROOT;
const isolatedHome = mkdtempSync(join(tmpdir(), 'cortextos-vitest-home-'));
process.env.HOME = isolatedHome;
// Windows equivalent, for contributors running the suite there.
process.env.USERPROFILE = isolatedHome;
// Repoint CTX_ROOT at the isolated home's derived location so the shared
// resolveCtxRoot() cannot escape to the live estate via the process-env tier.
process.env.CTX_ROOT = join(isolatedHome, '.cortextos', process.env.CTX_INSTANCE_ID || 'default');
