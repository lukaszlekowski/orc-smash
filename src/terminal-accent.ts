import type { PanelContext } from './status.js';
import type { StepKind, StepStatus } from './state.js';
import { resolveBorderColor, resolveStyle, type TextFormatter, type ThemeLocation } from './theme.js';

export interface RoleAccent {
  chalk: TextFormatter;
  label: string;
}

export interface KindAccent {
  chalk: TextFormatter;
  label: string;
}

export interface StatusAccent {
  chalk: TextFormatter;
  label: string;
}

export type PanelBorderColor = string;

const KNOWN_ROLES = new Set(['auditor', 'planner', 'reviewer', 'implementer']);

export function roleAccent(role: string, location: ThemeLocation = 'terminal-accent'): RoleAccent {
  const normalized = KNOWN_ROLES.has(role) ? role : 'unknown';
  return {
    chalk: resolveStyle(`role.${normalized}`, location),
    label: normalized,
  };
}

export function kindAccent(kind: StepKind, location: ThemeLocation = 'terminal-accent'): KindAccent {
  return {
    chalk: resolveStyle(`kind.${kind}`, location),
    label: kind,
  };
}

export function statusAccent(status: StepStatus, location: ThemeLocation = 'terminal-accent'): StatusAccent {
  return {
    chalk: resolveStyle(`status.${status}`, location),
    label: status,
  };
}

export function panelBorderColor(ctx: PanelContext, location: ThemeLocation = 'status-panel'): PanelBorderColor {
  return resolveBorderColor(ctx, location);
}

export type ResultState =
  | 'accepted'
  | 'approved'
  | 'completed'
  | 'retry'
  | 'rejected'
  | 'failed'
  | 'blocked'
  | 'unknown'
  | 'interrupted'
  | 'valid';

export type AvailabilityState =
  | 'available'
  | 'unavailable'
  | 'missing-inputs';

export type EmphasisState =
  | 'identity'
  | 'binding-identity'
  | 'supporting'
  | 'placeholder'
  | 'recommended'
  | 'warning';

export function toResultState(value?: string | null): ResultState {
  if (!value) return 'valid';
  const norm = value.trim().toLowerCase();
  switch (norm) {
    case 'accepted':
      return 'accepted';
    case 'approved':
      return 'approved';
    case 'completed':
      return 'completed';
    case 'retry':
      return 'retry';
    case 'rejected':
      return 'rejected';
    case 'failed':
      return 'failed';
    case 'blocked':
      return 'blocked';
    case 'interrupted':
      return 'interrupted';
    case 'valid':
      return 'valid';
    case 'unknown':
      return 'unknown';
    default:
      return 'unknown';
  }
}

const RESULT_TOKENS: Record<ResultState, 'pass' | 'fail' | 'warn' | 'neutral'> = {
  accepted: 'pass',
  approved: 'pass',
  completed: 'pass',
  retry: 'fail',
  failed: 'fail',
  rejected: 'fail',
  blocked: 'warn',
  unknown: 'warn',
  interrupted: 'warn',
  valid: 'neutral',
};

export function resultAccent(result: ResultState, location: ThemeLocation = 'terminal-accent'): TextFormatter {
  return resolveStyle(`result.${RESULT_TOKENS[result]}`, location);
}

export function availabilityAccent(availability: AvailabilityState, location: ThemeLocation = 'terminal-accent'): TextFormatter {
  return resolveStyle(`availability.${availability}`, location);
}

export function emphasisAccent(emphasis: EmphasisState, location: ThemeLocation = 'terminal-accent'): TextFormatter {
  return resolveStyle(`emphasis.${emphasis}`, location);
}

export function unclassifiedAccent(count: number, location: ThemeLocation = 'terminal-accent'): TextFormatter {
  return resolveStyle(`unclassified.${count > 0 ? 'attention' : 'idle'}`, location);
}

export function staleAccent(isStale: boolean, location: ThemeLocation = 'terminal-accent'): TextFormatter {
  return resolveStyle(`stale.${isStale ? 'stale' : 'fresh'}`, location);
}

export type EventLevel = 'FAIL' | 'WARN' | 'PASS' | 'INFO';

const EVENT_TOKENS: Record<EventLevel, 'fail' | 'warn' | 'pass' | 'info'> = {
  FAIL: 'fail',
  WARN: 'warn',
  PASS: 'pass',
  INFO: 'info',
};

export function eventLevelAccent(level: EventLevel, location: ThemeLocation = 'log'): TextFormatter {
  return resolveStyle(`log.${EVENT_TOKENS[level]}`, location);
}
