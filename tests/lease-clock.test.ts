import { describe, expect, it } from 'vitest';
import {
  createLeaseClock,
  observeLease,
  validateLeaseTuple
} from '../src/lease-clock.js';
import type { ControlRecord } from '../src/run-ownership.js';

function control(overrides: Partial<ControlRecord> = {}): ControlRecord {
  return {
    schemaVersion: 1,
    runId: 'run-1',
    ownerTokenHash: 'a'.repeat(64),
    projectRoot: '/project',
    hostInstanceId: 'host-1',
    leaseIssuedMs: 1_000,
    leaseTtlMs: 1_000,
    leaseExpiresMs: 2_000,
    issuerRevision: 1,
    ...overrides
  };
}

describe('lease clock', () => {
  it('accepts exact replay and advances only one issuer revision at a time', () => {
    const clock = createLeaseClock(control(), 1_100);
    expect(observeLease(clock, control(), 1_200)).toEqual({ accepted: true, expired: false });
    expect(observeLease(clock, control({
      issuerRevision: 2,
      leaseIssuedMs: 1_500,
      leaseExpiresMs: 2_500
    }), 1_600)).toEqual({ accepted: true, expired: false });
    expect(observeLease(clock, control({
      issuerRevision: 4,
      leaseIssuedMs: 2_500,
      leaseExpiresMs: 3_500
    }), 2_600)).toEqual({ accepted: false, reason: 'issuer revision gap detected' });
  });

  it('rejects revision replay with tuple drift, regressions, and issuer identity drift', () => {
    const clock = createLeaseClock(control(), 1_100);
    expect(observeLease(clock, control({ leaseExpiresMs: 2_001 }), 1_200).accepted).toBe(false);
    expect(observeLease(clock, control({ issuerRevision: 0 }), 1_200).accepted).toBe(false);
    expect(observeLease(clock, control({
      issuerRevision: 2,
      leaseIssuedMs: 900,
      leaseExpiresMs: 1_900
    }), 1_200).accepted).toBe(false);
    expect(observeLease(clock, control({ ownerTokenHash: 'b'.repeat(64) }), 1_200)).toEqual({
      accepted: false,
      reason: 'issuer identity drift detected'
    });
  });

  it('keeps expiry sticky even when a later issuer revision extends the tuple', () => {
    const clock = createLeaseClock(control(), 2_000);
    expect(clock.observedExpired).toBe(true);
    const renewed = observeLease(clock, control({
      issuerRevision: 2,
      leaseIssuedMs: 2_000,
      leaseExpiresMs: 3_000
    }), 2_100);
    expect(renewed).toEqual({ accepted: true, expired: true });
    expect(clock.observedExpired).toBe(true);
  });

  it('rejects invalid lease tuples before they become a clock', () => {
    expect(() => validateLeaseTuple(control({ leaseExpiresMs: 2_001 }))).toThrow('invalid-control-lease');
    expect(() => validateLeaseTuple(control({ leaseTtlMs: 0 }))).toThrow('invalid-control-lease');
  });
});
