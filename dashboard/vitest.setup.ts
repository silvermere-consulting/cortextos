// Extend Vitest's expect with @testing-library/jest-dom matchers for React
// component tests under dashboard/src/**/__tests__/*.test.tsx. Loaded via
// the root vitest.config.ts `setupFiles`. Node-environment tests are
// unaffected — the matchers are namespaced under expect and only used
// when the test file imports them.
//
// TWO IMPORTS, TWO JOBS — do not collapse them (2026-07-29):
//   - `@testing-library/jest-dom/vitest` augments vitest's `Assertion` TYPE so
//     `tsc --noEmit` sees toBeInTheDocument/toBeEmptyDOMElement/etc (be21dbf,
//     which closed the 35-tsc-error dashboard typecheck gap).
//   - the explicit `expect.extend(matchers)` registers them at RUNTIME.
// The `/vitest` side-effect import was ASSUMED to do both, and its comment said
// so — but under vitest 4.1.2 it augmented the types and did NOT extend at
// runtime, so `foundry-approval-summary.test.tsx` failed all 11 with
// `Invalid Chai property: toBeInTheDocument` while `tsc` stayed green. The exact
// typecheck-green / runtime-red split. Keep the explicit extend until the
// side-effect import is verified to register at runtime in this vitest version.
import * as matchers from '@testing-library/jest-dom/matchers';
import { expect } from 'vitest';
import '@testing-library/jest-dom/vitest';

expect.extend(matchers);
