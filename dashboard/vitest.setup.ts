// Extend Vitest's expect with @testing-library/jest-dom matchers for React
// component tests under dashboard/src/**/__tests__/*.test.tsx. Loaded via
// the root vitest.config.ts `setupFiles`. Node-environment tests are
// unaffected — the matchers are namespaced under expect and only used
// when the test file imports them.
import * as matchers from '@testing-library/jest-dom/matchers';
import { expect } from 'vitest';

expect.extend(matchers);
