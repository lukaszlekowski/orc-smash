import type { ControlRecord } from './run-ownership.js';

/**
 * The lease clock is deliberately small and pure. Filesystem polling and
 * ownership-loss cleanup live elsewhere; this module only decides whether a
 * control record is an admissible monotonic transition.
 */

export const LEASE_CLOCK_SCHEMA_ERROR = 'invalid-control-lease';

export interface LeaseClockState {
  readonly runId: string;
  readonly ownerTokenHash: string;
  readonly projectRoot: string;
  readonly hostInstanceId: string;
  lastIssuerRevision: number;
  lastLeaseIssuedMs: number;
  lastLeaseTtlMs: number;
  lastLeaseExpiresMs: number;
  observedExpired: boolean;
}

export type LeaseObservation =
  | { accepted: true; expired: boolean }
  | { accepted: false; reason: string };

function assertFiniteNonNegative(value: number, field: string): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${LEASE_CLOCK_SCHEMA_ERROR}: ${field} must be a finite non-negative number`);
  }
}

/** Validate the lease tuple without consulting wall-clock state. */
export function validateLeaseTuple(control: ControlRecord): void {
  assertFiniteNonNegative(control.leaseIssuedMs, 'leaseIssuedMs');
  if (!Number.isInteger(control.leaseTtlMs) || control.leaseTtlMs <= 0) {
    throw new Error(`${LEASE_CLOCK_SCHEMA_ERROR}: leaseTtlMs must be positive`);
  }
  assertFiniteNonNegative(control.leaseExpiresMs, 'leaseExpiresMs');
  assertFiniteNonNegative(control.issuerRevision, 'issuerRevision');

  if (control.leaseExpiresMs !== control.leaseIssuedMs + control.leaseTtlMs) {
    throw new Error(`${LEASE_CLOCK_SCHEMA_ERROR}: leaseExpiresMs must equal leaseIssuedMs + leaseTtlMs`);
  }
}

export function createLeaseClock(control: ControlRecord, now = Date.now()): LeaseClockState {
  validateLeaseTuple(control);
  return {
    runId: control.runId,
    ownerTokenHash: control.ownerTokenHash,
    projectRoot: control.projectRoot,
    hostInstanceId: control.hostInstanceId,
    lastIssuerRevision: control.issuerRevision,
    lastLeaseIssuedMs: control.leaseIssuedMs,
    lastLeaseTtlMs: control.leaseTtlMs,
    lastLeaseExpiresMs: control.leaseExpiresMs,
    observedExpired: now >= control.leaseExpiresMs
  };
}

function immutableFieldsMatch(state: LeaseClockState, control: ControlRecord): boolean {
  return (
    state.runId === control.runId &&
    state.ownerTokenHash === control.ownerTokenHash &&
    state.projectRoot === control.projectRoot &&
    state.hostInstanceId === control.hostInstanceId
  );
}

function tupleIsUnchanged(state: LeaseClockState, control: ControlRecord): boolean {
  return (
    state.lastLeaseIssuedMs === control.leaseIssuedMs &&
    state.lastLeaseTtlMs === control.leaseTtlMs &&
    state.lastLeaseExpiresMs === control.leaseExpiresMs
  );
}

/**
 * Observe one control record. Replaying a revision is allowed only when its
 * lease tuple is byte-for-byte equivalent; a revision gap, regression, issuer
 * identity drift, or a backward deadline is a fail-closed transition.
 */
export function observeLease(
  state: LeaseClockState,
  control: ControlRecord,
  now = Date.now()
): LeaseObservation {
  try {
    validateLeaseTuple(control);
  } catch (error) {
    return { accepted: false, reason: (error as Error).message };
  }

  if (!immutableFieldsMatch(state, control)) {
    return { accepted: false, reason: 'issuer identity drift detected' };
  }

  if (control.issuerRevision < state.lastIssuerRevision) {
    return { accepted: false, reason: 'issuer revision regressed' };
  }

  if (control.issuerRevision === state.lastIssuerRevision) {
    if (!tupleIsUnchanged(state, control)) {
      return { accepted: false, reason: 'lease tuple changed without an issuer revision' };
    }
  } else {
    if (control.issuerRevision !== state.lastIssuerRevision + 1) {
      return { accepted: false, reason: 'issuer revision gap detected' };
    }
    if (control.leaseIssuedMs < state.lastLeaseIssuedMs) {
      return { accepted: false, reason: 'lease issue time regressed' };
    }
    if (control.leaseExpiresMs < state.lastLeaseExpiresMs) {
      return { accepted: false, reason: 'lease deadline regressed' };
    }

    state.lastIssuerRevision = control.issuerRevision;
    state.lastLeaseIssuedMs = control.leaseIssuedMs;
    state.lastLeaseTtlMs = control.leaseTtlMs;
    state.lastLeaseExpiresMs = control.leaseExpiresMs;
  }

  if (state.observedExpired || now >= control.leaseExpiresMs) {
    state.observedExpired = true;
  }
  return { accepted: true, expired: state.observedExpired };
}

export function leaseExpired(state: LeaseClockState, now = Date.now()): boolean {
  if (state.observedExpired || now >= state.lastLeaseExpiresMs) {
    state.observedExpired = true;
    return true;
  }
  return false;
}

export function resetLeaseClockForTests(): void {
  // Kept as a named no-op extension point so tests do not need to reach into
  // module state. Lease state is now per OwnershipContext rather than global.
}
