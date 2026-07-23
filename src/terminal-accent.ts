import chalk, { type ChalkInstance } from 'chalk';
import type { PanelContext } from './status.js';
import type { StepKind, StepStatus } from './state.js';

export interface RoleAccent {
  chalk: ChalkInstance;
  label: string;
}

export interface KindAccent {
  chalk: ChalkInstance;
  label: string;
}

export interface StatusAccent {
  chalk: ChalkInstance;
  label: string;
}

export type PanelBorderColor = 'cyan' | 'yellow' | 'green' | 'red' | 'blue';

const roleMap: Record<string, RoleAccent> = {
  auditor: { chalk: chalk.cyan, label: 'auditor' },
  planner: { chalk: chalk.yellow, label: 'planner' },
  reviewer: { chalk: chalk.magenta, label: 'reviewer' },
  implementer: { chalk: chalk.green, label: 'implementer' }
};

const defaultRoleAccent: RoleAccent = { chalk: chalk.gray, label: 'unknown' };

export function roleAccent(role: string): RoleAccent {
  return roleMap[role] ?? defaultRoleAccent;
}

const kindMap: Record<StepKind, KindAccent> = {
  audit: { chalk: chalk.cyan, label: 'audit' },
  'follow-up': { chalk: chalk.yellow, label: 'follow-up' },
  implement: { chalk: chalk.green, label: 'implement' },
  evaluate: { chalk: chalk.cyan, label: 'evaluate' },
  repair: { chalk: chalk.yellow, label: 'repair' },
  task: { chalk: chalk.green, label: 'task' },
};

export function kindAccent(kind: StepKind): KindAccent {
  return kindMap[kind];
}

const statusMap: Record<StepStatus, StatusAccent> = {
  running: { chalk: chalk.yellow, label: 'running' },
  failed: { chalk: chalk.red, label: 'failed' },
  done: { chalk: chalk.gray, label: 'done' },
  interrupted: { chalk: chalk.magenta, label: 'interrupted' }
};

export function statusAccent(status: StepStatus): StatusAccent {
  return statusMap[status];
}

export function panelBorderColor(ctx: PanelContext): PanelBorderColor {
  if (ctx.inFlight?.status === 'failed') {
    return 'red';
  }

  if (ctx.inFlight) {
    const map: Record<StepKind, PanelBorderColor> = {
      audit: 'cyan',
      'follow-up': 'yellow',
      implement: 'green',
      evaluate: 'cyan',
      repair: 'yellow',
      task: 'green',
    };
    return map[ctx.inFlight.kind];
  }

  const last = ctx.timeline[ctx.timeline.length - 1];
  if (last?.status === 'failed') {
    return 'red';
  }

  if (last) {
    const map: Record<StepKind, PanelBorderColor> = {
      audit: 'cyan',
      'follow-up': 'yellow',
      implement: 'green',
      evaluate: 'cyan',
      repair: 'yellow',
      task: 'green',
    };
    return map[last.kind] ?? 'blue';
  }

  return 'blue';
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

export type TextFormatter = (text: string) => string;

const identityFn: TextFormatter = (text: string) => text;

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

export function resultAccent(result: ResultState): TextFormatter {
  switch (result) {
    case 'accepted':
    case 'completed':
    case 'approved':
      return chalk.green;
    case 'retry':
    case 'failed':
    case 'rejected':
      return chalk.red;
    case 'blocked':
    case 'unknown':
    case 'interrupted':
      return chalk.yellow;
    case 'valid':
      return identityFn;
  }
}

export function availabilityAccent(availability: AvailabilityState): TextFormatter {
  switch (availability) {
    case 'available':
      return identityFn;
    case 'unavailable':
      return chalk.dim;
    case 'missing-inputs':
      return chalk.yellow;
  }
}

export function emphasisAccent(emphasis: EmphasisState): TextFormatter {
  switch (emphasis) {
    case 'identity':
      return chalk.bold.cyan;
    case 'binding-identity':
      return chalk.cyan;
    case 'supporting':
    case 'placeholder':
      return chalk.dim;
    case 'recommended':
      return chalk.green;
    case 'warning':
      return chalk.yellow;
  }
}

export function unclassifiedAccent(count: number): TextFormatter {
  return count > 0 ? chalk.yellow : chalk.dim;
}

export function staleAccent(isStale: boolean): TextFormatter {
  return isStale ? chalk.yellow : identityFn;
}

export type EventLevel = 'FAIL' | 'WARN' | 'PASS' | 'INFO';

export function eventLevelAccent(level: EventLevel): TextFormatter {
  switch (level) {
    case 'FAIL':
      return chalk.red;
    case 'WARN':
      return chalk.yellow;
    case 'PASS':
      return chalk.green;
    case 'INFO':
      return chalk.cyan;
  }
}
