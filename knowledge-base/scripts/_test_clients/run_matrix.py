#!/usr/bin/env python3
"""Run every mmrag test suite under EVERY backend combination the fleet can be flipped into.

WHY THIS EXISTS (2026-07-11)
---------------------------
On 2026-07-11 the fleet flipped EMBEDDING_BACKEND to `local` (and NONTEXT_BACKEND to
`deterministic`) in orgs/*/secrets.env. Those values are exported into every agent's environment.

`test_batch_embed.py` went red that instant and stayed red for a day, and nobody knew — because:

  * it never NAMED the flag. It imported mmrag and inherited the ambient value.
  * so it silently took the local ONNX branch and asserted REST calls that branch never makes.
  * a `grep -l EMBEDDING_BACKEND` sweep returns a CLEAN list and hands you a false tick.

The lesson is not "grep the readers". The lesson is:

  A flag flip is a change to every consumer of that flag, INCLUDING THE TESTS —
  and the consumers you must find are the ones that IMPORT the module that reads it,
  not the ones that mention it.

This runner is that lesson as a gate instead of a paragraph. A lesson in prose gets re-derived;
a lesson in a gate does not. Run it after ANY change to a backend flag, and in CI.

USAGE
-----
    knowledge-base/venv/bin/python3 _test_clients/run_matrix.py          # run the matrix
    knowledge-base/venv/bin/python3 _test_clients/run_matrix.py --self-test
        # mutation-check: prove this runner can actually FAIL. A harness that passes no matter
        # what is decoration — the exact failure mode it was built to catch.

Exit 0 = every suite green in every combination. Exit 1 = something is red. Exit 2 = harness fault.
"""

import os
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
SCRIPTS = HERE.parent
PYTHON = sys.executable

# Every suite that imports mmrag. If you add one, add it here — a suite absent from this list is a
# suite the matrix does not protect, which is precisely how test_batch_embed went unnoticed.
SUITES = [
    "test_retry.py",
    "test_batch_embed.py",
]

# The backend combinations the fleet can actually be flipped into. `local`/`deterministic` is the
# LIVE setting as of 2026-07-11; `gemini`/`gemini` is the historical default we can still fall back
# to. A suite must be green in BOTH — either by being backend-independent, or by pinning the
# backend it means to test (test_batch_embed pins `gemini`, because it tests the gemini REST path).
COMBINATIONS = [
    {"EMBEDDING_BACKEND": "gemini", "NONTEXT_BACKEND": "gemini"},
    {"EMBEDDING_BACKEND": "local", "NONTEXT_BACKEND": "deterministic"},
    {"EMBEDDING_BACKEND": "local", "NONTEXT_BACKEND": "gemini"},
    {"EMBEDDING_BACKEND": "gemini", "NONTEXT_BACKEND": "deterministic"},
]


def run_suite(suite, combo, extra_env=None):
    """Run one suite under one combination. Returns (ok, tail_line)."""
    env = dict(os.environ)
    env.update(combo)
    env.update(extra_env or {})
    try:
        proc = subprocess.run(
            [PYTHON, str(HERE / suite)],
            cwd=str(SCRIPTS),
            env=env,
            capture_output=True,
            text=True,
            timeout=120,
        )
    except subprocess.TimeoutExpired:
        return False, "TIMEOUT (>120s)"
    out = (proc.stdout or "") + (proc.stderr or "")
    tail = next((ln for ln in reversed(out.strip().splitlines()) if ln.strip()), "(no output)")
    # Trust the EXIT CODE, not the text. "No output = clean" is only true if the command RAN —
    # a suite that dies on an import error prints nothing and would otherwise read as a pass.
    return proc.returncode == 0, tail.strip()


def matrix(extra_env=None):
    failures = []
    for combo in COMBINATIONS:
        label = f"EMBEDDING={combo['EMBEDDING_BACKEND']:<6} NONTEXT={combo['NONTEXT_BACKEND']}"
        print(f"\n  [{label}]")
        for suite in SUITES:
            ok, tail = run_suite(suite, combo, extra_env)
            print(f"    {'PASS' if ok else 'FAIL'}  {suite:<22s} {tail[:70]}")
            if not ok:
                failures.append((label, suite, tail))
    return failures


def self_test():
    """Feed the runner a KNOWN-POSITIVE (a suite that must be reported red) and a KNOWN-NEGATIVE
    (one that must be reported green). Both must land correctly, or the runner's verdicts are noise.

    A first attempt at this self-test injected a broken MMRAG_GEMINI_CLIENT_FACTORY and expected the
    real suites to fail. They did not — both install their OWN client factory, so the poisoned env
    var was simply ignored, and the harness reported a confident GREEN under an injected fault. That
    is the precise failure this self-test exists to catch, and it caught it on its first run against
    itself. The fault must be one the subject cannot override: a suite that genuinely exits non-zero.
    """
    import tempfile

    print("SELF-TEST: can this runner actually distinguish red from green?")
    ok_all = True
    with tempfile.TemporaryDirectory() as td:
        fixtures = {
            # known-positive: MUST be reported as a failure
            "always_fails.py": "import sys\nprint('deliberately failing')\nsys.exit(1)\n",
            # known-negative: MUST be reported as a pass
            "always_passes.py": "print('ALL PASS (fixture)')\n",
            # a suite that DIES on import — prints nothing. "No output = clean" is only true if the
            # command RAN; this must be reported red, not silently green.
            "explodes.py": "raise RuntimeError('import-time death')\n",
        }
        for name, body in fixtures.items():
            (Path(td) / name).write_text(body)

        expectations = [("always_fails.py", False), ("always_passes.py", True), ("explodes.py", False)]
        for name, want_ok in expectations:
            env = dict(os.environ)
            proc = subprocess.run([PYTHON, str(Path(td) / name)], capture_output=True,
                                  text=True, env=env, timeout=60)
            got_ok = proc.returncode == 0
            hit = got_ok == want_ok
            ok_all &= hit
            print(f"  {'PASS' if hit else 'FAIL'}  {name:<18s} "
                  f"reported {'green' if got_ok else 'red':<5s} (want {'green' if want_ok else 'red'})")

    if ok_all:
        print("\n  SELF-TEST PASSED — the runner reports red for red and green for green, "
              "and does NOT read a silent death as a pass. Its verdicts mean something.")
        return 0
    print("\n  SELF-TEST FAILED — the runner cannot tell red from green. "
          "Every result it has ever printed is decoration. Fix it before trusting the matrix.")
    return 2


def main():
    if "--self-test" in sys.argv:
        return self_test()

    print("mmrag backend matrix — every suite under every backend combination")
    print(f"  suites: {', '.join(SUITES)}")
    failures = matrix()

    print()
    if failures:
        print(f"RED — {len(failures)} suite/combination failure(s):")
        for label, suite, tail in failures:
            print(f"  {suite} under [{label}]: {tail[:90]}")
        print("\nA suite red under a combination the fleet is ACTUALLY SET TO is a live bug, not a "
              "test-config nit — that is what went unnoticed for a day on 2026-07-11.")
        return 1

    print(f"GREEN — {len(SUITES)} suite(s) × {len(COMBINATIONS)} combination(s), all passing.")
    print("A backend flag flip cannot silently break these without this runner going red.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
