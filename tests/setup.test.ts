import { describe, it, expect, beforeEach } from 'vitest';
import { fakeAdapterState } from '../src/adapters/fake.js';

describe('Global Setup Reset', () => {
  describe('Cross-test reset proof', () => {
    it('sets state in the first test', () => {
      fakeAdapterState.verdicts = ['REJECTED'];
      fakeAdapterState.stdout = 'custom-stdout';
      fakeAdapterState.exitCode = 42;
      expect(fakeAdapterState.verdicts).toEqual(['REJECTED']);
    });

    it('proves the state was reset by the global setup before this test', () => {
      expect(fakeAdapterState.verdicts).toEqual([]);
      expect(fakeAdapterState.stdout).toBe('');
      expect(fakeAdapterState.exitCode).toBe(0);
    });
  });

  describe('Local override order proof', () => {
    beforeEach(() => {
      // Local beforeEach runs after the global beforeEach and overrides it.
      fakeAdapterState.verdicts = ['APPROVED'];
    });

    it('proves local beforeEach override wins', () => {
      expect(fakeAdapterState.verdicts).toEqual(['APPROVED']);
    });
  });
});
