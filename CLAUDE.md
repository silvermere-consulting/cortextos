# Contributing to cortextOS

## Development Setup

```bash
git clone https://github.com/grandamenium/cortextos.git
cd cortextos
npm install
npm run build
npm test
```

## Before Submitting Changes

1. `npm run typecheck` — TypeScript must compile cleanly.
   **⚠️ `npm run build` does NOT typecheck.** It runs `tsup`, which strips types and emits without checking them — so **it prints "Build success" while `tsc` is still failing.** A green build is not a green typecheck: they are different instruments answering different questions, and only one of them is looking at your bug. *(This line previously told you to rely on `npm run build`. It was wrong, and it had been wrong for as long as anyone had been following it.)*

   **⚠️ AND A GREEN TYPECHECK IS NOT A GREEN RUNTIME — the next rung up, and it was found *inside* the commit that fixed the rung below.** On 2026-07-29, `be21dbf` (the commit that closed the dashboard typecheck coverage gap) switched `dashboard/vitest.setup.ts` to `import '@testing-library/jest-dom/vitest'`, on the assumption that one import both augmented the matcher **types** (so `tsc` sees `toBeInTheDocument`) **and** extended `expect` at **runtime** (so the tests actually run). Under vitest 4.1.2 it did the first and not the second: `tsc --noEmit` went **green** while all 11 tests in `foundry-approval-summary.test.tsx` died on `Invalid Chai property: toBeInTheDocument` — **and the green typecheck actively concealed it**, because a passing type-check on a test file reads as "this file is fine." The fix for "we cannot see type errors" manufactured "types pass, runtime fails." So: **`tsc` green means the types line up; it says nothing about whether the code runs.** Run the tests. Keep an explicit `expect.extend(matchers)` beside any `/vitest`-style side-effect import until that import is verified to register at runtime in the installed vitest version. (Caught only by validating the WHOLE tree in a reconcile — no per-change check touched it, because no change *to* it existed.)
2. `npm run build` — emits `dist/`. Run it *after* typecheck passes, not instead of it.
3. `npm test` — all tests must pass. A green typecheck does not stand in for this (see the be21dbf warning above): the runtime is a third instrument, and it is the only one that answers "does it run."
4. Match existing patterns in `src/` for new features
5. Add unit tests in `tests/` for any new code

## Project Structure

- `src/` — TypeScript source (bus, cli, daemon, hooks, types, utils)
- `bus/` — Shell wrapper scripts (delegate to `dist/cli.js bus`)
- `dashboard/` — Next.js 14 web dashboard
- `templates/` — Agent templates (agent, orchestrator, analyst)
- `community/` — Community skills and agent catalog
- `tests/` — Unit, integration, and E2E tests

## Code Style

- TypeScript strict mode
- No external runtime dependencies beyond what's in `package.json`
- File operations use atomic writes (see `src/utils/atomic.ts`)
- All bus operations go through `src/bus/` modules
