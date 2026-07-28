// Extend Vitest's expect with @testing-library/jest-dom matchers for React
// component tests under dashboard/src/**/__tests__/*.test.tsx. Loaded via
// the root vitest.config.ts `setupFiles`. Node-environment tests are
// unaffected — the matchers are namespaced under expect and only used
// when the test file imports them.
//
// The `/vitest` entry does BOTH halves in one import: it runs
// `expect.extend(...)` against vitest's expect (runtime — same as the old
// manual extend) AND augments vitest's `Assertion` type so `tsc --noEmit`
// sees toBeInTheDocument/toBeEmptyDOMElement/etc. The old
// `import * as matchers ... expect.extend(matchers)` form registered the
// matchers at runtime but left the TYPES un-augmented — 35 tsc errors in
// foundry-approval-summary.test.tsx that the runtime suite never surfaced.
// This file is under the dashboard tsconfig `include` (**/*.ts), so the
// augmentation reaches the whole compilation.
import '@testing-library/jest-dom/vitest';
