import { beforeEach, afterEach, vi } from 'vitest';
import { resetFakeAdapterState } from '../src/adapters/testing.js';

// Determinism Invariant:
// - Reset global fake-adapter state beforeEach test, idempotently.
// - A test's own beforeEach always runs after this global setup and may set fakeAdapterState; its values win.
// - No test may rely on fake-adapter state leaking from a previous test.
beforeEach(() => {
  resetFakeAdapterState();
});

afterEach(() => {
  vi.restoreAllMocks();
});
