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
2. `npm run build` — emits `dist/`. Run it *after* typecheck passes, not instead of it.
3. `npm test` — all tests must pass
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
