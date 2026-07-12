#!/usr/bin/env node
/**
 * TEST-COUNT FLOOR: fail if the unit suite has fewer tests than the committed floor.
 *
 * WHY THIS EXISTS (2026-07-12): a re-land carried a module's SOURCE but not its TESTS.
 * The pty suite went 92 -> 83 and every run was GREEN — the nine tests did not fail,
 * they VANISHED, and 83/83 reads exactly like 92/92 unless you are holding the number.
 * A suite that quietly drops tests has stopped protecting exactly what those tests
 * covered, and reports success the entire time. The check did not fail; it stopped asking.
 *
 * The general form (chief + analyst, same hour): a green is only worth its DENOMINATOR.
 * The test COUNT is the suite's denominator. So: assert the SIZE, not just the result.
 * A drop goes RED. A legitimate increase bumps the floor deliberately (that is the point —
 * lowering coverage is a decision someone makes on purpose, in a diff, not a silent side
 * effect of a rebase).
 *
 * Usage:  node scripts/assert-test-floor.cjs <vitest-json-file>
 *   `npm test` writes the json, then runs this. It is a POST-condition on the suite, not
 *   a second test run.
 */
const fs = require('fs');

// The floor. Bump it (in a commit, on purpose) when tests are legitimately added.
// It is a FLOOR, not a pin: >= passes, < fails. Never auto-updated — a silent bump would
// defeat the whole guard.
const FLOOR = 1120;

const jsonPath = process.argv[2];
if (!jsonPath) {
  console.error('✗ assert-test-floor: no vitest json file given');
  process.exit(1);
}

let report;
try {
  report = JSON.parse(fs.readFileSync(jsonPath, 'utf-8'));
} catch (err) {
  // Fail CLOSED: if we cannot read the count, we do not get to assume it is fine.
  console.error('✗ assert-test-floor: could not read/parse ' + jsonPath + ' — ' + err.message);
  process.exit(1);
}

const total = report.numTotalTests;
const passed = report.numPassedTests;

if (typeof total !== 'number') {
  console.error('✗ assert-test-floor: vitest json has no numTotalTests — cannot assert the count.');
  process.exit(1);
}

if (total < FLOOR) {
  console.error('');
  console.error(`✗ TEST-COUNT FLOOR BREACHED: ${total} tests, floor is ${FLOOR}.`);
  console.error(`  ${FLOOR - total} test(s) DISAPPEARED. They did not fail — they stopped being run.`);
  console.error('  A suite that shrinks silently reports a green about a smaller thing.');
  console.error('  If this drop is intentional (a module was genuinely removed), LOWER the FLOOR');
  console.error('  in scripts/assert-test-floor.cjs in the same commit — on purpose, in the diff.');
  console.error('');
  process.exit(1);
}

console.log(`✓ test-count floor: ${passed}/${total} tests (floor ${FLOOR}) — the suite did not shrink.`);
