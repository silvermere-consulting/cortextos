#!/usr/bin/env node
/**
 * BUILD GATE: refuse to build from a dirty src/ tree.
 *
 * WHY THIS EXISTS, and why it is a GATE and not a note in a runbook:
 * `tsup` compiles the WORKING TREE, not git HEAD. In this repo dist/ IS the live fleet
 * binary — every agent's `cortextos` call loads it. So a build from a dirty tree does not
 * merely produce a scratch artifact: it SHIPS uncommitted, unreviewed code to production.
 *
 * On 2026-07-12 the credential-screen release came within one command of doing exactly
 * that: 155 uncommitted lines across 8 files sat in src/, and the only thing standing
 * between them and the live binary was a human remembering to check. The rule existed.
 * It was written down. It had no executor.
 *
 * A rule with no enforcer is a caveat with better posture. This is the enforcer.
 *
 * NB: we check `git status --porcelain`, NOT `git diff --quiet`. `git diff` sees only
 * MODIFIED TRACKED files — it is blind to an UNTRACKED .ts in src/, which tsup will
 * compile happily the moment anything imports it. The dirty state we care about is
 * "anything in src/ that is not committed", and only --porcelain sees all of it.
 */
const { execSync } = require('child_process');

let dirty;
try {
  dirty = execSync('git status --porcelain -- src/', { encoding: 'utf-8' }).trim();
} catch (err) {
  // Fail CLOSED. If we cannot determine the tree state, we do not get to assume it is clean —
  // an unrunnable check must never be indistinguishable from a passing one.
  console.error('\n✗ REFUSING TO BUILD: could not determine git tree state.\n');
  console.error(String(err && err.message).slice(0, 300));
  process.exit(1);
}

if (dirty) {
  console.error('\n✗ REFUSING TO BUILD — src/ is dirty:\n');
  console.error(dirty.split('\n').map((l) => '    ' + l).join('\n'));
  console.error('\n  tsup compiles the WORKING TREE, and dist/ is the live fleet binary.');
  console.error('  Building now would SHIP these uncommitted changes to every agent.\n');
  console.error('  Commit them, stash them, or discard them — then build.\n');
  process.exit(1);
}

console.log('✓ clean-tree gate: src/ has no uncommitted changes — safe to build.');
